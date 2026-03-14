// controllers/business.controller.js

const asyncHandler = require("express-async-handler");
const Business = require("../models/Business");
const Instruction = require("../models/Instruction");
const Comment = require("../models/Comment");

// ── Google Places API (New) config ────────────────────────────────────────────
const GOOGLE_PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const GOOGLE_GEOCODING_KEY = process.env.GOOGLE_GEOCODING_KEY;

/**
 * @desc  Search Google Places (New) for businesses worldwide
 * @route GET /api/businesses/places-search?q=KFC+Lahore
 * @access Public
 */
const searchFoursquarePlaces = asyncHandler(async (req, res) => {
  const { q } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({ message: "Query parameter 'q' is required" });
  }

  if (!GOOGLE_API_KEY) {
    console.error("❌ GOOGLE_PLACES_API_KEY is not set in environment variables");
    return res.status(500).json({ message: "Places search is not configured" });
  }

  console.log("🔍 Google Places (New) request for query:", q.trim());

  const response = await fetch(GOOGLE_PLACES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_API_KEY,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress",
    },
    body: JSON.stringify({ textQuery: q.trim() }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`❌ Google Places error ${response.status}:`, errText);
    return res.status(502).json({ message: "Place search failed", detail: errText });
  }

  const data = await response.json();
  console.log(`✅ Google Places returned ${(data.places || []).length} results`);

  const results = (data.places || []).map((place) => ({
    placeId: place.id,
    name: place.displayName?.text || "",
    address: place.formattedAddress || "",
    source: "foursquare", // keep field name consistent with rest of codebase
    type: "Standalone",
    totalContributions: 0,
    isVerified: false,
  }));

  res.status(200).json(results);
});

/**
 * @desc  Reverse geocode lat/lng → address via Google Geocoding API
 * @route GET /api/businesses/geocode?lat=X&lng=Y
 * @access Public
 *
 * Why this exists as a backend proxy:
 * The Google Geocoding API blocks requests from WebViews because they send
 * no HTTP referrer header. Calling it from the backend (server-to-server)
 * has no referrer restriction so it always succeeds.
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

  // ── 1. Reverse geocode via new Geocoding API (v1) ──────────────────────
  const geocodeRes = await fetch(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_GEOCODING_KEY}`
  );
  const geocodeData = await geocodeRes.json();
  console.log("[Geocode] status:", geocodeData.status);

  // ── 2. Nearby search via new Places API (v1) ───────────────────────────
  const nearbyRes = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_GEOCODING_KEY,
      "X-Goog-FieldMask": "places.displayName,places.formattedAddress",
    },
    body: JSON.stringify({
      locationRestriction: {
        circle: {
          center: { latitude: parseFloat(lat), longitude: parseFloat(lng) },
          radius: 100.0, // 100 metres
        },
      },
      maxResultCount: 1,
    }),
  });
  const nearbyData = await nearbyRes.json();
  console.log("[Nearby] response:", JSON.stringify(nearbyData));

  const nearbyName = nearbyData.places?.[0]?.displayName?.text ?? null;
  console.log("[Nearby] nearbyName:", nearbyName);

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

  // ── Google Places-sourced business (placeId present) ─────────────────────
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
        // Race condition: another request created this placeId just after our
        // findOne check — find and return the existing record instead of failing
        const race = await Business.findOne({ placeId });
        if (race) return res.status(200).json(race);
      }
      throw err;
    }
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
    // Return the existing business instead of erroring — the app can continue
    // with it rather than showing a failure message to the user
    return res.status(200).json(existing);
  }

  try {
    const business = await Business.create({
      name,
      address,
      type,
      source: "manual",
      tags: [courierType],
      // ⚠️  Do NOT set placeId here at all — omitting the field entirely
      // (rather than setting it to null) is what makes the sparse unique
      // index ignore these documents and prevents the duplicate key error
    });
    return res.status(201).json(business);
  } catch (err) {
    if (err.code === 11000) {
      // Race condition between our findOne check and the create call —
      // find and return the record that won the race
      const race = await Business.findOne({ name, address });
      if (race) return res.status(200).json(race);

      // Shouldn't reach here, but surface a clean error if it does
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
