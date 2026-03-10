// backend/controllers/auth.controller.js
const asyncHandler = require('express-async-handler');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { sendOTPEmail } = require('../utils/emailService');

// 🔐 Generate JWT
// 🔐 Generate JWT
const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });

// =====================================================
// @desc    Register new user
// @route   POST /api/auth/register
// @access  Public
// =====================================================
const registerUser = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    res.status(400);
    throw new Error('All fields are required');
  }

  const normalizedEmail = email.toLowerCase();
  const userExists = await User.findOne({ email: normalizedEmail });

  if (userExists) {
    res.status(409);
    throw new Error('User already exists');
  }

  const user = await User.create({
    name: name.trim(),
    email: normalizedEmail,
    password,
  });

  res.status(201).json({ token: generateToken(user._id) });
});

// =====================================================
// @desc    Authenticate user
// @route   POST /api/auth/login
// @access  Public
// =====================================================
const loginUser = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400);
    throw new Error('Email and password are required');
  }

  const normalizedEmail = email.toLowerCase();
  const user = await User.findOne({ email: normalizedEmail }).select('+password');

  if (!user || !(await user.matchPassword(password))) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  res.json({ token: generateToken(user._id) });
});

// =====================================================
// @desc    Get logged-in user
// @route   GET /api/auth/me
// @access  Private
// =====================================================
const getMe = asyncHandler(async (req, res) => {
  res.status(200).json(req.user);
});

// =====================================================
// @desc    Send OTP for password reset
// @route   POST /api/auth/forgot-password
// @access  Public
// =====================================================
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    res.status(400);
    throw new Error('Email is required');
  }

  const user = await User.findOne({ email: email.toLowerCase().trim() })
    .select('+resetPasswordOTP +resetPasswordOTPExpiry');

  // Always respond the same way — prevents email enumeration attacks
  if (!user) {
    return res.status(200).json({ message: 'If that email exists, an OTP has been sent' });
  }

  // Generate 6-digit OTP
  const otp = crypto.randomInt(100000, 999999).toString();

  user.resetPasswordOTP = otp;
  user.resetPasswordOTPExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 min
  await user.save();

  try {
    await sendOTPEmail(user.email, otp, user.name);
    console.log(`✅ OTP sent to ${user.email}`);
    res.status(200).json({ message: 'OTP sent to your email' });
  } catch (err) {
    console.error('❌ Email send failed:', err.message);
    console.error("❌ Full error:", err); // add this line
    // Clear OTP if email fails so user can try again
    user.resetPasswordOTP = null;
    user.resetPasswordOTPExpiry = null;
    await user.save();
    res.status(500);
    throw new Error('Failed to send email. Please try again.');
  }
});

// =====================================================
// @desc    Reset password using OTP
// @route   POST /api/auth/reset-password
// @access  Public
// =====================================================
const resetPassword = asyncHandler(async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    res.status(400);
    throw new Error('Email, OTP, and new password are required');
  }

  if (newPassword.length < 6) {
    res.status(400);
    throw new Error('Password must be at least 6 characters');
  }

  const user = await User.findOne({ email: email.toLowerCase().trim() })
    .select('+password +resetPasswordOTP +resetPasswordOTPExpiry');

  if (!user || !user.resetPasswordOTP || !user.resetPasswordOTPExpiry) {
    res.status(400);
    throw new Error('Invalid or expired OTP. Please request a new one.');
  }

  if (new Date() > user.resetPasswordOTPExpiry) {
    user.resetPasswordOTP = null;
    user.resetPasswordOTPExpiry = null;
    await user.save();
    res.status(400);
    throw new Error('OTP has expired. Please request a new one.');
  }

  if (user.resetPasswordOTP !== otp.trim()) {
    res.status(400);
    throw new Error('Invalid OTP. Please check the code and try again.');
  }

  // Update password — pre-save hook will hash it
  user.password = newPassword;
  user.resetPasswordOTP = null;
  user.resetPasswordOTPExpiry = null;
  await user.save();

  console.log(`✅ Password reset for ${user.email}`);
  res.status(200).json({ message: 'Password reset successfully' });
});

module.exports = {
  registerUser,
  loginUser,
  getMe,
  forgotPassword,
  resetPassword,
};
