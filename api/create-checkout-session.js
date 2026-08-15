// api/create-checkout-session.js
// Déploiement : Vercel Serverless Function (Node.js, ESM).
// Crée une session Stripe Checkout en mode "subscription" pour l'utilisateur
// Supabase authentifié (JWT Bearer envoyé par le frontend).
//
// Variables d'environnement requises (Vercel → Project Settings → Environment Variables) :
//   STRIPE_SECRET_KEY
//   STRIPE_PRICE_WRITER_MONTHLY
//   STRIPE_PRICE_STUDIO_MONTHLY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   APP_URL

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Mapping plan -> Price ID Stripe. Ne jamais faire confiance à un priceId
// envoyé par le client : on ne mappe que depuis un nom de plan connu.
const PRICE_BY_PLAN = {
  writer: process.env.STRIPE_PRICE_WRITER_MONTHLY,
  studio: process.env.STRIPE_PRICE_STUDIO_MONTHLY,
};

function jsonError(res, status, message) {
  res.status(status).json({ error: message });
}

async function getUserFromRequest(req) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return jsonError(res, 405, 'Méthode non autorisée.');
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return jsonError(res, 401, 'Utilisateur non authentifié.');
    }

    const { plan } = req.body || {};
    const priceId = PRICE_BY_PLAN[plan];
    if (!priceId) {
      return jsonError(res, 400, 'Offre invalide. Attendu : "writer" ou "studio".');
    }

    // Récupère ou crée le profil / stripe_customer_id.
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('id, stripe_customer_id')
      .eq('id', user.id)
      .single();

    if (profileError) {
      return jsonError(res, 500, 'Impossible de charger le profil utilisateur.');
    }

    let customerId = profile?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;

      const { error: updateError } = await supabaseAdmin
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', user.id);

      if (updateError) {
        return jsonError(res, 500, 'Impossible d’enregistrer le client Stripe.');
      }
    }

    const appUrl = process.env.APP_URL;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/?checkout=success`,
      cancel_url: `${appUrl}/?checkout=cancelled`,
      client_reference_id: user.id,
      subscription_data: {
        metadata: { supabase_user_id: user.id, plan },
      },
      allow_promotion_codes: true,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return jsonError(res, 500, 'Erreur lors de la création de la session de paiement.');
  }
}
