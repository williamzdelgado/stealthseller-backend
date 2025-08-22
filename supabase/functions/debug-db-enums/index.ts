import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
    // Use service role key to bypass auth for debugging
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    )

    // Last resort - just try to create a subscription with each possible value
    const testValues = ['basic', 'starter', 'standard', 'pro', 'max', 'ultra', 'enterprise']
    const results = {}
    
    for (const value of testValues) {
      // Create a unique test user ID for each test
      const testUserId = 'test-user-' + Math.random().toString(36).substring(2, 9)
      
      const { error: testError } = await supabaseClient
        .from('subscriptions')
        .insert({
          user_id: testUserId,
          stripe_customer_id: 'test-customer-' + testUserId,
          status: 'incomplete',
          plan_type: value
        })
      
      // Store the result (true = succeeded, false = failed)
      results[value] = {
        success: !testError,
        error: testError ? testError.message : null
      }
      
      // Clean up if we were successful
      if (!testError) {
        await supabaseClient
          .from('subscriptions')
          .delete()
          .eq('user_id', testUserId)
      }
    }
    
    return new Response(
      JSON.stringify({ message: 'Testing enum values directly', results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
}) 