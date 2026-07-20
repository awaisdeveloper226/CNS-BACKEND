const express = require('express');
const router = express.Router();
const {
  getPriceInfo,
  createCheckoutSession,
  updateDriverCount,
  requestCancellationOtp,
  confirmCancellation,
} = require('../controllers/payment.controller');
const { protect } = require('../middleware/auth.middleware');
router.get('/price-info', getPriceInfo);
router.post('/create-checkout-session', createCheckoutSession);
router.patch('/update-driver-count', protect, updateDriverCount);
router.post('/request-cancellation-otp', protect, requestCancellationOtp);
router.post('/confirm-cancellation', protect, confirmCancellation);
module.exports = router;
