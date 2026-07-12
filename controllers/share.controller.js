const crypto = require("crypto");
const asyncHandler = require("express-async-handler");
const ShareLink = require("../models/ShareLink");
const Business = require("../models/Business");

const LINK_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function generateToken() {
  return crypto.randomBytes(16).toString("base64url"); // ~22 chars, unguessable
}

// POST /api/share  (auth) — sharer creates a link
const createShareLink = asyncHandler(async (req, res) => {
  const { businessId, placeId, name, address, type, coordinates } = req.body;

  if (!businessId && !placeId) {
    res.status(400);
    throw new Error("businessId or placeId is required");
  }

  let businessMeta = { name, address, type, coordinates };

  // Registered business — trust the DB, not the client payload
  if (businessId) {
    const business = await Business.findById(businessId).select("name address type coordinates").lean();
    if (!business) {
      res.status(404);
      throw new Error("Business not found");
    }
    businessMeta = {
      name: business.name,
      address: business.address,
      type: business.type,
      coordinates: business.coordinates,
    };
  }

  const link = await ShareLink.create({
    token: generateToken(),
    business: businessId || null,
    placeId: businessId ? null : placeId,
    businessMeta,
    sharedBy: req.user._id,
    expiresAt: new Date(Date.now() + LINK_TTL_MS),
  });

  res.status(201).json({ token: link.token, expiresAt: link.expiresAt });
});

// GET /api/share/:token  (public) — preview, used by the website fallback
const resolveShareLink = asyncHandler(async (req, res) => {
  const link = await ShareLink.findOne({ token: req.params.token });

  if (!link || link.status === "revoked" || link.expiresAt < new Date()) {
    return res.status(410).json({ valid: false, message: "This link has expired." });
  }

  res.status(200).json({
    valid: true,
    business: link.businessMeta,
    businessId: link.business || null,
    placeId: link.placeId || null,
  });
});

// POST /api/share/:token/claim  (auth) — recipient claims it from inside the app
const claimShareLink = asyncHandler(async (req, res) => {
  const link = await ShareLink.findOne({ token: req.params.token });

  if (!link || link.status === "revoked" || link.expiresAt < new Date()) {
    res.status(410);
    throw new Error("This link has expired.");
  }

  if (!link.claimedBy) {
    // First person to open it — binds the link to them
    link.claimedBy = req.user._id;
    link.status = "claimed";
    await link.save();
  } else if (String(link.claimedBy) !== String(req.user._id)) {
    // Anyone else — including a forwarded copy of the link — is rejected
    res.status(403);
    throw new Error("This link is no longer valid for your account.");
  }

  res.status(200).json({
    business: link.businessMeta,
    businessId: link.business || null,
    placeId: link.placeId || null,
  });
});

module.exports = { createShareLink, resolveShareLink, claimShareLink };
