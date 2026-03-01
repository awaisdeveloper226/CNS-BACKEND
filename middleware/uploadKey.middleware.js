// backend/middleware/uploadKey.middleware.js
const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const User = require('../models/User');

const uploadKeyOrProtect = asyncHandler(async (req, res, next) => {
  const uploadKey = req.headers['x-upload-key'];

  if (uploadKey && uploadKey === process.env.UPLOAD_SECRET_KEY) {
    const botUser = await User.findById(process.env.UPLOAD_BOT_USER_ID);
    if (!botUser) {
      res.status(500);
      throw new Error('Upload bot user not configured.');
    }

    // Read business name from header (sent by web form on instruction POST)
    // Falls back to body name (business POST) or default
    const displayName =
      req.headers['x-business-name'] ||
      req.body?.name ||
      'Web Contribution';

    // Rename the bot to the business name before saving
    botUser.name = displayName;
    await botUser.save();

    req.user = botUser;
    return next();
  }

  // Normal JWT path — unchanged
  let token;
  if (req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) {
    res.status(401);
    throw new Error('Not authorized, no token');
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user) {
      res.status(401);
      throw new Error('Not authorized, user not found');
    }
    req.user = user;
    next();
  } catch {
    res.status(401);
    throw new Error('Not authorized, token invalid');
  }
});

module.exports = { uploadKeyOrProtect };
