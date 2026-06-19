const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const connectDB = require('./config/db');
const { notFound, errorHandler } = require('./middleware/error.middleware');

dotenv.config();
connectDB();

const app = express();
const PORT = process.env.PORT || 5000;

// ==============================
// CORS Configuration
// ==============================
app.use(cors({
  origin: function (origin, callback) {
    const allowed = [
      'https://cns-backend-production.up.railway.app',
      'https://cns-business-and-instruction-upload.vercel.app',
    ];
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin || allowed.includes(origin) || origin.endsWith('.vercel.app')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-upload-key', 'x-business-name'],
  credentials: true
}));

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


// In your main server file (e.g. server.js or app.js)
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: Date.now() });
});



// ==============================
// API Routes
// ==============================
app.use('/api/auth', require('./routes/auth.routes'));
app.use('/api/businesses', require('./routes/business.routes'));
app.use('/api/instructions', require('./routes/instruction.routes'));
app.use('/api/community', require('./routes/community'));
app.use('/api/instructions/:id/comments', require('./routes/comment.routes'));

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
