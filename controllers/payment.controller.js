const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const User = require('../models/User');
const { sendOTPEmail, sendCancellationOTPEmail, sendInvoiceEmail } = require('../utils/emailService');

// ── Cancellation OTP config ─────────────────────────────────────────────────
// Kept separate from the password-reset OTP constants in auth.controller.js
// on purpose — same shape, different counters/fields, so the two flows never
// interfere with each other's rate limits.
const CANCEL_OTP_LIMIT     = 3;              // max requests per window
const CANCEL_OTP_WINDOW_MS = 60 * 60 * 1000; // 1 hour in ms

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

  // Create (or reuse) a real Stripe Customer with the company name.
  // This is what makes "Customer business name" appear on the official Stripe invoice.
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

  // tax_rates on the line item is what makes GST show up on the invoice.
  const lineItem = {
    price: process.env.STRIPE_PRICE_ID_MONTHLY,
    quantity: driverCount,
  };
  if (process.env.STRIPE_GST_TAX_RATE_ID) {
    lineItem.tax_rates = [process.env.STRIPE_GST_TAX_RATE_ID];
  }

  const sessionParams = {
    mode: 'subscription',
    payment_method_types: ['card'],
    customer: customer.id,
    line_items: [lineItem],
    metadata: {
      companyName,
      companyEmail: normalizedEmail,
      driverCount: String(driverCount),
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  };

  // ⚠️ TEMP TESTING ONLY — 100%-off coupon so you can trigger real invoice/receipt
  // emails without charging a real card. REMOVE this block (and unset
  // STRIPE_TEST_COUPON_ID in your env) before going fully live, or every
  // real signup will be free.
  if (process.env.STRIPE_TEST_COUPON_ID) {
    sessionParams.discounts = [{ coupon: process.env.STRIPE_TEST_COUPON_ID }];
  }

  const session = await stripe.checkout.sessions.create(sessionParams);

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

// @desc    Send an OTP to the logged-in user's email to confirm they want to
//          cancel their subscription. Step 1 of 2 — nothing is canceled here.
// @route   POST /api/payments/request-cancellation-otp
// @access  Private
const requestCancellationOtp = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select(
    '+cancelSubscriptionOTP +cancelSubscriptionOTPExpiry +cancelOtpRequestCount +cancelOtpWindowStart'
  );

  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  if (user.subscriptionStatus !== 'active') {
    res.status(400);
    throw new Error('There is no active subscription to cancel');
  }

  // ── Rate limit check (mirrors forgotPassword's, own counters) ────────────
  const now = Date.now();
  const windowStart = user.cancelOtpWindowStart ? user.cancelOtpWindowStart.getTime() : 0;
  const windowExpiry = windowStart + CANCEL_OTP_WINDOW_MS;
  const inWindow = now < windowExpiry;

  if (inWindow && user.cancelOtpRequestCount >= CANCEL_OTP_LIMIT) {
    const minutesLeft = Math.ceil((windowExpiry - now) / 60000);
    res.status(429);
    throw new Error(
      `Too many code requests. Please try again in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`
    );
  }

  if (!inWindow) {
    user.cancelOtpWindowStart = new Date(now);
    user.cancelOtpRequestCount = 1;
  } else {
    user.cancelOtpRequestCount += 1;
  }
  // ─────────────────────────────────────────────────────────────────────────

  const otp = crypto.randomInt(100000, 999999).toString();
  user.cancelSubscriptionOTP = otp;
  user.cancelSubscriptionOTPExpiry = new Date(now + 10 * 60 * 1000); // 10 min
  await user.save();

  try {
    await sendCancellationOTPEmail(user.email, otp, user.name);
    console.log(`✅ Cancellation OTP sent to ${user.email} (${user.cancelOtpRequestCount}/${CANCEL_OTP_LIMIT} this hour)`);
    res.status(200).json({ message: 'A confirmation code has been sent to your email' });
  } catch (err) {
    console.error('❌ Cancellation OTP email failed:', err.message);
    // Roll back count so a send failure doesn't eat one of their attempts
    user.cancelOtpRequestCount = Math.max(0, user.cancelOtpRequestCount - 1);
    user.cancelSubscriptionOTP = null;
    user.cancelSubscriptionOTPExpiry = null;
    await user.save();
    res.status(500);
    throw new Error('Failed to send confirmation email. Please try again.');
  }
});

