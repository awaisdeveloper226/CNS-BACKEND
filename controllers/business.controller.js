// controllers/business.controller.js

const asyncHandler = require("express-async-handler");
const Business = require("../models/Business");
const Instruction = require("../models/Instruction");
const Comment = require("../models/Comment");

// ── Nominatim (OpenStreetMap) config ──────────────────────────────────────────
// Completely free, no API key, no billing required.
// Policy: must send a descriptive User-Agent and max 1 req/sec.
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_USER_AGENT = "CNS-CourierNavigator/1.0 (courier-navigator-app)";

/**
 * @desc  Search OpenStreetMap Nominatim for businesses worldwide
 * @route GET /api/businesses/places-search?q=KFC+Lahore
 * @access Public
 */
const searchFoursquarePlaces = asyncHandler(async (req, res) => {
  const { q } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({ message: "Query parameter 'q' is required" });
  }

  // Nominatim search — returns POIs, shops, restaurants, etc. worldwide
  // countrycodes= removed intentionally so it searches globally
  const params = new URLSearchParams({
    q: q.trim(),
    format: "json",
    limit: "15",
    addressdetails: "1",
    // Return only results that have a name (filters out pure address matches)
    featuretype: "settlement",
  });

  // Also do a broader search without featuretype to catch businesses
  const paramsWide = new URLSearchParams({
    q: q.trim(),
    format: "json",
    limit: "15",
    addressdetails: "1",
  });

  const url = `${NOMINATIM_URL}?${paramsWide.toString()}`;
  console.log("🔍 Nominatim request:", url);

  const response = await fetch(url, {
    headers: {
      "User-Agent": NOMINATIM_USER_AGENT,
      "Accept-Language": "en",
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`❌ Nominatim error ${response.status}:`, errText);
    return res.status(502).json({ message: "Place search failed", detail: errText });
  }

  const data = await response.json();
  console.log(`✅ Nominatim returned ${data.length} results`);

  // Map Nominatim response to our Business shape
  const results = data
    .filter((place) => place.display_name && place.osm_id)
    .map((place) => {
      const addr = place.address || {};

      // Build a clean short address: road + suburb/city + country
      const addressParts = [
        addr.road || addr.pedestrian || addr.footway,
        addr.suburb || addr.quarter || addr.neighbourhood,
        addr.city || addr.town || addr.village || addr.municipality,
        addr.state,
        addr.country,
      ].filter(Boolean);

      // Deduplicate consecutive identical parts
      const dedupedParts = addressParts.filter(
        (part, i) => i === 0 || part !== addressParts[i - 1]
      );

      const address = dedupedParts.join(", ") || place.display_name;

      // Use OSM type + id as a stable unique key
      const placeId = `osm_${place.osm_type}_${place.osm_id}`;

      // Extract a clean name — Nominatim puts full name in display_name
      // but the actual POI name is in place.name (if present) or the
      // first segment of display_name
      const name =
        place.name ||
        place.display_name.split(",")[0].trim();

      return {
        placeId,
        name,
        address,
        source: "foursquare", // keep field name consistent with rest of codebase
        type: "Standalone",
        totalContributions: 0,
        isVerified: false,
      };
    })
    // Filter out results where name is just a number or very generic
    .filter((r) => r.name && r.name.length > 1 && !/^\d+$/.test(r.name))
    // Deduplicate by name+address combination
    .filter(
      (r, i, arr) =>
        arr.findIndex(
          (x) => x.name.toLowerCase() === r.name.toLowerCase() && x.address === r.address
        ) === i
    );

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

  // ── OSM/Foursquare-sourced business (placeId present) ────────────────────
  if (placeId) {
    const existing = await Business.findOne({ placeId });
    if (existing) {
      return res.status(200).json(existing);
    }

    const business = await Business.create({
      name,
      address,
      type: type || "Standalone",
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
