const express = require('express');
const router = express.Router();
const User = require('../models/User'); // Import your User model

/**
 * @route GET /api/community/leaderboard
 * @desc Get the list of top users sorted by contributions
 * @access Public (usually)
 */
router.get('/leaderboard', async (req, res) => {
  try {
    // 1. Find all users
    // 2. Select only the necessary fields: name, contributions, level, and the ID (_id)
    // 3. Sort by 'contributions' in descending order (-1)
    // 4. Optionally, limit the result to the top 50 users
    const users = await User.find({}, 'name contributions level')
      .sort({ contributions: -1 }) // -1 for descending (highest first)
      .limit(50); // Fetch top 50

    // The result is already sorted, and the frontend will use the index to assign rank.
    res.json(users);
  } catch (err) {
    console.error('Leaderboard fetch error:', err);
    res.status(500).json({ message: 'Server error fetching leaderboard' });
  }
});

module.exports = router;