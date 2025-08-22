// Follow this setup guide to integrate the Deno runtime and Stripe with your Supabase project:
// https://github.com/supabase/supabase/tree/main/examples/edge-functions/supabase/functions/stripe-webhooks

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@12.6.0?target=deno'

type StripeMode = 'test' | 'live';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight request
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
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

    // Extract the token (remove "Bearer " prefix if present)
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    
    // Parse the request body
    const { priceId, successUrl, cancelUrl, userId, userEmail, mode = 'live' } = await req.json();

    if (!priceId) {
      return new Response(
        JSON.stringify({ error: 'Price ID is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!successUrl || !cancelUrl) {
      return new Response(
        JSON.stringify({ error: 'Success and cancel URLs are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get the Stripe API key (generic name works for both test and production)
    const stripeKey = Deno.env.get('STRIPE_API_KEY');
      
    if (!stripeKey) {
      throw new Error('Missing STRIPE_API_KEY')
    }

    const stripe = new Stripe(stripeKey, {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    })

    // Create a Supabase client with the auth token
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    
    if (!supabaseUrl || !supabaseAnonKey) {
      return new Response(
        JSON.stringify({ error: 'Missing Supabase configuration' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    
    const supabaseClient = createClient(
      supabaseUrl,
      supabaseAnonKey,
      {
        global: {
          headers: { Authorization: authHeader },
        },
        auth: {
          persistSession: false
        }
      }
    )
    
    // ALWAYS validate against the session token - never trust frontend-provided user data
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Authentication failed', details: authError }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Use the authenticated user from the session token
    const authenticatedUserId = user.id;
    const authenticatedUserEmail = user.email;

    // Optional: Validate that provided userId matches session (if provided)
    if (userId && userId !== authenticatedUserId) {
      return new Response(
        JSON.stringify({ error: 'User ID mismatch - session validation failed' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Check if user already has a subscription and a Stripe customer ID
    const { data: existingSubscription, error: subscriptionError } = await supabaseClient
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', authenticatedUserId)
      .maybeSingle()
    
    if (subscriptionError) {
      return new Response(
        JSON.stringify({ error: 'Error fetching subscription data' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Get the existing customer ID - we'll keep this for reference but won't use it in checkout
    const existingCustomerId = existingSubscription?.stripe_customer_id;
    
    // Create the checkout session without customer ID
    const checkoutSession = await stripe.checkout.sessions.create({
      // No customer parameter - Stripe will create after payment
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      subscription_data: {
        metadata: {
          user_id: authenticatedUserId,
        },
        trial_period_days: 14, // Add 14-day free trial
      },
      customer_email: authenticatedUserEmail, // Let Stripe create customer after successful payment
      client_reference_id: authenticatedUserId, // To track the user
      allow_promotion_codes: true,
    })

    // Return only essential data to reduce payload size
    return new Response(
      JSON.stringify({ url: checkoutSession.url }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
}) 