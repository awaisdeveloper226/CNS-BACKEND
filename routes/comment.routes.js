const express = require('express');
const router = express.Router({ mergeParams: true });
const { getComments, addComment } = require('../controllers/comment.controller');
const { protect } = require('../middleware/auth.middleware'); // FIX: destructure {protect} and correct filename

router.get('/', getComments);
router.post('/', protect, addComment);

module.exports = router;
