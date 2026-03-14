// routes/business.route.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { uploadKeyOrProtect } = require('../middleware/uploadKey.middleware');
const {
  searchFoursquarePlaces,
  reverseGeocode,
  getBusinesses,
  getBusinessDetails,
  createBusiness,
} = require('../controllers/business.controller');

// ── IMPORTANT: specific GET routes MUST be declared before /:id ──────────────
// Express matches routes top-to-bottom. If /:id came first, the strings
// "places-search" and "geocode" would be treated as ids and hit getBusinessDetails.

router.get('/places-search', searchFoursquarePlaces);
router.get('/geocode', reverseGeocode);

// Public routes
router.get('/', getBusinesses);
router.get('/:id', getBusinessDetails);

// Create business (authenticated)
router.post('/', uploadKeyOrProtect, createBusiness);

module.exports = router;
