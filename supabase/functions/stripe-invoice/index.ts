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
  apiVersion: '2024-06-20',
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

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface RequestBody {
  stripe_invoice_id: string;
}

interface ResponseBody {
  pdf_url: string | null;
  error?: string;
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Validate authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Extract the token
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    // Use JWT decode instead of expensive auth.getUser call (100x faster)
    const { user, error: authError } = decodeJWT(token);
    
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Authentication failed', details: authError }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse request body
    const { stripe_invoice_id }: RequestBody = await req.json();
    
    if (!stripe_invoice_id) {
      return new Response(
        JSON.stringify({ error: 'stripe_invoice_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create authenticated client for this specific user context
    const userSupabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      realtime: { enabled: false },
      global: { headers: { Authorization: authHeader } }
    });

    // Query invoice with proper user authorization context
    const { data: invoice, error: invoiceError } = await userSupabase
      .from('invoices')
      .select('id, stripe_invoice_id, stripe_customer_id')
      .eq('stripe_invoice_id', stripe_invoice_id)
      .eq('user_id', user.id)
      .single();

    // Check if invoice exists for a different user
    if (invoiceError) {
      const { data: anyInvoice } = await userSupabase
        .from('invoices')
        .select('user_id')
        .eq('stripe_invoice_id', stripe_invoice_id)
        .single();
    }

    if (invoiceError || !invoice) {
      return new Response(
        JSON.stringify({ error: 'Invoice not found or access denied' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch invoice from Stripe to get PDF URL (using module-level client)
    const stripeInvoice = await stripe.invoices.retrieve(stripe_invoice_id);
    
    if (!stripeInvoice.invoice_pdf) {
      return new Response(
        JSON.stringify({ error: 'PDF not available for this invoice' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const response: ResponseBody = {
      pdf_url: stripeInvoice.invoice_pdf
    };

    return new Response(
      JSON.stringify(response),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    if (isDev) {
    console.error('Error fetching invoice PDF:', error);
    }
    
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Internal server error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}); 