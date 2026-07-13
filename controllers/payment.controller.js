const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const User = require('../models/User');
const { sendOTPEmail } = require('../utils/emailService');

// @desc    Create Stripe Checkout session for a new company signup
// @route   POST /api/payments/create-checkout-session
// @access  Public
const createCheckoutSession = asyncHandler(async (req, res) => {
  const { companyName, companyEmail, driverCount } = req.body;

  if (!companyName || !companyEmail || !driverCount) {
    res.status(400);
    throw new Error('Company name, email, and driver count are required');
  }

  const normalizedEmail = companyEmail.toLowerCase().trim();

  const existing = await User.findOne({ email: normalizedEmail });
  if (existing && existing.subscriptionStatus === 'active') {
    res.status(409);
    throw new Error('An active account already exists for this email. Please sign in.');
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    customer_email: normalizedEmail,
    line_items: [{ price: process.env.STRIPE_PRICE_ID_MONTHLY, quantity: 1 }],
    metadata: {
      companyName,
      companyEmail: normalizedEmail,
      driverCount: String(driverCount),
    },
    success_url: `${process.env.CHECKOUT_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: process.env.CHECKOUT_CANCEL_URL,
  });

  res.status(200).json({ url: session.url });
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
      const randomPassword = crypto.randomBytes(20).toString('hex');

      if (!user) {
        user = await User.create({
          name: companyName,
          email,
          password: randomPassword, // hashed by pre-save hook; reset below
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

      // Reuse the existing OTP mechanism as a "set your password" welcome flow
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
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object;
      await User.findOneAndUpdate(
        { stripeSubscriptionId: sub.id },
        { subscriptionStatus: sub.status === 'active' ? 'active' : sub.status }
      );
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

module.exports = { createCheckoutSession, handleStripeWebhook };
