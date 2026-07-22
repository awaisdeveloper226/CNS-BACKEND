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
  // ── Denormalized snapshot of the author, captured at creation time ─────
  // Lets a comment display its author's name/level without a populate()
  // round trip, and keeps it independent of the User doc — if the user is
  // later deleted or renamed, this comment still shows what it showed
  // when it was posted.
  userName: {
    type: String,
    required: true,
  },
  userLevel: {
    type: Number,
    default: 1,
  },
  text: {
    type: String,
    required: true,
    maxlength: 500,
  },
}, { timestamps: true });

module.exports = mongoose.model('Comment', commentSchema);
