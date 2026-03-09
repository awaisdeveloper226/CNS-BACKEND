// backend/routes/auth.routes.js
const express = require('express');
const router = express.Router();
const {
  registerUser,
  loginUser,
  getMe,
  forgotPassword,
  resetPassword,
} = require('../controllers/auth.controller');
const { protect } = require('../middleware/auth.middleware');

// ==========================
// Public routes
// ==========================
router.post('/register', registerUser);
router.post('/login', loginUser);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

// ==========================
// Protected routes
// ==========================
router.get('/me', protect, getMe);

module.exports = router;
