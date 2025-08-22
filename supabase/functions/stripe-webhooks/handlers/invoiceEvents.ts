export async function handleInvoiceFinalized(invoice, supabase) {
  console.log(`💾 Processing invoice.finalized: ${invoice.id}`);
  try {
    // Get customer ID
    const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    if (!customerId) {
      console.error('❌ No customer ID found in invoice');
      return;
    }
    // Find user_id from customer in subscriptions table
    const { data: subscription } = await supabase.from('subscriptions').select('user_id').eq('stripe_customer_id', customerId).single();
    if (!subscription?.user_id) {
      console.error(`❌ No user found for customer: ${customerId}`);
      return;
    }
    console.log(`✅ Found user: ${subscription.user_id} for customer: ${customerId}`);
    // Format dates
    const invoiceDate = invoice.created ? new Date(invoice.created * 1000).toISOString() : new Date().toISOString();
    const dueDate = invoice.due_date ? new Date(invoice.due_date * 1000).toISOString() : null;
    const paidAt = invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000).toISOString() : null;
    // Insert invoice record with conflict handling
    const { data, error } = await supabase.from('invoices').upsert({
      user_id: subscription.user_id,
      stripe_customer_id: customerId,
      stripe_invoice_id: invoice.id,
      stripe_subscription_id: invoice.subscription || null,
      amount_due: invoice.amount_due || 0,
      amount_paid: invoice.amount_paid || 0,
      currency: invoice.currency || 'usd',
      status: invoice.status || 'draft',
      invoice_number: invoice.number || null,
      invoice_date: invoiceDate,
      due_date: dueDate,
      paid_at: paidAt,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'stripe_invoice_id' // Handle duplicates
    });
    if (error) {
      console.error('❌ Error inserting invoice record:', error);
    } else {
      console.log(`✅ Invoice record saved: ${invoice.id}`);
      console.log(`   Amount: ${invoice.amount_due} ${invoice.currency}, Status: ${invoice.status}`);
    }
  } catch (error) {
    console.error('❌ Error in handleInvoiceFinalized:', error.message);
  }
}
export async function handleInvoiceUpdated(invoice, supabase) {
  console.log(`🔄 Processing invoice.updated: ${invoice.id}`);
  try {
    // Format dates
    const dueDate = invoice.due_date ? new Date(invoice.due_date * 1000).toISOString() : null;
    const paidAt = invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000).toISOString() : null;
    // Update existing invoice record
    const { data, error } = await supabase.from('invoices').update({
      amount_due: invoice.amount_due || 0,
      amount_paid: invoice.amount_paid || 0,
      status: invoice.status || 'draft',
      due_date: dueDate,
      paid_at: paidAt,
      updated_at: new Date().toISOString()
    }).eq('stripe_invoice_id', invoice.id);
    if (error) {
      console.error('❌ Error updating invoice record:', error);
    } else {
      console.log(`✅ Invoice updated: ${invoice.id}`);
      console.log(`   Status: ${invoice.status}, Paid: ${invoice.amount_paid}/${invoice.amount_due}`);
    }
  } catch (error) {
    console.error('❌ Error in handleInvoiceUpdated:', error.message);
  }
}
