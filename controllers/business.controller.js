// controllers/business.controller.js

const asyncHandler = require("express-async-handler");
const Business = require("../models/Business");
const Instruction = require("../models/Instruction");
const Comment = require("../models/Comment");

// ── Foursquare config ─────────────────────────────────────────────────────────
const FSQ_API_KEY = process.env.CNS_FOUR_SQUARE_API_KEY;
const FSQ_SEARCH_URL = "https://api.foursquare.com/v3/places/search";

/**
 * @desc  Search Foursquare for businesses worldwide
 * @route GET /api/businesses/places-search?q=KFC+Lahore
 * @access Public
 */
const searchFoursquarePlaces = asyncHandler(async (req, res) => {
  const { q } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({ message: "Query parameter 'q' is required" });
  }

  if (!FSQ_API_KEY) {
    return res.status(500).json({ message: "Foursquare API key not configured" });
  }

  const url = `${FSQ_SEARCH_URL}?query=${encodeURIComponent(q)}&limit=10&fields=fsq_id,name,location`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: FSQ_API_KEY,
    },
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("Foursquare error:", err);
    return res.status(502).json({ message: "Foursquare search failed" });
  }

  const data = await response.json();
  const results = (data.results || []).map((place) => {
    // Build a clean address string from Foursquare's location object
    const loc = place.location || {};
    const addressParts = [
      loc.address,
      loc.locality,
      loc.region,
      loc.country,
    ].filter(Boolean);
    const address = addressParts.join(", ") || "Address not available";

    return {
      // No _id — this is NOT in MongoDB yet
      placeId: place.fsq_id,
      name: place.name,
      address,
      source: "foursquare",
      type: "Other",
      totalContributions: 0,
      isVerified: false,
    };
  });

  res.status(200).json(results);
});

/**
 * @desc  Get all businesses (including search for frontend)
 * @route GET /api/businesses
 * @access Public
 */
const getBusinesses = asyncHandler(async (req, res) => {
  const keyword = req.query.search
    ? {
        $or: [
          { name: { $regex: req.query.search, $options: "i" } },
          { address: { $regex: req.query.search, $options: "i" } },
          { tags: { $regex: req.query.search, $options: "i" } },
        ],
      }
    : {};

  const businesses = await Business.find(keyword).sort({
    totalContributions: -1,
  });
  res.status(200).json(businesses);
});

/**
 * @desc  Get single business by ID with its instructions
 * @route GET /api/businesses/:id
 * @access Public
 */
const getBusinessDetails = asyncHandler(async (req, res) => {
  console.log("🔍 Fetching business details for ID:", req.params.id);

  const business = await Business.findById(req.params.id)
    .lean()
    .populate({
      path: "contributions",
      model: "Instruction",
      populate: {
        path: "user",
        model: "User",
        select: "name level contributions totalLikesReceived",
      },
    });

  if (!business) {
    res.status(404);
    throw new Error("Business not found");
  }

  console.log(
    "✅ Business found with",
    business.contributions?.length || 0,
    "contributions"
  );

  // Sort by rating
  if (business.contributions && business.contributions.length > 0) {
    business.contributions.sort((a, b) => {
      const scoreA = (a.likes || 0) - (a.dislikes || 0);
      const scoreB = (b.likes || 0) - (b.dislikes || 0);
      if (scoreA !== scoreB) return scoreB - scoreA;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  // Fetch comment counts for all contributions in one query
  const instructionIds = business.contributions.map((i) => i._id);
  const commentCounts = await Comment.aggregate([
    { $match: { instruction: { $in: instructionIds } } },
    { $group: { _id: "$instruction", count: { $sum: 1 } } },
  ]);
  const commentCountMap = {};
  commentCounts.forEach((c) => {
    commentCountMap[c._id.toString()] = c.count;
  });

  const detailedBusiness = {
    id: business._id,
    name: business.name,
    address: business.address,
    type: business.type,
    totalContributions: business.totalContributions,
    isVerified: business.isVerified,
    coordinates: business.coordinates,
    contributions: business.contributions.map((instr) => ({
      id: instr._id,
      notes: instr.notes || "",
      photos: instr.photos || [],
      videos: instr.videos || [],
      audioUrl: instr.audioUrl || null,
      audioDuration: instr.audioDuration || null,
      type: instr.type,
      category: instr.category,
      likes: instr.likes || 0,
      dislikes: instr.dislikes || 0,
      timestamp: instr.createdAt,
      tags: instr.tags || [],
      userId: instr.user?._id?.toString() || "unknown",
      userName: instr.user?.name || "Anonymous User",
      userLevel: instr.user?.level || 1,
      votedUsers: (instr.votedUsers || []).map((vote) => ({
        userId: vote.user?.toString() || vote.user,
        voteType: vote.voteType,
      })),
      commentCount: commentCountMap[instr._id.toString()] || 0,
    })),
  };

  res.status(200).json(detailedBusiness);
});

/**
 * @desc  Create new business
 *        Handles both manual creation AND auto-creation from a Foursquare result.
 *
 *        If a placeId is supplied and a business with that placeId already exists
 *        in MongoDB (because another user submitted instructions for the same
 *        Foursquare place earlier), we return the existing record instead of
 *        throwing a duplicate error. This makes the frontend logic simple:
 *        always POST, always get back a valid MongoDB _id.
 *
 * @route POST /api/businesses
 * @access Private
 */
const createBusiness = asyncHandler(async (req, res) => {
  const { name, address, type, courierType, placeId, source } = req.body;

  if (!name || !address) {
    res.status(400);
    throw new Error("Name and address are required");
  }

  // ── Foursquare-sourced business ───────────────────────────────────────────
  // If a placeId is provided, check if it already exists in MongoDB.
  // If yes — return it immediately (idempotent). No duplicate created.
  if (placeId) {
    const existing = await Business.findOne({ placeId });
    if (existing) {
      return res.status(200).json(existing);
    }

    const business = await Business.create({
      name,
      address,
      type: type || "Other",
      source: "foursquare",
      placeId,
      tags: courierType ? [courierType] : [],
    });

    return res.status(201).json(business);
  }

  // ── Manual business creation (original flow, unchanged) ──────────────────
  if (!type || !courierType) {
    res.status(400);
    throw new Error("Name, address, type, and courier type are required");
  }

  if (!["Mall", "Standalone", "Other"].includes(type)) {
    res.status(400);
    throw new Error("Invalid business type. Must be Mall, Standalone, or Other.");
  }

  const validCourierTypes = ["Courier/Parcel Delivery", "Food Delivery", "Both"];
  if (!validCourierTypes.includes(courierType)) {
    res.status(400);
    throw new Error(
      `Invalid courier type. Must be one of: ${validCourierTypes.join(", ")}`
    );
  }

  const existing = await Business.findOne({ name, address });
  if (existing) {
    res.status(400);
    throw new Error("Business with this name and address already exists");
  }

  const business = await Business.create({
    name,
    address,
    type,
    source: "manual",
    tags: [courierType],
  });

  res.status(201).json(business);
});

module.exports = {
  searchFoursquarePlaces,
  getBusinesses,
  getBusinessDetails,
  createBusiness,
};
