// backend/models/User.js

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

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
      select: false, // 🔐 Never return password by default
    },

    // --- Gamification / Tracking (Section 7.1) ---

    level: {
      type: Number,
      default: 1,
    },

    contributions: {
      type: Number,
      default: 0,
    },
    
    // REQUIRED: Tracks total likes received across all their instructions (Section 7.1 - Likes received)
    totalLikesReceived: {
        type: Number,
        default: 0,
    },

    // REQUIRED: Tracks titles/badges earned by the user (Section 7.2)
    badges: {
        type: [String], // Store badge names or IDs (e.g., 'Local Guide', 'Mall Navigator')
        default: [],
    },
  },
  {
    timestamps: true,
  }
);

// =====================================================
// 🔐 Hash password before save
// =====================================================
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

// =====================================================
// 🔍 Compare password
// =====================================================
UserSchema.methods.matchPassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', UserSchema);