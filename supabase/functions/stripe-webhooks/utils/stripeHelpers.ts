import Stripe from 'https://esm.sh/stripe@14?target=denonext';

// Cache environment variables at module level
const STRIPE_API_KEY = Deno.env.get('STRIPE_API_KEY');

// Initialize Stripe with crypto provider
export function createStripeClient() {
  if (!STRIPE_API_KEY) {
    throw new Error('Missing STRIPE_API_KEY environment variable');
  }
  const stripe = new Stripe(STRIPE_API_KEY, {
    apiVersion: '2022-08-01'
  });
  return stripe;
}
// This is needed in order to use the Web Crypto API in Deno.
export const cryptoProvider = Stripe.createSubtleCryptoProvider();
// CORS headers for webhook responses
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
// Import price mapping from shared source (auto-generated from frontend price IDs)
export { 
  PRICE_TO_PLAN_MAPPING as validPricePlans,
  VALID_PLAN_TYPES as validPlanTypes 
} from '../../../../src/shared/stripePrices.ts';
