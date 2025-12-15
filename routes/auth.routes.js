// backend/routes/auth.routes.js

const express = require('express');
const router = express.Router();

const {
  registerUser,
  loginUser,
  getMe,
} = require('../controllers/auth.controller');

const { protect } = require('../middleware/auth.middleware');

// ==========================
// Public routes
// ==========================
router.post('/register', registerUser);
router.post('/login', loginUser);

// ==========================
// Protected routes
// ==========================
router.get('/me', protect, getMe);

module.exports = router;
