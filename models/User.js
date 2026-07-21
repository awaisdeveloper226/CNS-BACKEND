const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const SearchHistorySchema = new mongoose.Schema(
  {
    query: { type: String, required: true, trim: true },
    searchedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);
const UserSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: 2,
      maxlength: 50,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
      match: [
        /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
        'Please use a valid email address',
      ],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 6,
      select: false,
    },
    level:               { type: Number, default: 1 },
    contributions:       { type: Number, default: 0 },
    totalLikesReceived:  { type: Number, default: 0 },
    badges:              { type: [String], default: [] },
    // ── Share-link guest accounts ───────────────────────
    // true only for accounts auto-created by /api/share/:token/guest-login —
    // used by the website to lock these sessions to a single business.
    isGuest: { type: Boolean, default: false },
    // ── Company / subscription (Stripe) ─────────────────
    companyName:   { type: String, trim: true },
    driverCount:   { type: Number },
    isCompanyAdmin:{ type: Boolean, default: false },
    subscriptionStatus: {
      type: String,
      enum: ['pending', 'active', 'past_due', 'canceled'],
      default: 'pending',
    },
    // True from the moment a cancellation is confirmed until either (a) the
    // user reactivates before the period ends, or (b) Stripe actually ends
    // the subscription and the webhook deletes this document. This is the
    // single flag that distinguishes "canceled, still in grace period" from
    // any other meaning of subscriptionStatus === 'canceled'. Always kept in
    // sync with Stripe's own cancel_at_period_end via the webhook — never
    // trust a stale local copy for anything destructive.
    cancelAtPeriodEnd: { type: Boolean, default: false },
    stripeCustomerId:     { type: String, select: false },
    stripeSubscriptionId: { type: String, select: false },
    // Set when a cancellation is confirmed — the current billing period's
    // end date pulled from Stripe at that moment, so the UI can tell the
    // user how long they keep access. Not select:false since it's shown
    // directly in the profile.
    subscriptionEndsAt:   { type: Date, default: null },
    // ── Device tracking (shared account usage) ──────────
    // One device entry per distinct browser/device that has ever logged in.
    // lastLoginAt updates on every login from a known device; a brand new
    // deviceId pushes a new entry and bumps totalDevices.
    devices: {
      type: [
        {
          deviceId:    { type: String, required: true },
          userAgent:   { type: String },
          platform:    { type: String },
          firstSeenAt: { type: Date, default: Date.now },
          lastLoginAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
      select: true,
    },
    totalDevices: { type: Number, default: 0 },
    // ── Search history (last 5 kept) ────────────────────
  searchHistory: {
  type: [
    {
      query:     { type: String, required: true, trim: true },
      searchedAt:{ type: Date,   default: Date.now },
    },
  ],
  default: [],
  select: true,
},
    // ── Password reset OTP ──────────────────────────────
    resetPasswordOTP:       { type: String, default: null, select: false },
    resetPasswordOTPExpiry: { type: Date,   default: null, select: false },
    // ── OTP rate limiting (password reset) ──────────────
    otpRequestCount:        { type: Number, default: 0,    select: false },
    otpWindowStart:         { type: Date,   default: null, select: false },
    // ── Subscription-cancellation OTP ───────────────────
    // Kept separate from the password-reset OTP fields/counters above on
    // purpose, so requesting one code never eats into or resets the rate
    // limit for the other.
    cancelSubscriptionOTP:       { type: String, default: null, select: false },
    cancelSubscriptionOTPExpiry: { type: Date,   default: null, select: false },
    cancelOtpRequestCount:       { type: Number, default: 0,    select: false },
    cancelOtpWindowStart:        { type: Date,   default: null, select: false },
  },
  { timestamps: true }
);
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});
UserSchema.methods.matchPassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};
module.exports = mongoose.model('User', UserSchema);
