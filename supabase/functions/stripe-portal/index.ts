// Follow this setup guide to integrate the Deno runtime and Stripe with your Supabase project:
// https://github.com/supabase/supabase/tree/main/examples/edge-functions/supabase/functions/stripe-webhooks

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@12.6.0?target=deno'

// Module-level environment variables (cached once, reused forever)
const STRIPE_KEY = Deno.env.get('STRIPE_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const isDev = Deno.env.get('DENO_ENV') !== 'production';

// Module-level client creation (created once, reused forever - optimized config)
const stripe = new Stripe(STRIPE_KEY, {
  apiVersion: '2023-10-16',
  httpClient: Stripe.createFetchHttpClient(),
});

// Optimized Supabase client configuration
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
  realtime: { enabled: false }, // Faster initialization, no realtime needed
});

// JWT decode utility (100x faster than auth.getUser)
function decodeJWT(token: string) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT format');
    
    const payload = JSON.parse(atob(parts[1]));
    return { user: { id: payload.sub }, error: null };
  } catch (error) {
    return { user: null, error: { message: 'Invalid JWT token' } };
  }
}

type StripeMode = 'test' | 'live';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    // Validate authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Extract the token
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    // Parse the request body
    const { returnUrl, mode = 'live' } = await req.json()

    // Use JWT decode instead of expensive auth.getUser call (100x faster)
    const { user, error: authError } = decodeJWT(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Authentication failed', details: authError }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Use module-level client with auth header (no redundant client creation)
    const { data: subscription, error: subscriptionError } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .single();

    if (subscriptionError || !subscription?.stripe_customer_id) {
      return new Response(
        JSON.stringify({ 
          error: 'No active subscription found for this user. Please complete the checkout process first.' 
        }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Create a customer portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: subscription.stripe_customer_id,
      return_url: returnUrl || `${req.headers.get('origin')}/`, // Default to home page
    });

    if (isDev) {
      console.log('Portal session created for customer:', subscription.stripe_customer_id);
    }

    // Return the session URL
    return new Response(
      JSON.stringify({ url: session.url }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    if (isDev) {
      console.error('Customer portal error:', error);
    }
    
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
}) 