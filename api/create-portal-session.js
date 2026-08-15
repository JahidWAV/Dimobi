import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
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
    const { data: profile, error } = await admin.from('profiles').select('stripe_customer_id').eq('id', user.id).single();
    if (error || !profile?.stripe_customer_id) return json(res, 400, { error: 'Aucun client Stripe associé.' });
    const session = await stripe.billingPortal.sessions.create({ customer: profile.stripe_customer_id, return_url: process.env.APP_URL });
    return json(res, 200, { url: session.url });
  } catch (error) {
    console.error('create-portal-session:', error);
    return json(res, 500, { error: 'Impossible d’ouvrir le portail de facturation.' });
  }
}
