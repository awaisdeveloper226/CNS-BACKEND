const express = require('express');
const router = express.Router();
const User = require('../models/User');

/**
 * @route GET /api/community/leaderboard
 * @desc Get the list of top users sorted by contributions
 * @access Public
 */
router.get('/leaderboard', async (req, res) => {
  try {
    const users = await User.find(
      { _id: { $ne: process.env.UPLOAD_BOT_USER_ID } }, // ← exclude web bot
      'name contributions level'
    )
      .sort({ contributions: -1 })
      .limit(50);

    res.json(users);
  } catch (err) {
    console.error('Leaderboard fetch error:', err);
    res.status(500).json({ message: 'Server error fetching leaderboard' });
  }
});

module.exports = router;
