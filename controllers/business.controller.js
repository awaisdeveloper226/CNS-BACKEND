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

  // ── Lazy coordinate backfill ───────────────────────────────────────────────
  let coordinates = business.coordinates;
  if (!coordinates?.lat && business.address) {
    try {
      const geoUrl =
        `https://nominatim.openstreetmap.org/search` +
        `?q=${encodeURIComponent(business.address)}&format=json&limit=1`;
      const geoRes = await fetch(geoUrl, {
        headers: { "User-Agent": "CNS-CourierNavigatorSystem/1.0 (contact@yourdomain.com)" },
      });
      const geoData = await geoRes.json();
      if (geoData?.[0]) {
        const lat = parseFloat(geoData[0].lat);
        const lng = parseFloat(geoData[0].lon);
        coordinates = { lat, lng };
        Business.findByIdAndUpdate(business._id, {
          "coordinates.lat": lat,
          "coordinates.lng": lng,
        }).catch(() => {});
      }
    } catch (_) {}
  }

  const detailedBusiness = {
    id: business._id,
    name: business.name,
    address: business.address,
    type: business.type,
    totalContributions: business.totalContributions,
    isVerified: business.isVerified,
    coordinates,
    entryPin: business.entryPin ?? null,
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
 * @desc  Upsert a global (externally sourced) business into the local CNS
 *        database and stamp its courier entry pin in one atomic operation.
 *
 *        Called when a courier opens a "global" search result and drops an
 *        entry pin for the first time. After this call the business becomes
 *        a first-class local record with a real MongoDB _id, and subsequent
 *        pin edits use the normal PATCH /api/businesses/:id/entry-pin route.
 *
 * @route POST /api/businesses/from-global
 * @access Public (community editable)
 *
 * Body:
 *   placeId      string              (required) external place identifier
 *   name         string              (required)
 *   address      string              (required)
 *   type         string              'Mall' | 'Standalone' | 'Other'
 *   source       string              'nominatim' | 'manual' | 'foursquare'
 *   coordinates  { lat, lng } | null
 *   entryPin     { lat, lng, label, updatedBy }   (required)
 *
 * Response: the full Business document (201 on insert, 200 on update)
 */
const createFromGlobal = asyncHandler(async (req, res) => {
  const {
    placeId,
    name,
    address,
    type,
    source,
    coordinates,
    entryPin,
  } = req.body;

  // ── Validate ─────────────────────────────────────────────────────────────
  if (!placeId || typeof placeId !== "string" || !placeId.trim()) {
    res.status(400);
    throw new Error("placeId is required");
  }
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400);
    throw new Error("name is required");
  }
  if (!address || typeof address !== "string" || !address.trim()) {
    res.status(400);
    throw new Error("address is required");
  }
  if (!entryPin || entryPin.lat == null || entryPin.lng == null) {
    res.status(400);
    throw new Error("entryPin with lat/lng is required");
  }
  if (typeof entryPin.lat !== "number" || typeof entryPin.lng !== "number") {
    res.status(400);
    throw new Error("entryPin lat and lng must be numbers");
  }

  const validTypes = ["Mall", "Standalone", "Other"];
  const safeType = validTypes.includes(type) ? type : "Other";

  const validSources = ["manual", "foursquare", "nominatim"];
  const safeSource = validSources.includes(source) ? source : "nominatim";

  // ── Build entryPin subdoc ─────────────────────────────────────────────────
  const pinDoc = {
    lat: entryPin.lat,
    lng: entryPin.lng,
    label: (entryPin.label || "Courier Entry").trim().slice(0, 80),
    updatedBy: (entryPin.updatedBy || "Anonymous Courier").trim().slice(0, 60),
    updatedAt: new Date(),
  };

  // ── Coordinates ───────────────────────────────────────────────────────────
  const coordsDoc =
    coordinates?.lat != null && coordinates?.lng != null
      ? { lat: coordinates.lat, lng: coordinates.lng }
      : { lat: null, lng: null };

  // ── Upsert by placeId ─────────────────────────────────────────────────────
  // $setOnInsert fires only when a new document is created.
  // $set fires on both insert and update — always refreshes pin + coords.
  let wasInserted = false;
  try {
    const doc = await Business.findOneAndUpdate(
      { placeId: placeId.trim() },
      {
        $setOnInsert: {
          name: name.trim(),
          address: address.trim(),
          type: safeType,
          source: safeSource,
          totalContributions: 0,
          isVerified: false,
          tags: [],
          contributions: [],
        },
        $set: {
          entryPin: pinDoc,
          coordinates: coordsDoc,
        },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        // rawResult lets us detect whether it was an insert or an update
        includeResultMetadata: true,
      },
    );

    // Mongoose returns { value: doc, lastErrorObject: { updatedExisting } }
    // when includeResultMetadata is true
    const business = doc.value ?? doc;
    wasInserted = doc.lastErrorObject
      ? !doc.lastErrorObject.updatedExisting
      : false;

    console.log(
      `[from-global] ${wasInserted ? "✨ Created" : "🔄 Updated"} business` +
      ` "${business.name}" (placeId: ${placeId})`
    );

    return res.status(wasInserted ? 201 : 200).json(business);
  } catch (err) {
    // Race condition: two requests upserted simultaneously → duplicate key
    if (err.code === 11000) {
      console.log(`[from-global] Duplicate key race — fetching existing record`);
      const existing = await Business.findOne({ placeId: placeId.trim() });
      if (existing) {
        // Still apply the pin to whichever doc won the race
        existing.entryPin = pinDoc;
        existing.coordinates = coordsDoc;
        await existing.save();
        return res.status(200).json(existing);
      }
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

/**
 * Builds a list of progressively simplified address strings to try with Nominatim.
 */
function buildAddressVariants(address) {
  const variants = [address];

  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);

  if (/shopping\s*cent(re|er)|mall|plaza|arcade|centre/i.test(parts[0])) {
    variants.push(parts.slice(1).join(", "));
  }

  const stripped = address
    .replace(/^(unit|shop|suite|level|lot|apt|apartment|flat|kiosk)\s*[\w\/-]+[,\s]*/i, "")
    .trim();
  if (stripped && stripped !== address) variants.push(stripped);

  const noNumber = stripped.replace(/^\d+[\w/-]*\s*/, "").trim();
  if (noNumber && noNumber !== stripped) variants.push(noNumber);

  const noKiosk = stripped.replace(/^[A-Z]\d+\//, "").trim();
  if (noKiosk && noKiosk !== stripped) variants.push(noKiosk);

  if (parts.length > 2) {
    variants.push(parts.slice(-2).join(", "));
    const streetPart = parts.find((p) =>
      /\d/.test(p) && !/^[A-Z]-?\d/.test(p)
    );
    if (streetPart) {
      variants.push([streetPart, ...parts.slice(-2)].join(", "));
    }
  }

  const roadMatch = address.match(/([A-Za-z\s]+ Rd|[A-Za-z\s]+ St|[A-Za-z\s]+ Ave)/i);
  if (roadMatch) {
    variants.push(`${roadMatch[0].trim()}, ${parts[parts.length - 2]}, ${parts[parts.length - 1]}`);
  }

  return [...new Set(variants.filter(Boolean))];
}

/**
 * @desc  One-time admin utility — backfills coordinates for all businesses
 * @route GET /api/businesses/admin/backfill-coordinates?secret=cns-backfill-2024
 * @access Admin only
 */
const backfillCoordinates = async (req, res) => {
  if (req.query.secret !== "cns-backfill-2024") {
    return res.status(403).json({ message: "Forbidden — wrong secret" });
  }

  const allBusinesses = await Business.find({}).select("_id name address coordinates");

  const businesses = allBusinesses.filter((b) => {
    const lat = b.coordinates?.lat;
    const lng = b.coordinates?.lng;
    return !lat || !lng || lat === 0 || lng === 0;
  });

  console.log(`[Backfill] Total in DB: ${allBusinesses.length} | Need coords: ${businesses.length}`);

  const results = {
    totalInDB: allBusinesses.length,
    totalNeedingCoords: businesses.length,
    success: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };

  for (let i = 0; i < businesses.length; i++) {
    const b = businesses[i];

    const fresh = await Business.findById(b._id).select("coordinates");
    const freshLat = fresh?.coordinates?.lat;
    const isCityLevelOnly =
      freshLat != null &&
      results.details.some(
        (d) => d.name === b.name && d.usedVariant && d.usedVariant.split(",").length <= 2
      );
    if (freshLat != null && !isCityLevelOnly) {
      results.skipped++;
      results.details.push({ name: b.name, status: "skipped" });
      continue;
    }

    try {
      const addressVariants = buildAddressVariants(b.address);

      let found = false;
      for (const variant of addressVariants) {
        const url =
          `https://nominatim.openstreetmap.org/search` +
          `?q=${encodeURIComponent(variant)}&format=json&limit=1`;

        const geoRes = await fetch(url, {
          headers: {
            "User-Agent": "CNS-CourierNavigatorSystem/1.0 (contact@yourdomain.com)",
            "Accept-Language": "en",
          },
        });
        const geoData = await geoRes.json();

        if (geoData?.[0]) {
          const lat = parseFloat(geoData[0].lat);
          const lng = parseFloat(geoData[0].lon);
          await Business.findByIdAndUpdate(b._id, {
            "coordinates.lat": lat,
            "coordinates.lng": lng,
          });
          results.success++;
          results.details.push({ name: b.name, status: "ok", lat, lng, usedVariant: variant });
          console.log(`[Backfill] ✓ ${i + 1}/${businesses.length} — ${b.name} (via: "${variant}")`);
          found = true;
          break;
        }

        await new Promise((r) => setTimeout(r, 1100));
      }

      if (!found) {
        results.failed++;
        results.details.push({ name: b.name, address: b.address, status: "not found" });
        console.log(`[Backfill] ✗ ${i + 1}/${businesses.length} — ${b.name} (not found)`);
      }
    } catch (err) {
      results.failed++;
      results.details.push({ name: b.name, status: "error", error: err.message });
      console.log(`[Backfill] ✗ ${i + 1}/${businesses.length} — ${b.name} (${err.message})`);
    }

    if (i < businesses.length - 1) {
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  console.log(
    `[Backfill] Done — success:${results.success} failed:${results.failed} skipped:${results.skipped}`
  );
  return res.status(200).json(results);
};

module.exports = {
  searchFoursquarePlaces,
  reverseGeocode,
  getBusinesses,
  getBusinessDetails,
  createBusiness,
  createFromGlobal,
  updateEntryPin,
  backfillCoordinates,
};
