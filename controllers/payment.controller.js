const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const User = require('../models/User');
const { sendOTPEmail } = require('../utils/emailService');

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
    unitAmount: price.unit_amount, // in smallest currency unit (cents)
    unitAmountDecimal: price.unit_amount / 100, // e.g. 10.00
    currency: price.currency, // e.g. "usd"
    interval: price.recurring?.interval || 'month', // "month" | "year"
  });
});

// @desc    Create Stripe Checkout session for a new company signup
// @route   POST /api/payments/create-checkout-session
// @access  Public
const createCheckoutSession = asyncHandler(async (req, res) => {
  const { companyName, companyEmail, driverCount, platform } = req.body; // ← add platform

  if (!companyName || !companyEmail || !driverCount) {
    res.status(400);
    throw new Error('Company name, email, and driver count are required');
  }

  const normalizedEmail = companyEmail.toLowerCase().trim();

  const existing = await User.findOne({ email: normalizedEmail });
  // Block re-checkout for anyone who already has a live account — not just
  // 'active'. 'past_due' and 'trialing' still have a real password set and
  // should log in + fix billing from their account, not create a second
  // Stripe subscription. Only 'canceled' (or no record) may re-subscribe.
  if (existing && ['active', 'past_due', 'trialing'].includes(existing.subscriptionStatus)) {
    res.status(409);
    throw new Error('An account already exists for this email. Please sign in instead.');
  }

  // ── Pick redirect URLs by platform ──────────────────────────────────────
  const isWeb = platform === 'web';
  const successUrl = isWeb
    ? process.env.WEBSITE_CHECKOUT_SUCCESS_URL
    : `${process.env.CHECKOUT_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = isWeb
    ? process.env.WEBSITE_CHECKOUT_CANCEL_URL
    : process.env.CHECKOUT_CANCEL_URL;

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: normalizedEmail,
    line_items: [
      {
        price: process.env.STRIPE_PRICE_ID_MONTHLY,
        quantity: driverCount,
      },
    ],
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
      // Track this BEFORE we touch `user`, so we know whether this is a
      // brand-new signup (needs a password set via OTP) or a returning
      // account resubscribing (already has a working password — do NOT
      // reset it or force them through the OTP flow again).
      const isNewUser = !user;
      const randomPassword = crypto.randomBytes(20).toString('hex');

      if (isNewUser) {
        user = await User.create({
          name: companyName,
          email,
          password: randomPassword, // hashed by pre-save hook; reset below via OTP
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

      // Only brand-new accounts need the "set your password" welcome OTP.
      // Existing users already have a password — sending them through the
      // reset flow here would lock them out of the one they already know.
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
