const express = require('express');
const dotenv = require('dotenv');
const connectDB = require('./config/db');
const { notFound, errorHandler } = require('./middleware/error.middleware');

// ==============================
// Load environment variables
// ==============================
dotenv.config();

// ==============================
// Connect Database
// ==============================
connectDB();

// ==============================
// Initialize app
// ==============================
const app = express();
const PORT = process.env.PORT || 5000;

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

// ==========================================================
// API Routes (UPDATED to include the new 'community' route)
// ==========================================================
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/businesses', require('./routes/business.routes'));
app.use('/api/instructions', require('./routes/instruction.routes'));
// --- NEW COMMUNITY ROUTE ---
app.use('/api/community', require('./routes/community')); // Assuming the file is named 'community.js'
// ---------------------------

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