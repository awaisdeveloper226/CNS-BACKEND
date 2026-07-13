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
    // ── OTP rate limiting ───────────────────────────────
    otpRequestCount:        { type: Number, default: 0,    select: false },
    otpWindowStart:         { type: Date,   default: null, select: false },
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
