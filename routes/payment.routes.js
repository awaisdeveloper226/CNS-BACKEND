const express = require('express');
const router = express.Router();
const {
  getPriceInfo,
  createCheckoutSession,
  updateDriverCount,
  requestCancellationOtp,
  confirmCancellation,
  reactivateSubscription,
  reconcileCancellations,
} = require('../controllers/payment.controller');
const { protect } = require('../middleware/auth.middleware');
router.get('/price-info', getPriceInfo);
router.post('/create-checkout-session', createCheckoutSession);
router.patch('/update-driver-count', protect, updateDriverCount);
router.post('/request-cancellation-otp', protect, requestCancellationOtp);
router.post('/confirm-cancellation', protect, confirmCancellation);
router.post('/reactivate-subscription', protect, reactivateSubscription);
router.post('/reconcile-cancellations', reconcileCancellations); // no `protect` — uses its own secret header
module.exports = router;
