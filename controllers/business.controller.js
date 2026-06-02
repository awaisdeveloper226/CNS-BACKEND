// controllers/business.controller.js

const asyncHandler = require("express-async-handler");
const Business = require("../models/Business");
const Instruction = require("../models/Instruction");
const Comment = require("../models/Comment");

// ── Foursquare Legacy/v2 API Config ──────────────────────────────────────────
const FOURSQUARE_API_KEY = process.env.FOURSQUARE_API_KEY;
// Google key reserved strictly for backend-to-server geocoding proxy actions
const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

/**
 * @desc  Search Foursquare Places (v2 Legacy) for businesses worldwide
 * @route GET /api/businesses/places-search?q=KFC+Lahore
 * @access Public
 */
const searchFoursquarePlaces = asyncHandler(async (req, res) => {
  const { q } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({ message: "Query parameter 'q' is required" });
  }

  if (!FOURSQUARE_API_KEY) {
    console.error("❌ FOURSQUARE_API_KEY is not set in environment variables");
    return res.status(500).json({ message: "Places search is not configured" });
  }

  console.log("🔍 Foursquare v2 Places request for query:", q.trim());

  try {
    // Target the robust v2 venues endpoint utilizing your authentic token parameter
    const url = `https://api.foursquare.com/v2/venues/search?v=20240101&intent=browse&near=Pakistan&query=${encodeURIComponent(q.trim())}&oauth_token=${FOURSQUARE_API_KEY}&limit=20`;

    const response = await fetch(url, { method: "GET" });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`❌ Foursquare v2 Places error ${response.status}:`, errText);
      return res.status(502).json({ message: "Place search failed", detail: errText });
    }

    const data = await response.json();
    const venues = data.response?.venues || [];
    console.log(`✅ Foursquare v2 returned ${venues.length} results`);

    // Flatten venue results explicitly to match the frontend scoring schema structural requirements
    const results = venues.map((venue) => ({
      placeId: venue.id,
      name: venue.name || "",
      address: venue.location?.formattedAddress?.join(", ") || venue.location?.address || "Address not specified",
      source: "foursquare", 
      type: "Standalone",
      totalContributions: 0,
      isVerified: false,
    }));

    return res.status(200).json(results);
  } catch (error) {
    console.error("❌ Network error during Foursquare execution:", error);
    return res.status(502).json({ message: "Foursquare service integration error" });
  }
});

/**
 * @desc  Reverse geocode lat/lng → address via Google Geocoding API
 * @route GET /api/businesses/geocode?lat=X&lng=Y
 * @access Public
 */
const reverseGeocode = asyncHandler(async (req, res) => {
  const { lat, lng } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ message: "lat and lng query params are required" });
  }

  if (!GOOGLE_API_KEY) {
    return res.status(500).json({ message: "Geocoding is not configured" });
  }

  console.log(`[Geocode] Fetching for lat=${lat}, lng=${lng}`);

  const geocodeRes = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_API_KEY}`
  );
  const geocodeData = await geocodeRes.json();
  console.log("[Geocode] status:", geocodeData.status);

  let nearbyName = null;
  try {
    const nearbyRes = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_API_KEY,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress",
      },
      body: JSON.stringify({
        locationRestriction: {
          circle: {
            center: { latitude: parseFloat(lat), longitude: parseFloat(lng) },
            radius: 100.0,
          },
        },
        maxResultCount: 1,
      }),
    });
    const nearbyData = await nearbyRes.json();
    nearbyName = nearbyData.places?.[0]?.displayName?.text ?? null;
  } catch (e) {
    console.log("[Nearby Verification Failed] Continuing with geocode profile mapping.");
  }

  res.status(200).json({
    ...geocodeData,
    nearbyName,
  });
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

  if (placeId) {
    const existing = await Business.findOne({ placeId });
    if (existing) {
      return res.status(200).json(existing);
    }

    try {
      const business = await Business.create({
        name,
        address,
        type: type || "Standalone",
        source: "foursquare",
        placeId,
        tags: courierType ? [courierType] : [],
      });
      return res.status(201).json(business);
    } catch (err) {
      if (err.code === 11000) {
        const race = await Business.findOne({ placeId });
        if (race) return res.status(200).json(race);
      }
      throw err;
    }
  }

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
    return res.status(200).json(existing);
  }

  try {
    const business = await Business.create({
      name,
      address,
      type,
      source: "manual",
      tags: [courierType],
    });
    return res.status(201).json(business);
  } catch (err) {
    if (err.code === 11000) {
      const race = await Business.findOne({ name, address });
      if (race) return res.status(200).json(race);
      res.status(400);
      throw new Error("A business with this name and address already exists.");
    }
    throw err;
  }
});

module.exports = {
  searchFoursquarePlaces,
  reverseGeocode,
  getBusinesses,
  getBusinessDetails,
  createBusiness,
};
