import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const plans = { [process.env.STRIPE_PRICE_WRITER_MONTHLY]: 'writer', [process.env.STRIPE_PRICE_STUDIO_MONTHLY]: 'studio' };
function rawBody(req) { return new Promise((resolve, reject) => { const chunks=[]; req.on('data', c=>chunks.push(c)); req.on('end',()=>resolve(Buffer.concat(chunks))); req.on('error',reject); }); }
async function resolveUser(subscription) {
  if (subscription.metadata?.supabase_user_id) return subscription.metadata.supabase_user_id;
  const { data } = await admin.from('profiles').select('id').eq('stripe_customer_id', subscription.customer).maybeSingle();
  return data?.id || null;
}
async function syncSubscription(subscription, userId) {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const plan = plans[priceId];
  if (!plan || !userId) return;
  const active = ['active','trialing','past_due'].includes(subscription.status);
  await admin.from('subscriptions').upsert({ user_id:userId, stripe_subscription_id:subscription.id, stripe_price_id:priceId, status:subscription.status, plan, current_period_end:subscription.current_period_end ? new Date(subscription.current_period_end*1000).toISOString() : null, cancel_at_period_end:!!subscription.cancel_at_period_end }, { onConflict:'stripe_subscription_id' });
  await admin.from('profiles').update({ plan:active?plan:'free' }).eq('id',userId);
}
export default async function handler(req,res) {
  if(req.method!=='POST') return res.status(405).json({error:'Méthode non autorisée.'});
  let event;
  try { event=stripe.webhooks.constructEvent(await rawBody(req), req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); } catch(e) { return res.status(400).json({error:'Signature webhook invalide.'}); }
  try {
    if(event.type==='checkout.session.completed') { const session=event.data.object; if(session.subscription) { const sub=await stripe.subscriptions.retrieve(session.subscription); await syncSubscription(sub, session.client_reference_id || sub.metadata?.supabase_user_id); } }
    if(['customer.subscription.created','customer.subscription.updated'].includes(event.type)) { const sub=event.data.object; await syncSubscription(sub, await resolveUser(sub)); }
    if(event.type==='customer.subscription.deleted') { const sub=event.data.object; const user=await resolveUser(sub); if(user) { await admin.from('subscriptions').update({status:'canceled'}).eq('stripe_subscription_id',sub.id); await admin.from('profiles').update({plan:'free'}).eq('id',user); } }
    if(event.type==='invoice.payment_failed') { const invoice=event.data.object; if(invoice.subscription){const sub=await stripe.subscriptions.retrieve(invoice.subscription);await syncSubscription(sub,await resolveUser(sub));} }
    return res.status(200).json({received:true});
  } catch(e) { console.error('stripe-webhook:',e); return res.status(500).json({error:'Erreur webhook.'}); }
}
