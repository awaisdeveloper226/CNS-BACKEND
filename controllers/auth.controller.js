// backend/controllers/auth.controller.js

const asyncHandler = require('express-async-handler');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// 🔐 Generate JWT
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });
};

// =====================================================
// @desc    Register new user
// @route   POST /api/auth/register
// @access  Public
// =====================================================
const registerUser = asyncHandler(async (req, res) => {
  const { name, email, password } = req.body;

  // 1️⃣ Validate input
  if (!name || !email || !password) {
    res.status(400);
    throw new Error('All fields are required');
  }

  // 2️⃣ Normalize email (CRITICAL for production)
  const normalizedEmail = email.toLowerCase();

  // 3️⃣ Check if user already exists
  const userExists = await User.findOne({ email: normalizedEmail });

  if (userExists) {
    res.status(409); // Conflict
    throw new Error('User already exists');
  }

  // 4️⃣ Create user (password hashing handled by model)
  const user = await User.create({
    name: name.trim(),
    email: normalizedEmail,
    password,
  });

  // 5️⃣ Respond with TOKEN ONLY (IMPORTANT)
  // Frontend must call /auth/me to fetch user
  res.status(201).json({
    token: generateToken(user._id),
  });
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

  // ✅ MUST explicitly select password field
  const user = await User.findOne({ email: normalizedEmail }).select('+password');

  if (!user || !(await user.matchPassword(password))) {
    res.status(401);
    throw new Error('Invalid email or password');
  }

  // 🔐 Return token only
  res.json({
    token: generateToken(user._id),
  });
});

// =====================================================
// @desc    Get logged-in user
// @route   GET /api/auth/me
// @access  Private
// =====================================================
const getMe = asyncHandler(async (req, res) => {
  // req.user injected by protect middleware
  res.status(200).json(req.user);
});

module.exports = {
  registerUser,
  loginUser,
  getMe,
};
