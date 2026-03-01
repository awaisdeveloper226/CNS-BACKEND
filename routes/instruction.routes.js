const express = require('express');
const router = express.Router();

const {
  createInstruction,
  likeInstruction,
  dislikeInstruction,
  getInstructionsByBusiness,
  getInstructionById,
} = require('../controllers/instruction.controller');

const { protect } = require('../middleware/auth.middleware');
const { uploadKeyOrProtect } = require('../middleware/uploadKey.middleware'); // ADD

// ---------------- PUBLIC ROUTES ----------------

// Get all instructions for a business
// GET /api/instructions/business/:businessId
router.get('/business/:businessId', getInstructionsByBusiness);

// Get single instruction by ID
// GET /api/instructions/:id
router.get('/:id', getInstructionById);

// ---------------- PRIVATE ROUTES ----------------

// Create instruction
// POST /api/instructions
router.post('/', uploadKeyOrProtect, createInstruction);

// Like instruction
// PUT /api/instructions/:id/like
router.put('/:id/like', protect, likeInstruction);

// Dislike instruction
// PUT /api/instructions/:id/dislike
router.put('/:id/dislike', protect, dislikeInstruction);

module.exports = router;
