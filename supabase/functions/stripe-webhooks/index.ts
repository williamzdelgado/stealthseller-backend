// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.
import { createStripeClient, cryptoProvider, corsHeaders } from './utils/stripeHelpers.ts';
import { createSupabaseClient } from './utils/supabaseClient.ts';
import { handleCheckoutSessionCompleted, handleSubscriptionUpdated, handleSubscriptionDeleted } from './handlers/subscriptionEvents.ts';
import { handleSubscriptionCreated, handlePaymentMethodAttached, handlePaymentMethodUpdated } from './handlers/paymentMethodEvents.ts';
import { handleInvoiceFinalized, handleInvoiceUpdated } from './handlers/invoiceEvents.ts';

// Cache environment variables at module level
const WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SIGNING_SECRET');

// Initialize clients at module level for instant reuse
const stripe = createStripeClient();
const supabase = createSupabaseClient();

console.log('Hello from Stripe Webhook!');
Deno.serve(async (request)=>{
  // Handle CORS preflight request
  if (request.method === 'OPTIONS') {
    return new Response('ok', {
      headers: corsHeaders
    });
  }
  try {
    // Use cached environment variables (already available from module-level clients)
    const stripeApiKey = 'present'; // Cached in stripe client
    const webhookSecret = WEBHOOK_SECRET;
    const supabaseUrl = 'present'; // Cached in supabase client  
    const supabaseServiceKey = 'present'; // Cached in supabase client
    // Conditional logging for performance
    if (Deno.env.get('DENO_ENV') !== 'production') {
      console.log(`🔐 Environment check:`);
      console.log(`- Stripe API Key: ${stripeApiKey ? '✅ Present' : '❌ Missing'}`);
      console.log(`- Webhook Secret: ${webhookSecret ? '✅ Present' : '❌ Missing'}`);
      console.log(`- Supabase URL: ${supabaseUrl ? '✅ Present' : '❌ Missing'}`);
      console.log(`- Supabase Service Key: ${supabaseServiceKey ? '✅ Present' : '❌ Missing'}`);
    }
    // Validate required environment variables
    if (!stripeApiKey || !webhookSecret || !supabaseUrl || !supabaseServiceKey) {
      const missing = [];
      if (!stripeApiKey) missing.push('STRIPE_API_KEY');
      if (!webhookSecret) missing.push('STRIPE_WEBHOOK_SIGNING_SECRET');
      if (!supabaseUrl) missing.push('SUPABASE_URL');
      if (!supabaseServiceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
      console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
      return new Response(JSON.stringify({
        error: `Missing required environment variables: ${missing.join(', ')}`
      }), {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // Get Stripe signature from headers
    const signature = request.headers.get('Stripe-Signature');
    console.log(`🔍 Stripe signature header: ${signature ? 'Present' : 'Missing'}`);
    if (!signature) {
      console.error('❌ Missing Stripe signature header');
      return new Response(JSON.stringify({
        error: 'Missing Stripe signature'
      }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      });
    }
    // First step is to verify the event. The .text() method must be used as the
    // verification relies on the raw request body rather than the parsed JSON.
    const body = await request.text();
    console.log(`📥 Received webhook request. Body length: ${body.length}`);
    console.log(`🔑 Using webhook secret starting with: ${webhookSecret.substring(0, 10)}...`);
    // Verify signature using module-level Stripe client
    let receivedEvent;
    try {
      console.log(`🔐 Attempting signature verification with async method...`);
      receivedEvent = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret, undefined, cryptoProvider);
      console.log(`✅ Webhook signature verified successfully. Event: ${receivedEvent.id}, Type: ${receivedEvent.type}`);
    } catch (err) {
      console.error('❌ Webhook signature verification failed:', err.message);
      console.error('🔍 Error details:', {
        errorType: err.constructor.name,
        message: err.message,
        bodyLength: body.length,
        signaturePresent: !!signature,
        secretPresent: !!webhookSecret
      });
      return new Response(err.message, {
        status: 400,
        headers: corsHeaders
      });
    }
    // Acknowledge immediately for faster response
    const response = new Response(JSON.stringify({
      ok: true
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
    
    // Process the webhook event with modular handlers (async, no await)
    console.log(`🔔 Event received: ${receivedEvent.id} - Processing ${receivedEvent.type}`);
    switch(receivedEvent.type){
      case 'checkout.session.completed':
        const session = receivedEvent.data.object;
        handleCheckoutSessionCompleted(session, stripe, supabase);
        break;
      case 'customer.subscription.updated':
        const updatedSubscription = receivedEvent.data.object;
        handleSubscriptionUpdated(updatedSubscription, supabase);
        break;
      case 'customer.subscription.deleted':
        const deletedSubscription = receivedEvent.data.object;
        handleSubscriptionDeleted(deletedSubscription, supabase);
        break;
      case 'customer.subscription.created':
        const newSubscription = receivedEvent.data.object;
        handleSubscriptionCreated(newSubscription, stripe, supabase);
        break;
      case 'payment_method.attached':
        const paymentMethod = receivedEvent.data.object;
        handlePaymentMethodAttached(paymentMethod, stripe, supabase);
        break;
      case 'payment_method.updated':
        const updatedPaymentMethod = receivedEvent.data.object;
        handlePaymentMethodUpdated(updatedPaymentMethod, stripe, supabase);
        break;
      case 'invoice.finalized':
        const finalizedInvoice = receivedEvent.data.object;
        handleInvoiceFinalized(finalizedInvoice, supabase);
        break;
      case 'invoice.updated':
        const updatedInvoice = receivedEvent.data.object;
        handleInvoiceUpdated(updatedInvoice, supabase);
        break;
      default:
        console.log(`Unhandled event type: ${receivedEvent.type}`);
    }
    
    console.log(`✅ Webhook acknowledged immediately: ${receivedEvent.type}`);
    return response;
  } catch (error) {
    console.error('❌ Webhook error:', error);
    return new Response(JSON.stringify({
      error: error.message
    }), {
      status: 400,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    });
  }
});
