const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  instruction: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Instruction',
    required: true,
    index: true, // Important for fast lookups by instruction
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  text: {
    type: String,
    required: true,
    maxlength: 500,
  },
}, { timestamps: true });

module.exports = mongoose.model('Comment', commentSchema);
