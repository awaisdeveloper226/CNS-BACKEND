const crypto = require("crypto");
const asyncHandler = require("express-async-handler");
const ShareLink = require("../models/ShareLink");
const Business = require("../models/Business");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const LINK_TTL_MS = 2 * 24 * 60 * 60 * 1000; // 48 hours

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

// POST /api/share/:token/guest-login  (public) — silent guest sign-in for
// visitors who open the link on the website without a real account
const guestLogin = asyncHandler(async (req, res) => {
  const link = await ShareLink.findOne({ token: req.params.token }).populate("sharedBy", "name");

  if (!link || link.status === "revoked" || link.expiresAt < new Date()) {
    res.status(410);
    throw new Error("This link has expired.");
  }

  // If a real app user already claimed this link, guests can't take it over
  if (link.claimedBy && !link.guestUser) {
    res.status(403);
    throw new Error("This link is already in use.");
  }

  let guestUserId = link.guestUser;

  if (!guestUserId) {
    // Deliberately doesn't reuse the raw share token — it can contain '-' / '_'
    // in ways that risk tripping the User schema's email regex. A plain hex
    // id sidesteps that entirely.
    const guestId = crypto.randomBytes(8).toString("hex");
    const sharerName = (link.sharedBy?.name || "a friend").trim();

    const guestUser = await User.create({
      name: `Guest via ${sharerName}`.slice(0, 50),
      email: `guest.${guestId}@share.cns.app`,
      password: crypto.randomBytes(16).toString("hex"), // hashed by the pre-save hook like any other user
    });

    guestUserId = guestUser._id;
    link.guestUser = guestUserId;
    link.claimedBy = guestUserId; // same pair-binding mechanism as the app's /claim
    link.status = "claimed";
    await link.save();
  }

  const jwtToken = jwt.sign({ id: guestUserId }, process.env.JWT_SECRET, { expiresIn: "24h" });
  const user = await User.findById(guestUserId).select("-password");

  res.status(200).json({ token: jwtToken, user });
});

module.exports = { createShareLink, resolveShareLink, claimShareLink, guestLogin };