// @desc    Verify the cancellation OTP and cancel the subscription.
//          Step 2 of 2 — for now this only flips subscriptionStatus locally;
//          it does NOT call Stripe to actually cancel billing yet.
// @route   POST /api/payments/confirm-cancellation
// @access  Private
const confirmCancellation = asyncHandler(async (req, res) => {
  const { otp } = req.body;

  if (!otp) {
    res.status(400);
    throw new Error('Confirmation code is required');
  }

  const user = await User.findById(req.user._id).select(
    '+cancelSubscriptionOTP +cancelSubscriptionOTPExpiry +stripeSubscriptionId'
  );

  if (!user || !user.cancelSubscriptionOTP || !user.cancelSubscriptionOTPExpiry) {
    res.status(400);
    throw new Error('Invalid or expired code. Please request a new one.');
  }

  if (new Date() > user.cancelSubscriptionOTPExpiry) {
    user.cancelSubscriptionOTP = null;
    user.cancelSubscriptionOTPExpiry = null;
    await user.save();
    res.status(400);
    throw new Error('Code has expired. Please request a new one.');
  }

  if (user.cancelSubscriptionOTP !== otp.trim()) {
    res.status(400);
    throw new Error('Invalid code. Please check and try again.');
  }

  if (user.subscriptionStatus !== 'active') {
    user.cancelSubscriptionOTP = null;
    user.cancelSubscriptionOTPExpiry = null;
    await user.save();
    res.status(400);
    throw new Error('There is no active subscription to cancel');
  }

  // The subscription is still live in Stripe (we're not calling
  // stripe.subscriptions.cancel() yet — see TODO below), so its
  // current_period_end is just the normal, already-paid-for end of this
  // billing cycle. That's exactly the date we want to show the user as
  // "you keep access until…".
  let subscriptionEndsAt = user.subscriptionEndsAt || null;
  if (user.stripeSubscriptionId) {
    try {
      const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
      if (subscription?.current_period_end) {
        subscriptionEndsAt = new Date(subscription.current_period_end * 1000);
      }
    } catch (err) {
      console.error('⚠️ Could not fetch Stripe period end for cancellation message:', err.message);
      // Not fatal — cancellation still proceeds, just without a specific date.
    }
  }

  // ⚠️ TODO: this only updates our own status field for now — it does not
  // call stripe.subscriptions.cancel / update(). Wire that up here once
  // ready to actually stop billing in Stripe (and probably let the
  // 'customer.subscription.deleted' webhook be the source of truth instead
  // of setting this directly).
  user.subscriptionStatus = 'canceled';
  user.subscriptionEndsAt = subscriptionEndsAt;
  user.cancelSubscriptionOTP = null;
  user.cancelSubscriptionOTPExpiry = null;
  user.cancelOtpRequestCount = 0;
  user.cancelOtpWindowStart = null;
  await user.save();

  console.log(`✅ Subscription marked canceled for ${user.email} (status field only — Stripe not yet called)`);
  res.status(200).json({
    message: 'Subscription canceled',
    subscriptionStatus: user.subscriptionStatus,
    subscriptionEndsAt: user.subscriptionEndsAt,
  });
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

    // Send hosted_invoice_url, NOT invoice_pdf.
    // invoice_pdf is a time-limited, pre-signed S3 link generated at the
    // moment we read the invoice object in this webhook — if the customer
    // clicks it after that link has expired, S3 drops the connection
    // (ERR_CONNECTION_RESET), which is what happened. hosted_invoice_url is
    // a permanent Stripe-hosted page: it fetches a fresh PDF live, every
    // time it's opened, and also offers a "Receipt" option from the same
    // page. (Receipt only misbehaves in one narrow case — customer has the
    // Stripe app installed AND is logged into a different account on it —
    // which is rare and not something to design around.)
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
          hostedInvoiceUrl: invoice.hosted_invoice_url, // permanent link, always fresh PDF on click
        });
        console.log(`✅ Invoice/receipt notification sent to ${email}`);
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
  requestCancellationOtp,
  confirmCancellation,
  handleStripeWebhook,
};
