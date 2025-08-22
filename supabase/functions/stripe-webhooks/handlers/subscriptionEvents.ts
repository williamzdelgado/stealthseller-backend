import { validPricePlans, validPlanTypes } from '../utils/stripeHelpers.ts';
export async function handleCheckoutSessionCompleted(session, stripe, supabase) {
  console.log(`Processing checkout session: ${session.id}`);
  // Only proceed if payment was successful
  if (session.payment_status !== 'paid') {
    console.log('Checkout completed but payment not paid yet:', session.id);
    return;
  }
  // Get user ID from client_reference_id
  const userId = session.client_reference_id;
  if (!userId) {
    console.error('❌ Missing user ID in checkout session client_reference_id');
    return;
  }
  console.log(`✅ Found user ID: ${userId}`);
  // Get customer and subscription IDs
  const customerId = session.customer;
  const subscriptionId = session.subscription;
  if (!customerId || !subscriptionId) {
    console.error('❌ Missing customer ID or subscription ID');
    return;
  }
  console.log(`✅ Customer: ${customerId}, Subscription: ${subscriptionId}`);
  // Get subscription details from Stripe
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  // Get price ID to determine plan type with secure validation
  const priceId = subscription.items.data[0]?.price.id;
  let planType = 'standard';
  if (priceId && validPricePlans[priceId]) {
    const mappedPlan = validPricePlans[priceId];
    if (validPlanTypes.includes(mappedPlan)) {
      planType = mappedPlan;
      console.log(`✅ Validated plan type: ${planType} for price ID: ${priceId}`);
    } else {
      console.warn(`⚠️ Invalid plan type mapping for price ID: ${priceId}`);
    }
  } else {
    console.warn(`⚠️ Unknown price ID: ${priceId}, defaulting to standard plan`);
  }
  console.log(`✅ Plan type determined: ${planType}`);
  // Format dates
  const trialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null;
  const currentPeriodEnd = subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null;
  // Create subscription record
  const { data: subData, error: subError } = await supabase.from('subscriptions').upsert({
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    status: subscription.status,
    plan_type: planType,
    trial_end: trialEnd,
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: subscription.cancel_at_period_end,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
  if (subError) {
    console.error('❌ Error creating subscription record:', subError);
  } else {
    console.log('✅ Subscription record created successfully');
  }
}
export async function handleSubscriptionUpdated(updatedSubscription, supabase) {
  console.log(`Processing subscription update: ${updatedSubscription.id}`);
  const { error: updateError } = await supabase.from('subscriptions').update({
    status: updatedSubscription.status,
    cancel_at_period_end: updatedSubscription.cancel_at_period_end,
    current_period_end: updatedSubscription.current_period_end ? new Date(updatedSubscription.current_period_end * 1000).toISOString() : null,
    updated_at: new Date().toISOString()
  }).eq('stripe_subscription_id', updatedSubscription.id);
  if (updateError) {
    console.error('❌ Error updating subscription:', updateError);
  } else {
    console.log('✅ Subscription updated successfully');
  }
}
export async function handleSubscriptionDeleted(deletedSubscription, supabase) {
  console.log(`Processing subscription deletion: ${deletedSubscription.id}`);
  const { error: deleteError } = await supabase.from('subscriptions').update({
    status: 'canceled',
    updated_at: new Date().toISOString()
  }).eq('stripe_subscription_id', deletedSubscription.id);
  if (deleteError) {
    console.error('❌ Error canceling subscription:', deleteError);
  } else {
    console.log('✅ Subscription canceled successfully');
  }
}
