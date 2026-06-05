// controllers/business.controller.js

const asyncHandler = require("express-async-handler");
const Business = require("../models/Business");
const Instruction = require("../models/Instruction");
const Comment = require("../models/Comment");

const GOOGLE_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

/**
 * @desc  Search places via Nominatim (OpenStreetMap) — free, no API key required
 * @route GET /api/businesses/places-search?q=KFC+Lahore
 * @access Public
 */
const searchFoursquarePlaces = asyncHandler(async (req, res) => {
  const { q } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({ message: "Query parameter 'q' is required" });
  }

  const query = q.trim();
  console.log("🔍 Nominatim places search for query:", query);

  try {
    const url =
      `https://nominatim.openstreetmap.org/search` +
      `?q=${encodeURIComponent(query)}` +
      `&format=json` +
      `&addressdetails=1` +
      `&limit=20` +
      `&dedupe=1`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": "CNS-CourierNavigatorSystem/1.0 (contact@yourdomain.com)",
        "Accept-Language": "en",
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`❌ Nominatim error ${response.status}:`, errText);
      return res.status(502).json({ message: "Place search failed", detail: errText });
    }

    const places = await response.json();
    console.log(`✅ Nominatim returned ${places.length} results`);

    const results = places.map((place) => {
      const addr = place.address || {};

      const addressParts = [
        addr.road || addr.pedestrian || addr.footway,
        addr.suburb || addr.neighbourhood || addr.quarter,
        addr.city || addr.town || addr.village || addr.county,
        addr.state,
        addr.country,
      ].filter(Boolean);

      const formattedAddress =
        addressParts.length > 0
          ? addressParts.join(", ")
          : place.display_name || "Address not available";

      const name =
        place.name ||
        addr.amenity ||
        addr.shop ||
        addr.tourism ||
        place.display_name.split(",")[0];

      return {
        placeId: `osm_${place.osm_type}_${place.osm_id}`,
        name: name.trim(),
        address: formattedAddress,
        source: "nominatim",
        type: "Standalone",
        totalContributions: 0,
        isVerified: false,
        lat: parseFloat(place.lat),
        lng: parseFloat(place.lon),
      };
    });

    const GEOGRAPHIC_CLASSES = new Set([
      "boundary", "place", "highway", "waterway",
      "natural", "landuse", "railway", "aeroway",
    ]);

    const filtered = results.filter((r, idx) => {
      const cls = places[idx]?.class;
      return !GEOGRAPHIC_CLASSES.has(cls);
    });

    return res.status(200).json(filtered.length > 0 ? filtered : results);
  } catch (error) {
    console.error("❌ Nominatim fetch error:", error);
    return res.status(502).json({ message: "Place search service error" });
  }
});

/**
 * @desc  Reverse geocode lat/lng → address
 * @route GET /api/businesses/geocode?lat=X&lng=Y
 * @access Public
 */
const reverseGeocode = asyncHandler(async (req, res) => {
  const { lat, lng } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ message: "lat and lng query params are required" });
  }

  console.log(`[Geocode] Fetching for lat=${lat}, lng=${lng}`);

  if (GOOGLE_API_KEY) {
    const geocodeRes = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_API_KEY}`
    );
    const geocodeData = await geocodeRes.json();
    console.log("[Geocode] Google status:", geocodeData.status);

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
      console.log("[Nearby Verification Failed] Continuing with geocode data.");
    }

    return res.status(200).json({ ...geocodeData, nearbyName });
  }

  console.log("[Geocode] No Google key — falling back to Nominatim reverse geocode");
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse` +
      `?lat=${lat}&lon=${lng}` +
      `&format=json` +
      `&addressdetails=1`;

    const nominatimRes = await fetch(url, {
      headers: {
        "User-Agent": "CNS-CourierNavigatorSystem/1.0 (contact@yourdomain.com)",
        "Accept-Language": "en",
      },
    });

    if (!nominatimRes.ok) {
      return res.status(502).json({ message: "Reverse geocode failed" });
    }

    const data = await nominatimRes.json();
    const addr = data.address || {};

    const formatted =
      [
        addr.road || addr.pedestrian,
        addr.suburb || addr.neighbourhood,
        addr.city || addr.town || addr.village,
        addr.state,
        addr.country,
      ]
        .filter(Boolean)
        .join(", ") || data.display_name;

    return res.status(200).json({
      status: "OK",
      results: [
        {
          formatted_address: formatted,
          geometry: {
            location: { lat: parseFloat(lat), lng: parseFloat(lng) },
          },
        },
      ],
      nearbyName: data.name || data.display_name?.split(",")[0] || null,
      _source: "nominatim",
    });
  } catch (error) {
    console.error("❌ Nominatim reverse geocode error:", error);
    return res.status(502).json({ message: "Reverse geocode service error" });
  }
});

/**
 * @desc  Get all businesses
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

  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 0;
  const skip  = req.query.skip  ? parseInt(req.query.skip,  10) : 0;

  const [businesses, total] = await Promise.all([
    Business.find(keyword)
      .sort({ totalContributions: -1 })
      .skip(skip)
      .limit(limit),
    Business.countDocuments(keyword),
  ]);

  res.status(200).json({ businesses, total });
});

/**
 * @desc  Get single business by ID with its instructions
 * @route GET /api/businesses/:id
 * @access Public
 *
 * BUG FIX: The previous version manually assembled detailedBusiness but
 * omitted the `entryPin` field entirely. This meant every load returned
 * entryPin: undefined → frontend treated it as null and the pin "vanished"
 * even though it was correctly stored in MongoDB.
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

    // ── FIX: include entryPin so the frontend can show/restore it ──────────
    // Previously this field was missing from the response, causing the pin
    // to appear "cleared" on every page load even though it was saved in DB.
    entryPin: business.entryPin ?? null,
    // ───────────────────────────────────────────────────────────────────────

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
        source: source || "nominatim",
        placeId,
        tags: courierType ? [courierType] : [],
        // Persist lat/lng so the entry-pin map centres correctly without geocoding
        coordinates: {
          lat: req.body.lat ?? null,
          lng: req.body.lng ?? null,
        },
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

/**
 * @desc  Save / update / clear the courier entry pin for a business
 * @route PATCH /api/businesses/:id/entry-pin
 * @access Public (community editable)
 */
const updateEntryPin = asyncHandler(async (req, res) => {
  const { lat, lng, label, updatedBy } = req.body;

  const isClearing = lat === null && lng === null;

  if (!isClearing) {
    if (typeof lat !== "number" || typeof lng !== "number") {
      res.status(400);
      throw new Error("lat and lng must be numbers (or both null to clear)");
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      res.status(400);
      throw new Error("lat/lng out of valid range");
    }
  }

  const business = await Business.findById(req.params.id);
  if (!business) {
    res.status(404);
    throw new Error("Business not found");
  }

  business.entryPin = isClearing
    ? { lat: null, lng: null, label: "", updatedBy: "", updatedAt: null }
    : {
        lat,
        lng,
        label: (label || "").trim().slice(0, 100),
        updatedBy: (updatedBy || "Anonymous Courier").trim().slice(0, 60),
        updatedAt: new Date(),
      };

  await business.save();

  res.status(200).json({
    message: isClearing ? "Entry pin cleared" : "Entry pin updated",
    entryPin: business.entryPin,
  });
});

module.exports = {
  searchFoursquarePlaces,
  reverseGeocode,
  getBusinesses,
  getBusinessDetails,
  createBusiness,
  updateEntryPin,
};
