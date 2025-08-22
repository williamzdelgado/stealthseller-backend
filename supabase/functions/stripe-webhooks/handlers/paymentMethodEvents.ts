// Handle subscription.created - sync initial payment method
export async function handleSubscriptionCreated(subscription, stripe, supabase) {
  console.log(`💳 Processing subscription.created for payment method sync: ${subscription.id}`);
  try {
    // Get the customer ID
    const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
    if (!customerId) {
      console.error('❌ No customer ID found in subscription');
      return;
    }
    // Get user_id from subscription metadata
    const userId = subscription.metadata?.user_id;
    if (!userId) {
      console.error('❌ No user_id found in subscription metadata');
      return;
    }
    // Get default payment method from customer
    const customer = await stripe.customers.retrieve(customerId);
    const defaultPaymentMethodId = customer.default_payment_method;
    if (!defaultPaymentMethodId) {
      console.log(`ℹ️ No default payment method for customer: ${customerId}`);
      return;
    }
    // Get payment method details
    const paymentMethodId = typeof defaultPaymentMethodId === 'string' ? defaultPaymentMethodId : defaultPaymentMethodId.id;
    const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
    await syncPaymentMethodToDatabase(paymentMethod, userId, supabase);
  } catch (error) {
    console.error('❌ Error handling subscription.created for payment method:', error.message);
  }
}
// Handle payment_method.attached - update when new methods added
export async function handlePaymentMethodAttached(paymentMethod, stripe, supabase) {
  console.log(`💳 Processing payment_method.attached: ${paymentMethod.id}`);
  try {
    // Get customer ID
    const customerId = typeof paymentMethod.customer === 'string' ? paymentMethod.customer : paymentMethod.customer?.id;
    if (!customerId) {
      console.error('❌ No customer ID found in payment method');
      return;
    }
    // Find user_id from customer in subscriptions table
    const { data: subscription } = await supabase.from('subscriptions').select('user_id').eq('stripe_customer_id', customerId).single();
    if (!subscription?.user_id) {
      console.error(`❌ No user found for customer: ${customerId}`);
      return;
    }
    // Check if this is the default payment method
    const customer = await stripe.customers.retrieve(customerId);
    const isDefault = customer.default_payment_method === paymentMethod.id;
    // MODIFIED: Sync ANY payment method, not just default ones (for testing)
    // This ensures payment methods show up in the UI regardless of default status
    await syncPaymentMethodToDatabase(paymentMethod, subscription.user_id, supabase);
    if (!isDefault) {
      console.log(`ℹ️ Non-default payment method synced: ${paymentMethod.id}`);
    }
  } catch (error) {
    console.error('❌ Error handling payment_method.attached:', error.message);
  }
}
// Handle payment_method.updated - portal changes
export async function handlePaymentMethodUpdated(paymentMethod, stripe, supabase) {
  console.log(`🔄 Processing payment_method.updated: ${paymentMethod.id}`);
  try {
    // Get customer ID
    const customerId = typeof paymentMethod.customer === 'string' ? paymentMethod.customer : paymentMethod.customer?.id;
    if (!customerId) {
      console.error('❌ No customer ID found in payment method');
      return;
    }
    // Find user_id from customer in subscriptions table
    const { data: subscription } = await supabase.from('subscriptions').select('user_id').eq('stripe_customer_id', customerId).single();
    if (!subscription?.user_id) {
      console.error(`❌ No user found for customer: ${customerId}`);
      return;
    }
    // Check if this is the default payment method
    const customer = await stripe.customers.retrieve(customerId);
    const isDefault = customer.default_payment_method === paymentMethod.id;
    // MODIFIED: Sync ANY payment method, not just default ones (for testing)
    // This ensures payment methods show up in the UI regardless of default status
    await syncPaymentMethodToDatabase(paymentMethod, subscription.user_id, supabase);
    if (!isDefault) {
      console.log(`ℹ️ Non-default payment method update synced: ${paymentMethod.id}`);
    }
  } catch (error) {
    console.error('❌ Error handling payment_method.updated:', error.message);
  }
}
// Sync payment method to database (upsert - one row per user)
export async function syncPaymentMethodToDatabase(paymentMethod, userId, supabase) {
  console.log(`💾 Syncing payment method to database for user: ${userId}`);
  try {
    // Extract card details (only for card payment methods)
    if (paymentMethod.type !== 'card' || !paymentMethod.card) {
      console.log(`ℹ️ Skipping non-card payment method: ${paymentMethod.type}`);
      return;
    }
    const card = paymentMethod.card;
    // Upsert payment method (replace existing for user)
    const { data, error } = await supabase.from('payment_methods').upsert({
      user_id: userId,
      stripe_payment_method_id: paymentMethod.id,
      type: paymentMethod.type,
      brand: card.brand,
      last4: card.last4,
      exp_month: card.exp_month,
      exp_year: card.exp_year,
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'user_id' // Replace existing row for this user
    });
    if (error) {
      console.error('❌ Error syncing payment method:', error);
    } else {
      console.log('✅ Payment method synced successfully');
    }
  } catch (error) {
    console.error('❌ Error in syncPaymentMethodToDatabase:', error.message);
  }
}
