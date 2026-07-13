const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const connectDB = require('./config/db');
const { notFound, errorHandler } = require('./middleware/error.middleware');
const { handleStripeWebhook } = require('./controllers/payment.controller');

dotenv.config();
connectDB();

const app = express();
const PORT = process.env.PORT || 5000;

// ==============================
// CORS Configuration
// ==============================
app.use(cors());

// ==============================
// Stripe Webhook
// MUST be BEFORE express.json()
// ==============================
app.post(
  '/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  handleStripeWebhook
);

// ==============================
// Body parsers
// ==============================
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ==============================
// Root route (health check)
// ==============================
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Courier Navigator API is running',
  });
});

// ==============================
// API Health Check
// ==============================
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: Date.now(),
  });
});

// ==============================
// API Routes
// ==============================
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/businesses', require('./routes/business.routes'));
app.use('/api/instructions', require('./routes/instruction.routes'));
app.use('/api/community', require('./routes/community'));
app.use('/api/instructions/:id/comments', require('./routes/comment.routes'));
app.use('/api/share', require('./routes/share.route'));
app.use('/api/payments', require('./routes/payment.routes'));

// ==============================
// Error Middleware (MUST be last)
// ==============================
app.use(notFound);
app.use(errorHandler);

// ==============================
// Start server
// ==============================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
