// api/create-portal-session.js
// Déploiement : Vercel Serverless Function (Node.js, ESM).
// Crée une session Stripe Customer Portal pour un client Stripe existant.
//
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY
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

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile?.stripe_customer_id) {
      return jsonError(res, 400, 'Aucun abonnement Stripe associé à ce compte.');
    }

    const appUrl = process.env.APP_URL;

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${appUrl}/`,
    });

    return res.status(200).json({ url: portalSession.url });
  } catch (err) {
    console.error('create-portal-session error:', err);
    return jsonError(res, 500, 'Erreur lors de l’ouverture du portail de facturation.');
  }
}
