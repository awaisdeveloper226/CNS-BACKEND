// routes/business.route.js

const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/auth.middleware'); // ASSUMED: Import required auth middleware

const {
  getBusinesses,
  getBusinessDetails,
  createBusiness,
} = require('../controllers/business.controller');

// Public routes (Read access is public)
router.get('/', getBusinesses);
router.get('/:id', getBusinessDetails);

// Create business (Requires authentication - Section 2.2)
// Enforced 'protect' middleware to ensure only logged-in users can create businesses
router.post('/', protect, createBusiness);

module.exports = router;