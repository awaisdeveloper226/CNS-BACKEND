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
    console.error("❌ CNS_FOUR_SQUARE_API_KEY is not set in environment");
    return res.status(500).json({ message: "Foursquare API key not configured" });
  }

  const url = `${FSQ_SEARCH_URL}?query=${encodeURIComponent(q)}&limit=10&fields=fsq_id,name,location`;

  console.log("🔍 Foursquare request:", url);
  console.log("🔑 API key prefix:", FSQ_API_KEY.slice(0, 8) + "...");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      // Foursquare Places API v3 — Service API key, no "Bearer" prefix
      Authorization: FSQ_API_KEY,
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`❌ Foursquare ${response.status}:`, errText);
    // Return the raw error so you can see exactly what Foursquare says
    return res.status(502).json({
      message: "Foursquare search failed",
      fsqStatus: response.status,
      fsqError: errText,
    });
  }

  const data = await response.json();
  console.log(`✅ Foursquare returned ${data.results?.length ?? 0} results`);

  const results = (data.results || []).map((place) => {
    const loc = place.location || {};
    const addressParts = [
      loc.address,
      loc.locality,
      loc.region,
      loc.country,
    ].filter(Boolean);
    const address = addressParts.join(", ") || "Address not available";

    return {
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

  if (business.contributions && business.contributions.length > 0) {
    business.contributions.sort((a, b) => {
      const scoreA = (a.likes || 0) - (a.dislikes || 0);
      const scoreB = (b.likes || 0) - (b.dislikes || 0);
      if (scoreA !== scoreB) return scoreB - scoreA;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

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

  // ── Manual business creation ──────────────────────────────────────────────
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
