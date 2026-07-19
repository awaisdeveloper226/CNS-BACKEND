const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const User = require('../models/User');
const { sendOTPEmail, sendInvoiceEmail } = require('../utils/emailService');

// @desc    Get the live per-driver price from Stripe (source of truth)
// @route   GET /api/payments/price-info
// @access  Public
const getPriceInfo = asyncHandler(async (req, res) => {
  const price = await stripe.prices.retrieve(process.env.STRIPE_PRICE_ID_MONTHLY);

  if (!price || !price.active) {
    res.status(500);
    throw new Error('Pricing is currently unavailable');
  }

  res.status(200).json({
    unitAmount: price.unit_amount,
    unitAmountDecimal: price.unit_amount / 100,
    currency: price.currency,
    interval: price.recurring?.interval || 'month',
  });
});

// @desc    Create Stripe Checkout session for a new company signup
// @route   POST /api/payments/create-checkout-session
// @access  Public
const createCheckoutSession = asyncHandler(async (req, res) => {
  const { companyName, companyEmail, driverCount, platform } = req.body;

  if (!companyName || !companyEmail || !driverCount) {
    res.status(400);
    throw new Error('Company name, email, and driver count are required');
  }

  const normalizedEmail = companyEmail.toLowerCase().trim();

  const existing = await User.findOne({ email: normalizedEmail });
  if (existing && ['active', 'past_due', 'trialing'].includes(existing.subscriptionStatus)) {
    res.status(409);
    throw new Error('An account already exists for this email. Please sign in instead.');
  }

  // ── NEW: create (or reuse) a real Stripe Customer with the company name.
  // This is what makes "Customer business name" appear on the official Stripe invoice.
  // Without this, Checkout only has an email and Stripe has nothing to put in that field.
  let customer;
  const existingCustomers = await stripe.customers.list({ email: normalizedEmail, limit: 1 });

  if (existingCustomers.data.length > 0) {
    customer = await stripe.customers.update(existingCustomers.data[0].id, {
      name: companyName,
    });
  } else {
    customer = await stripe.customers.create({
      name: companyName,
      email: normalizedEmail,
    });
  }

  const isWeb = platform === 'web';
  const successUrl = isWeb
    ? process.env.WEBSITE_CHECKOUT_SUCCESS_URL
    : `${process.env.CHECKOUT_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = isWeb
    ? process.env.WEBSITE_CHECKOUT_CANCEL_URL
    : process.env.CHECKOUT_CANCEL_URL;

  // ── NEW: tax_rates on the line item is what makes GST show up on the invoice.
  // Create a Tax Rate in the Stripe Dashboard (Product catalog → Tax rates) and
  // put its ID in STRIPE_GST_TAX_RATE_ID. Leave the env var empty to skip tax entirely.
  const lineItem = {
    price: process.env.STRIPE_PRICE_ID_MONTHLY,
    quantity: driverCount,
  };
  if (process.env.STRIPE_GST_TAX_RATE_ID) {
    lineItem.tax_rates = [process.env.STRIPE_GST_TAX_RATE_ID];
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer: customer.id, // ← was customer_email before
    line_items: [lineItem],
    metadata: {
      companyName,
      companyEmail: normalizedEmail,
      driverCount: String(driverCount),
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  res.status(200).json({ url: session.url });
});

// @desc    Update driver count → updates Stripe subscription quantity + prorates
// @route   PATCH /api/payments/update-driver-count
// @access  Private (company admin)
const updateDriverCount = asyncHandler(async (req, res) => {
  const { driverCount } = req.body;

  if (!driverCount || driverCount <= 0) {
    res.status(400);
    throw new Error('A valid driver count is required');
  }

  const user = await User.findById(req.user._id).select(
    '+stripeSubscriptionId +stripeCustomerId'
  );

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  if (!user.isCompanyAdmin) {
    res.status(403);
    throw new Error('Only the company admin can update the driver count');
  }

  if (!user.stripeSubscriptionId) {
    res.status(400);
    throw new Error('No active subscription found for this account');
  }

  const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
  const itemId = subscription.items.data[0].id;

  await stripe.subscriptionItems.update(itemId, {
    quantity: driverCount,
    proration_behavior: 'create_prorations',
  });

  user.driverCount = driverCount;
  await user.save();

  res.status(200).json({ message: 'Driver count updated', driverCount });
});

// @desc    Stripe webhook
// @route   POST /api/payments/webhook
// @access  Public (verified via Stripe signature)
const handleStripeWebhook = asyncHandler(async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const email = (session.metadata?.companyEmail || session.customer_email || '')
        .toLowerCase()
        .trim();
      const companyName = session.metadata?.companyName || '';
      const driverCount = Number(session.metadata?.driverCount) || 0;

      if (!email) {
        console.error('❌ Checkout completed but no email on session', session.id);
        break;
      }

      let user = await User.findOne({ email });
      const isNewUser = !user;
      const randomPassword = crypto.randomBytes(20).toString('hex');

      if (isNewUser) {
        user = await User.create({
          name: companyName,
          email,
          password: randomPassword,
          companyName,
          driverCount,
          isCompanyAdmin: true,
          subscriptionStatus: 'active',
          stripeCustomerId: session.customer,
          stripeSubscriptionId: session.subscription,
        });
      } else {
        user.companyName = companyName;
        user.driverCount = driverCount;
        user.subscriptionStatus = 'active';
        user.stripeCustomerId = session.customer;
        user.stripeSubscriptionId = session.subscription;
        await user.save();
      }

      if (isNewUser) {
        const otp = crypto.randomInt(100000, 999999).toString();
        const withOtp = await User.findById(user._id).select(
          '+resetPasswordOTP +resetPasswordOTPExpiry'
        );
        withOtp.resetPasswordOTP = otp;
        withOtp.resetPasswordOTPExpiry = new Date(Date.now() + 30 * 60 * 1000);
        await withOtp.save();

        try {
          await sendOTPEmail(email, otp, companyName || 'there');
          console.log(`✅ Welcome OTP sent to ${email}`);
        } catch (err) {
          console.error('❌ Failed to send welcome OTP:', err.message);
        }
      } else {
        console.log(`✅ Existing account resubscribed, no OTP sent: ${email}`);
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const quantity = sub.items?.data?.[0]?.quantity;
      const update = {
        subscriptionStatus: sub.status === 'active' ? 'active' : sub.status,
      };
      if (typeof quantity === 'number') {
        update.driverCount = quantity;
      }
      await User.findOneAndUpdate({ stripeSubscriptionId: sub.id }, update);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      await User.findOneAndUpdate(
        { stripeSubscriptionId: sub.id },
        { subscriptionStatus: 'canceled' }
      );
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      await User.findOneAndUpdate(
        { stripeCustomerId: invoice.customer },
        { subscriptionStatus: 'past_due' }
      );
      break;
    }

    // ── UPDATED: instead of hand-building an invoice-look-alike, we now
    // point the customer straight at Stripe's own official invoice (PDF +
    // hosted page), which already has your business name, ABN, GST,
    // invoice number, date, and "Paid" status — because Stripe generated it.
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      const email = (invoice.customer_email || '').toLowerCase().trim();

      if (!email) {
        console.error('❌ Invoice paid but no customer_email on invoice', invoice.id);
        break;
      }

      const user = await User.findOne({ stripeCustomerId: invoice.customer });
      const lineItem = invoice.lines?.data?.[0];

      try {
        await sendInvoiceEmail(email, {
          customerBusinessName: user?.companyName || invoice.customer_name || '',
          invoiceNumber: invoice.number || '',
          date: new Date(invoice.created * 1000).toLocaleDateString(),
          planName: lineItem?.description || 'CNS Subscription',
          total: (invoice.amount_paid / 100).toFixed(2),
          currency: invoice.currency.toUpperCase(),
          status: invoice.status === 'paid' ? 'Paid' : invoice.status,
          hostedInvoiceUrl: invoice.hosted_invoice_url, // official Stripe invoice page
          invoicePdfUrl: invoice.invoice_pdf,           // official Stripe PDF download
        });
        console.log(`✅ Invoice notification sent to ${email}`);
      } catch (err) {
        console.error('❌ Failed to send invoice notification:', err.message);
      }
      break;
    }

    default:
      break;
  }

  res.status(200).json({ received: true });
});

module.exports = {
  getPriceInfo,
  createCheckoutSession,
  updateDriverCount,
  handleStripeWebhook,
};
