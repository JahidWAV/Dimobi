// api/stripe-webhook.js
// Déploiement : Vercel Serverless Function (Node.js, ESM).
// Reçoit les événements Stripe, vérifie la signature avec le corps brut,
// puis met à jour public.profiles et public.subscriptions via service_role.
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET
//   STRIPE_PRICE_WRITER_MONTHLY
//   STRIPE_PRICE_STUDIO_MONTHLY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// IMPORTANT : le bodyParser doit être désactivé pour cette route afin de
// pouvoir vérifier la signature Stripe sur le corps brut de la requête.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const PLAN_BY_PRICE = {
  [process.env.STRIPE_PRICE_WRITER_MONTHLY]: 'writer',
  [process.env.STRIPE_PRICE_STUDIO_MONTHLY]: 'studio',
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function planFromPriceId(priceId) {
  return PLAN_BY_PRICE[priceId] || null;
}

async function upsertSubscriptionRow(subscription, userId) {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  const plan = planFromPriceId(priceId);

  if (!plan) {
    console.error('stripe-webhook: unknown price id, cannot map to a plan:', priceId);
    return;
  }

  const { error: subError } = await supabaseAdmin
    .from('subscriptions')
    .upsert(
      {
        user_id: userId,
        stripe_subscription_id: subscription.id,
        stripe_price_id: priceId,
        status: subscription.status,
        plan,
        current_period_end: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000).toISOString()
          : null,
        cancel_at_period_end: !!subscription.cancel_at_period_end,
      },
      { onConflict: 'stripe_subscription_id' }
    );

  if (subError) {
    console.error('stripe-webhook: failed to upsert subscription row:', subError);
  }

  const activeStatuses = ['active', 'trialing', 'past_due'];
  const nextPlan = activeStatuses.includes(subscription.status) ? plan : 'free';

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({ plan: nextPlan })
    .eq('id', userId);

  if (profileError) {
    console.error('stripe-webhook: failed to update profile plan:', profileError);
  }
}

async function resolveUserId(subscription) {
  if (subscription.metadata?.supabase_user_id) {
    return subscription.metadata.supabase_user_id;
  }
  // Repli : retrouver l'utilisateur via le stripe_customer_id enregistré sur le profil.
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('stripe_customer_id', subscription.customer)
    .single();
  if (error || !data) {
    console.error('stripe-webhook: could not resolve user for customer', subscription.customer);
    return null;
  }
  return data.id;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }

  let event;

  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('stripe-webhook: signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature invalide: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode === 'subscription' && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          const userId =
            session.client_reference_id || (await resolveUserId(subscription));
          if (userId) await upsertSubscriptionRow(subscription, userId);
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const userId = await resolveUserId(subscription);
        if (userId) await upsertSubscriptionRow(subscription, userId);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const userId = await resolveUserId(subscription);
        if (userId) {
          await supabaseAdmin
            .from('subscriptions')
            .update({ status: 'canceled', cancel_at_period_end: false })
            .eq('stripe_subscription_id', subscription.id);
          await supabaseAdmin.from('profiles').update({ plan: 'free' }).eq('id', userId);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          const userId = await resolveUserId(subscription);
          if (userId) {
            await supabaseAdmin
              .from('subscriptions')
              .update({ status: subscription.status })
              .eq('stripe_subscription_id', subscription.id);
          }
        }
        break;
      }

      default:
        // Événement non géré : on l'ignore volontairement.
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('stripe-webhook: handler error:', err);
    return res.status(500).json({ error: 'Erreur interne lors du traitement du webhook.' });
  }
}
