const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth.middleware");
const { createShareLink, resolveShareLink, claimShareLink , guestLogin } = require("../controllers/share.controller");

router.post("/", protect, createShareLink);
router.get("/:token", resolveShareLink);
router.post("/:token/claim", protect, claimShareLink);
router.post("/:token/guest-login", guestLogin);

module.exports = router;
