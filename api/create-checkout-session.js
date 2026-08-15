import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const prices = { writer: process.env.STRIPE_PRICE_WRITER_MONTHLY, studio: process.env.STRIPE_PRICE_STUDIO_MONTHLY };

function json(res, status, body) { return res.status(status).json(body); }
async function userFrom(req) {
  const value = req.headers.authorization || '';
  if (!value.startsWith('Bearer ')) return null;
  const { data, error } = await admin.auth.getUser(value.slice(7));
  return error ? null : data.user;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'Méthode non autorisée.' });
  try {
    const user = await userFrom(req);
    if (!user) return json(res, 401, { error: 'Utilisateur non authentifié.' });
    const plan = req.body?.plan;
    const price = prices[plan];
    if (!price) return json(res, 400, { error: 'Offre invalide.' });

    const { data: profile, error: profileError } = await admin.from('profiles').select('stripe_customer_id').eq('id', user.id).single();
    if (profileError) return json(res, 500, { error: 'Profil introuvable.' });
    let customer = profile.stripe_customer_id;
    if (!customer) {
      const created = await stripe.customers.create({ email: user.email, metadata: { supabase_user_id: user.id } });
      customer = created.id;
      const { error } = await admin.from('profiles').update({ stripe_customer_id: customer }).eq('id', user.id);
      if (error) return json(res, 500, { error: 'Impossible d’enregistrer le client Stripe.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription', customer,
      line_items: [{ price, quantity: 1 }],
      ui_mode: 'embedded',
      return_url: `${process.env.APP_URL}/?checkout=complete&session_id={CHECKOUT_SESSION_ID}`,
      redirect_on_completion: 'if_required',
      client_reference_id: user.id,
      subscription_data: { metadata: { supabase_user_id: user.id, plan } },
      allow_promotion_codes: true
    });
    return json(res, 200, { clientSecret: session.client_secret });
  } catch (error) {
    console.error('create-checkout-session:', error);
    return json(res, 500, { error: 'Impossible de créer la session de paiement.' });
  }
}
