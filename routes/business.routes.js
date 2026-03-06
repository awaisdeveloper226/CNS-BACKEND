// routes/business.route.js

const express = require('express');
const router = express.Router();

const { protect } = require('../middleware/auth.middleware');
const { uploadKeyOrProtect } = require('../middleware/uploadKey.middleware');

const {
  searchFoursquarePlaces,
  getBusinesses,
  getBusinessDetails,
  createBusiness,
} = require('../controllers/business.controller');

// ── IMPORTANT: /places-search MUST be declared before /:id ───────────────────
// Express matches routes top-to-bottom. If /:id came first, the string
// "places-search" would be treated as an id and hit getBusinessDetails instead.
router.get('/places-search', searchFoursquarePlaces);

// Public routes
router.get('/', getBusinesses);
router.get('/:id', getBusinessDetails);

// Create business (authenticated)
router.post('/', uploadKeyOrProtect, createBusiness);

module.exports = router;
