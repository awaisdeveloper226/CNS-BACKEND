const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Comment = require('../models/Comment');
const Instruction = require('../models/Instruction');

// GET /api/instructions/:id/comments
const getComments = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400); throw new Error('Invalid instruction ID');
  }
  // NEW: userName/userLevel are now stored directly on the Comment document
  // (denormalized at creation time), so no more populate('user').
  const comments = await Comment.find({ instruction: id })
    .sort({ createdAt: -1 });
  res.status(200).json(
    comments.map(c => ({
      id: c._id.toString(),
      instructionId: c.instruction.toString(),
      userId: c.user?.toString(),
      userName: c.userName || 'Anonymous',
      userLevel: c.userLevel || 1,
      text: c.text,
      timestamp: c.createdAt,
    }))
  );
});

// POST /api/instructions/:id/comments
const addComment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;
  const userId = req.user._id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400); throw new Error('Invalid instruction ID');
  }
  if (!text || text.trim().length === 0) {
    res.status(400); throw new Error('Comment text is required');
  }
  // Verify instruction exists
  const instruction = await Instruction.findById(id);
  if (!instruction) {
    res.status(404); throw new Error('Instruction not found');
  }
  const comment = await Comment.create({
    instruction: id,
    user: userId,
    // NEW: snapshot the author's name/level onto the comment itself, so
    // it stays independent of the User doc later.
    userName: req.user.name,
    userLevel: req.user.level ?? 1,
    text: text.trim(),
  });
  res.status(201).json({
    id: comment._id.toString(),
    instructionId: comment.instruction.toString(),
    userId: comment.user?.toString(),
    userName: comment.userName,
    userLevel: comment.userLevel,
    text: comment.text,
    timestamp: comment.createdAt,
  });
});

module.exports = { getComments, addComment };
