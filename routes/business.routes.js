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
  updateEntryPin,
  backfillCoordinates,
} = require('../controllers/business.controller');

// ── IMPORTANT: specific GET routes MUST be declared before /:id ──────────────

router.get('/places-search', searchFoursquarePlaces);
router.get('/geocode', reverseGeocode);

// ── ONE-TIME ADMIN UTILITY ────────────────────────────────────────────────────
// After running, remove this line and redeploy.
router.get('/admin/backfill-coordinates', backfillCoordinates);
// ─────────────────────────────────────────────────────────────────────────────

// Public routes
router.get('/', getBusinesses);
router.get('/:id', getBusinessDetails);

// Create business (authenticated)
router.post('/', uploadKeyOrProtect, createBusiness);

router.patch('/:id/entry-pin', updateEntryPin);

module.exports = router;
