// controllers/business.controller.js

const asyncHandler = require("express-async-handler");
const Business = require("../models/Business");
const Instruction = require("../models/Instruction");
const Comment = require("../models/Comment");
const User = require("../models/User");

const GOOGLE_API_KEY = process.env.GOOGLE_AHMED_KEY_FOR_GEOCODING;
const GOOGLE_AHMED_KEY_FOR_GEOCODING = process.env.GOOGLE_AHMED_KEY_FOR_GEOCODING;
const ROUTING_API = process.env.ROUTING_API;
const MAX_HISTORY = 5;

const normaliseSource = (raw) => {
  const VALID = ["manual", "foursquare", "nominatim"];
  return VALID.includes(raw) ? raw : "nominatim";
};

// ══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY CACHE + IN-FLIGHT REQUEST DEDUP
// ══════════════════════════════════════════════════════════════════════════════

const _caches = new Map();
const _inFlight = new Map();

function _getCache(name) {
  if (!_caches.has(name)) _caches.set(name, new Map());
  return _caches.get(name);
}

function cacheGet(name, key) {
  const cache = _getCache(name);
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(name, key, value, ttlMs) {
  const cache = _getCache(name);
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now > v.expiresAt) cache.delete(k);
    }
  }
}

function cacheDelete(name, key) {
  _getCache(name).delete(key);
}

function cacheDeleteByPrefix(name, prefix) {
  const cache = _getCache(name);
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

async function dedupeInFlight(cacheName, key, fn) {
  const flightKey = `${cacheName}:${key}`;
  if (_inFlight.has(flightKey)) return _inFlight.get(flightKey);
  const promise = (async () => {
    try {
      return await fn();
    } finally {
      _inFlight.delete(flightKey);
    }
  })();
  _inFlight.set(flightKey, promise);
  return promise;
}

function normaliseQueryKey(q) {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

function roundCoord(n) {
  return Math.round(n * 1000) / 1000;
}

// ── Haversine distance helper ─────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLng = (lng2 - lng1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLng / 2) ** 2;
  return Math.round(6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

const PLACES_SEARCH_TTL_MS    = 15 * 60 * 1000; // 15 minutes
const NEARBY_TTL_MS           = 10 * 60 * 1000; // 10 minutes
const REVERSE_GEOCODE_TTL_MS  = 24 * 60 * 60 * 1000; // 24 hours
const BUSINESS_DETAIL_TTL_MS  = 45 * 1000;      // 45 seconds
const BUSINESS_LIST_TTL_MS    = 30 * 1000;      // 30 seconds

// Escapes regex special characters so a user typing "f-9" or "(abc)" doesn't
// throw or behave unexpectedly when used inside a $regex.
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ══════════════════════════════════════════════════════════════════════════════
// PLACES SEARCH (Google Text Search)
// ══════════════════════════════════════════════════════════════════════════════
const searchFoursquarePlaces = asyncHandler(async (req, res) => {
  const { q, lat, lng } = req.query;

  if (!q || !q.trim()) {
    return res.status(400).json({ message: "Query parameter 'q' is required" });
  }

  const query = q.trim();
  console.log(
    "🔍 Google Places search:",
    query,
    lat && lng ? `(bias ${lat},${lng})` : "(no bias)"
  );

  if (!GOOGLE_API_KEY) {
    console.error("❌ Google Places API key missing");
    return res.status(500).json({ message: "Server configuration error: Missing API Key" });
  }

  let parsedLat = null;
  let parsedLng = null;
  if (lat && lng) {
    const pl = parseFloat(lat);
    const pn = parseFloat(lng);
    if (!isNaN(pl) && !isNaN(pn)) {
      parsedLat = pl;
      parsedLng = pn;
    }
  }

  const BIAS_RADIUS_METERS = 50000.0; // 50km soft bias — Google ranks nearby higher

  const cacheKey =
    normaliseQueryKey(query) +
    (parsedLat !== null && parsedLng !== null
      ? `|${roundCoord(parsedLat)},${roundCoord(parsedLng)}`
      : "|nobias");

  const cached = cacheGet("placesSearch", cacheKey);
  if (cached !== undefined) {
    console.log("✅ Places cache hit:", query);
    return res.status(200).json(cached);
  }

  try {
    const results = await dedupeInFlight("placesSearch", cacheKey, async () => {
      const requestBody = {
        textQuery: query,
        languageCode: "en",
        pageSize: 20,
      };

      if (parsedLat !== null && parsedLng !== null) {
        requestBody.locationBias = {
          circle: {
            center: { latitude: parsedLat, longitude: parsedLng },
            radius: BIAS_RADIUS_METERS,
          },
        };
      }

      const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_API_KEY,
          "X-Goog-FieldMask":
            "places.id,places.displayName,places.formattedAddress,places.location,places.types",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`❌ Google Places error ${response.status}:`, errText);
        const err = new Error("Global place search failed");
        err.statusCode = 502;
        err.detail = errText;
        throw err;
      }

      const data = await response.json();
      const places = data.places || [];
      console.log(`✅ Google Places: ${places.length} results (no hard filter)`);

      const mapped = places.map((place) => {
        const rLat = place.location?.latitude ?? null;
        const rLng = place.location?.longitude ?? null;
        const _distanceKm =
          parsedLat !== null && parsedLng !== null && rLat !== null && rLng !== null
            ? haversineKm(parsedLat, parsedLng, rLat, rLng)
            : null;

        return {
          placeId: place.id,
          name: place.displayName?.text || "Unknown Name",
          address: place.formattedAddress || "Address not available",
          source: "google",
          type: "Standalone",
          totalContributions: 0,
          isVerified: false,
          lat: rLat,
          lng: rLng,
          _distanceKm,
        };
      });

      cacheSet("placesSearch", cacheKey, mapped, PLACES_SEARCH_TTL_MS);
      return mapped;
    });

    return res.status(200).json(results);
  } catch (error) {
    if (error.statusCode === 502) {
      return res.status(502).json({ message: "Global place search failed", detail: error.detail });
    }
    console.error("❌ Google Places fetch error:", error);
    return res.status(502).json({ message: "Place search service error" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// REVERSE GEOCODE
// ══════════════════════════════════════════════════════════════════════════════
const reverseGeocode = asyncHandler(async (req, res) => {
  const { lat, lng } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ message: "lat and lng query params are required" });
  }

  console.log(`[Geocode] lat=${lat}, lng=${lng}`);

  const cacheKey = `${roundCoord(parseFloat(lat) * 10) / 10},${roundCoord(parseFloat(lng) * 10) / 10}`;
  const cached = cacheGet("reverseGeocode", cacheKey);
  if (cached !== undefined) {
    console.log("✅ Reverse geocode cache hit:", cacheKey);
    return res.status(200).json(cached);
  }

  const result = await dedupeInFlight("reverseGeocode", cacheKey, async () => {
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
      } catch {
        // non-fatal
      }

      const payload = { ...geocodeData, nearbyName };
      if (geocodeData.status === "OK") {
        cacheSet("reverseGeocode", cacheKey, payload, REVERSE_GEOCODE_TTL_MS);
      }
      return { payload, status: 200 };
    }

    // Nominatim fallback
    try {
      const url =
        `https://nominatim.openstreetmap.org/reverse` +
        `?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;

      const nominatimRes = await fetch(url, {
        headers: {
          "User-Agent": "CNS-CourierNavigatorSystem/1.0 (contact@yourdomain.com)",
          "Accept-Language": "en",
        },
      });

      if (!nominatimRes.ok) return { payload: { message: "Reverse geocode failed" }, status: 502 };

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

      const payload = {
        status: "OK",
        results: [
          {
            formatted_address: formatted,
            geometry: { location: { lat: parseFloat(lat), lng: parseFloat(lng) } },
          },
        ],
        nearbyName: data.name || data.display_name?.split(",")[0] || null,
        _source: "nominatim",
      };

      cacheSet("reverseGeocode", cacheKey, payload, REVERSE_GEOCODE_TTL_MS);
      return { payload, status: 200 };
    } catch (error) {
      console.error("❌ Nominatim reverse geocode error:", error);
      return { payload: { message: "Reverse geocode service error" }, status: 502 };
    }
  });

  return res.status(result.status).json(result.payload);
});

// ══════════════════════════════════════════════════════════════════════════════
// GET ALL BUSINESSES  —  TEXT-INDEX SEARCH (fast path) + regex fallback
// ──────────────────────────────────────────────────────────────────────────────
// CHANGES (this revision):
//   • PRIMARY PATH: uses MongoDB's $text operator against the
//     `BusinessTextIndex` (name/address/tags, weighted). $text is indexed —
//     it does NOT scan every document — so this is the fix for the 3-5s
//     delay. It also gives us a real relevance score (textScore) for free,
//     and naturally handles multi-word queries as "match as many terms as
//     possible, rank by how well they matched" rather than all-or-nothing.
//
//   • FALLBACK PATH: $text only matches whole stemmed words, so short
//     in-progress queries (e.g. user has typed "che" for "cheezious") or
//     alphanumeric sector codes (e.g. "f9") won't match via $text yet.
//     For those cases — short queries, or queries containing alphanumeric
//     codes — we fall back to the previous regex-OR scan, which handles
//     partial/substring matching. This keeps autocomplete-as-you-type
//     working while using the fast indexed path whenever possible.
//
//   • NO MORE STRICT AND: a business missing one query word (e.g. has no
//     literal "Lahore" in its address) is no longer dropped outright — it's
//     ranked lower instead. This fixes "cheezious lahore" only returning a
//     single branch.
//
//   • REQUIRES the migration in the deployment notes to be run once:
//       db.businesses.createIndex(
//         { name: "text", address: "text", tags: "text" },
//         { weights: { name: 10, tags: 5, address: 3 }, name: "BusinessTextIndex" }
//       );
// ══════════════════════════════════════════════════════════════════════════════
const ALPHANUM_CODE_RE = /\b[a-z]\d+\b|\b\d+[a-z]\b/i;
const MIN_TEXT_SEARCH_LEN = 3; // below this, $text's word-stemming is unreliable

const getBusinesses = asyncHandler(async (req, res) => {
  const rawSearch = req.query.search ? req.query.search.trim() : "";
  const searchTerm = normaliseQueryKey(rawSearch);
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 0;
  const skip  = req.query.skip  ? parseInt(req.query.skip,  10) : 0;

  const cacheKey = searchTerm;

  let full = cacheGet("businessFullList", cacheKey);

  if (full === undefined) {
    full = await dedupeInFlight("businessFullList", cacheKey, async () => {
      const SELECT_FIELDS =
        "name address type totalContributions isVerified coordinates placeId tags entryPin";

      // ── No query: just return everything, sorted by contribution count ──
      if (!rawSearch) {
        const all = await Business.find({})
          .select(SELECT_FIELDS)
          .sort({ totalContributions: -1, _id: 1 })
          .lean();
        cacheSet("businessFullList", cacheKey, all, BUSINESS_LIST_TTL_MS);
        return all;
      }

      const searchTokens = rawSearch.split(/\s+/).filter((t) => t.length > 0);
      const needsRegexFallback =
        rawSearch.length < MIN_TEXT_SEARCH_LEN || ALPHANUM_CODE_RE.test(rawSearch);

      let textResults = [];
      let usedText = false;

      // ── FAST PATH: indexed $text search ──────────────────────────────
      if (!needsRegexFallback) {
        try {
          textResults = await Business.find(
            { $text: { $search: rawSearch } },
            { score: { $meta: "textScore" } }
          )
            .select(SELECT_FIELDS + " score")
            .sort({ score: { $meta: "textScore" } })
            .limit(200)
            .lean();
          usedText = true;
        } catch (err) {
          // If the text index hasn't been created yet (e.g. fresh DB before
          // migration runs), don't hard-fail search — just fall through to
          // the regex path below.
          console.error("⚠️ $text search failed, falling back to regex:", err.message);
          usedText = false;
        }
      }

      // If $text found a healthy number of results, use it directly —
      // it's already relevance-sorted via textScore.
      if (usedText && textResults.length > 0) {
        const all = textResults.map((b) => {
          const { score, ...rest } = b;
          return { ...rest, _matchScore: score };
        });
        cacheSet("businessFullList", cacheKey, all, BUSINESS_LIST_TTL_MS);
        return all;
      }

      // ── FALLBACK PATH: regex OR-scan ─────────────────────────────────
      // Used for short/in-progress queries, alphanumeric codes, or when
      // $text returns nothing (e.g. it found no stemmed-word matches but
      // a substring match still exists, like "cheez" mid-typing).
      const keyword = {
        $or: searchTokens.map((tok) => ({
          $or: [
            { name: { $regex: escapeRegex(tok), $options: "i" } },
            { address: { $regex: escapeRegex(tok), $options: "i" } },
            { tags: { $regex: escapeRegex(tok), $options: "i" } },
          ],
        })),
      };

      const all = await Business.find(keyword)
        .select(SELECT_FIELDS)
        .limit(200)
        .lean();

      // Score by how many of the query tokens actually matched — a
      // business missing just one word (e.g. no literal city name) still
      // shows up, ranked lower, instead of vanishing entirely.
      const lower = (s) => (s || "").toLowerCase();
      for (const b of all) {
        const haystack = `${lower(b.name)} ${lower(b.address)} ${(b.tags || []).join(" ").toLowerCase()}`;
        const matchedCount = searchTokens.filter((t) => haystack.includes(t.toLowerCase())).length;
        b._matchScore = matchedCount / searchTokens.length;
      }
      all.sort(
        (a, b) =>
          b._matchScore - a._matchScore ||
          b.totalContributions - a.totalContributions
      );

      cacheSet("businessFullList", cacheKey, all, BUSINESS_LIST_TTL_MS);
      return all;
    });
  } else {
    console.log("✅ Business list cache hit:", cacheKey || "(all)");
  }

  const total = full.length;
  const businesses = limit > 0 ? full.slice(skip, skip + limit) : full.slice(skip);

  res.status(200).json({ businesses, total });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET BUSINESS DETAILS
// ══════════════════════════════════════════════════════════════════════════════
const getBusinessDetails = asyncHandler(async (req, res) => {
  const businessId = req.params.id;

  const cached = cacheGet("businessDetail", businessId);
  if (cached !== undefined) {
    console.log("✅ Business detail cache hit:", businessId);
    return res.status(200).json(cached);
  }

  const detailedBusiness = await dedupeInFlight("businessDetail", businessId, async () => {
    const business = await Business.findById(businessId)
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
      const err = new Error("Business not found");
      err.statusCode = 404;
      throw err;
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

    const payload = {
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
        isVerifiedBusinessInstruction: instr.isVerifiedBusinessInstruction ?? false,
        votedUsers: (instr.votedUsers || []).map((vote) => ({
          userId: vote.user?.toString() || vote.user,
          voteType: vote.voteType,
        })),
        commentCount: commentCountMap[instr._id.toString()] || 0,
      })),
    };

    cacheSet("businessDetail", businessId, payload, BUSINESS_DETAIL_TTL_MS);
    return payload;
  }).catch((err) => {
    if (err.statusCode === 404) {
      res.status(404);
      throw new Error("Business not found");
    }
    throw err;
  });

  res.status(200).json(detailedBusiness);
});

// ══════════════════════════════════════════════════════════════════════════════
// CREATE BUSINESS
// ══════════════════════════════════════════════════════════════════════════════
const createBusiness = asyncHandler(async (req, res) => {
  const { name, address, type, courierType, placeId, source } = req.body;

  if (!name || !address) {
    res.status(400);
    throw new Error("Name and address are required");
  }

  if (placeId) {
    const existing = await Business.findOne({ placeId });
    if (existing) return res.status(200).json(existing);

    try {
      const business = await Business.create({
        name,
        address,
        type: type || "Standalone",
        source: normaliseSource(source),
        placeId,
        tags: courierType ? [courierType] : [],
        coordinates: {
          lat: req.body.lat ?? null,
          lng: req.body.lng ?? null,
        },
      });
      cacheDeleteByPrefix("businessFullList", "");
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
    throw new Error(`Invalid courier type. Must be one of: ${validCourierTypes.join(", ")}`);
  }

  const existing = await Business.findOne({ name, address });
  if (existing) return res.status(200).json(existing);

  try {
    const business = await Business.create({
      name,
      address,
      type,
      source: "manual",
      tags: [courierType],
    });
    cacheDeleteByPrefix("businessFullList", "");
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

// ══════════════════════════════════════════════════════════════════════════════
// CREATE FROM GLOBAL
// ══════════════════════════════════════════════════════════════════════════════
const createFromGlobal = asyncHandler(async (req, res) => {
  const { placeId, name, address, type, source, coordinates, entryPin } = req.body;

  if (!placeId || typeof placeId !== "string" || !placeId.trim()) {
    res.status(400); throw new Error("placeId is required");
  }
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400); throw new Error("name is required");
  }
  if (!address || typeof address !== "string" || !address.trim()) {
    res.status(400); throw new Error("address is required");
  }
  if (!entryPin || entryPin.lat == null || entryPin.lng == null) {
    res.status(400); throw new Error("entryPin with lat/lng is required");
  }
  if (typeof entryPin.lat !== "number" || typeof entryPin.lng !== "number") {
    res.status(400); throw new Error("entryPin lat and lng must be numbers");
  }

  const validTypes = ["Mall", "Standalone", "Other"];
  const safeType   = validTypes.includes(type) ? type : "Other";
  const safeSource = normaliseSource(source);

  const pinDoc = {
    lat: entryPin.lat,
    lng: entryPin.lng,
    label: (entryPin.label || "Courier Entry").trim().slice(0, 80),
    updatedBy: (entryPin.updatedBy || "Anonymous Courier").trim().slice(0, 60),
    updatedAt: new Date(),
  };

  const coordsDoc =
    coordinates?.lat != null && coordinates?.lng != null
      ? { lat: coordinates.lat, lng: coordinates.lng }
      : { lat: null, lng: null };

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
        $set: { entryPin: pinDoc, coordinates: coordsDoc },
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
        includeResultMetadata: true,
      }
    );

    const business   = doc.value ?? doc;
    const wasInserted = doc.lastErrorObject ? !doc.lastErrorObject.updatedExisting : false;

    console.log(
      `[from-global] ${wasInserted ? "✨ Created" : "🔄 Updated"} "${business.name}" (placeId: ${placeId})`
    );

    cacheDelete("businessDetail", String(business._id));
    cacheDeleteByPrefix("businessFullList", "");

    return res.status(wasInserted ? 201 : 200).json(business);
  } catch (err) {
    if (err.code === 11000) {
      const existing = await Business.findOne({ placeId: placeId.trim() });
      if (existing) {
        existing.entryPin   = pinDoc;
        existing.coordinates = coordsDoc;
        await existing.save();
        cacheDelete("businessDetail", String(existing._id));
        cacheDeleteByPrefix("businessFullList", "");
        return res.status(200).json(existing);
      }
    }
    throw err;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// UPDATE ENTRY PIN
// ══════════════════════════════════════════════════════════════════════════════
const updateEntryPin = asyncHandler(async (req, res) => {
  const { lat, lng, label, updatedBy } = req.body;
  const isClearing = lat === null && lng === null;

  if (!isClearing) {
    if (typeof lat !== "number" || typeof lng !== "number") {
      res.status(400); throw new Error("lat and lng must be numbers (or both null to clear)");
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      res.status(400); throw new Error("lat/lng out of valid range");
    }
  }

  const business = await Business.findById(req.params.id);
  if (!business) { res.status(404); throw new Error("Business not found"); }

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
  cacheDelete("businessDetail", String(business._id));

  res.status(200).json({
    message: isClearing ? "Entry pin cleared" : "Entry pin updated",
    entryPin: business.entryPin,
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// NEARBY BUSINESSES
// ══════════════════════════════════════════════════════════════════════════════
const getNearbyBusinesses = asyncHandler(async (req, res) => {
  const { lat, lng, limit } = req.query;

  if (!lat || !lng) return res.status(400).json({ message: "lat and lng are required" });

  const parsedLat   = parseFloat(lat);
  const parsedLng   = parseFloat(lng);
  const parsedLimit = Math.min(parseInt(limit, 10) || 8, 20);

  if (isNaN(parsedLat) || isNaN(parsedLng)) {
    return res.status(400).json({ message: "lat and lng must be valid numbers" });
  }
  if (!GOOGLE_API_KEY) {
    return res.status(500).json({ message: "Server configuration error: Missing API Key" });
  }

  const cacheKey = `${roundCoord(parsedLat * 10) / 10},${roundCoord(parsedLng * 10) / 10}|${parsedLimit}`;
  const cached   = cacheGet("nearbyBusinesses", cacheKey);
  if (cached !== undefined) {
    console.log("✅ Nearby cache hit:", cacheKey);
    return res.status(200).json(cached);
  }

  try {
    const results = await dedupeInFlight("nearbyBusinesses", cacheKey, async () => {
      const response = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_API_KEY,
          "X-Goog-FieldMask":
            "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.rating,places.businessStatus",
        },
        body: JSON.stringify({
          locationRestriction: {
            circle: {
              center: { latitude: parsedLat, longitude: parsedLng },
              radius: 1000.0,
            },
          },
          includedTypes: [
            "store", "restaurant", "shopping_mall", "supermarket", "pharmacy",
            "bank", "hospital", "gym", "cafe", "clothing_store", "convenience_store",
            "department_store", "electronics_store", "furniture_store",
            "home_goods_store", "jewelry_store", "shoe_store", "bakery",
            "fast_food_restaurant",
          ],
          maxResultCount: parsedLimit,
          languageCode: "en",
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`❌ Google Nearby error ${response.status}:`, errText);
        const err = new Error("Nearby search failed");
        err.statusCode = 502;
        throw err;
      }

      const data   = await response.json();
      const places = data.places || [];
      console.log(`✅ Google Nearby: ${places.length} results`);

      const mapped = places.map((place) => {
        const placeLat   = place.location?.latitude  ?? parsedLat;
        const placeLng   = place.location?.longitude ?? parsedLng;
        const distanceKm = haversineKm(parsedLat, parsedLng, placeLat, placeLng);

        return {
          placeId: place.id,
          name: place.displayName?.text || "Unknown",
          address: place.formattedAddress || "Address not available",
          source: "google",
          type: "Standalone",
          totalContributions: 0,
          isVerified: false,
          lat: placeLat,
          lng: placeLng,
          _distanceKm: distanceKm,
          _fromFoursquare: true,
        };
      });

      mapped.sort((a, b) => a._distanceKm - b._distanceKm);
      cacheSet("nearbyBusinesses", cacheKey, mapped, NEARBY_TTL_MS);
      return mapped;
    });

    return res.status(200).json(results);
  } catch (error) {
    if (error.statusCode === 502) {
      return res.status(502).json({ message: "Nearby search failed" });
    }
    console.error("❌ Google Nearby fetch error:", error);
    return res.status(502).json({ message: "Nearby search service error" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SEARCH HISTORY
// ══════════════════════════════════════════════════════════════════════════════
const getSearchHistory = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("searchHistory").lean();
  if (!user) { res.status(404); throw new Error("User not found"); }

  const history = (user.searchHistory ?? [])
    .sort((a, b) => new Date(b.searchedAt) - new Date(a.searchedAt))
    .slice(0, MAX_HISTORY)
    .map((h) => h.query);

  res.status(200).json({ history });
});

const addSearchHistory = asyncHandler(async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== "string" || !query.trim()) {
    res.status(400); throw new Error("query is required");
  }

  const trimmed = query.trim();

  await User.findByIdAndUpdate(req.user._id, {
    $pull: { searchHistory: { query: { $regex: `^${escapeRegex(trimmed)}$`, $options: "i" } } },
  });

  await User.findByIdAndUpdate(req.user._id, {
    $push: {
      searchHistory: {
        $each:  [{ query: trimmed, searchedAt: new Date() }],
        $sort:  { searchedAt: -1 },
        $slice: MAX_HISTORY,
      },
    },
  });

  res.status(200).json({ message: "Search history updated" });
});

// ══════════════════════════════════════════════════════════════════════════════
// BACKFILL COORDINATES (admin utility)
// ══════════════════════════════════════════════════════════════════════════════
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
    const streetPart = parts.find((p) => /\d/.test(p) && !/^[A-Z]-?\d/.test(p));
    if (streetPart) variants.push([streetPart, ...parts.slice(-2)].join(", "));
  }

  const roadMatch = address.match(/([A-Za-z\s]+ Rd|[A-Za-z\s]+ St|[A-Za-z\s]+ Ave)/i);
  if (roadMatch) {
    variants.push(`${roadMatch[0].trim()}, ${parts[parts.length - 2]}, ${parts[parts.length - 1]}`);
  }

  return [...new Set(variants.filter(Boolean))];
}

const backfillCoordinatesGoogle = async (req, res) => {
  if (req.query.secret !== "cns-backfill-2024") {
    return res.status(403).json({ message: "Forbidden — wrong secret" });
  }
  if (!GOOGLE_AHMED_KEY_FOR_GEOCODING) {
    return res.status(500).json({ message: "GOOGLE_AHMED_KEY_FOR_GEOCODING not set" });
  }

  console.log(`[Backfill] Key prefix: ${GOOGLE_AHMED_KEY_FOR_GEOCODING.slice(0, 8)}...`);

  try {
    const testUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=Sydney+Australia&key=${GOOGLE_AHMED_KEY_FOR_GEOCODING}`;
    const testRes  = await fetch(testUrl);
    const testData = await testRes.json();
    if (testData.status !== "OK") {
      return res.status(500).json({
        message: "API key test failed",
        status: testData.status,
        error_message: testData.error_message || null,
      });
    }
  } catch (err) {
    return res.status(500).json({ message: "Key test fetch failed", error: err.message });
  }

  const forceAll      = req.query.force === "true";
  const allBusinesses = await Business.find({}).select("_id name address coordinates");
  const businesses    = forceAll
    ? allBusinesses
    : allBusinesses.filter((b) => !b.coordinates?.lat || !b.coordinates?.lng);

  const results = {
    totalInDB: allBusinesses.length,
    toGeocode: businesses.length,
    success: 0,
    failed: 0,
    details: [],
  };

  for (let i = 0; i < businesses.length; i++) {
    const b = businesses[i];
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(b.address)}&key=${GOOGLE_AHMED_KEY_FOR_GEOCODING}`;
      const geoRes  = await fetch(url);
      const rawText = await geoRes.text();

      let geoData;
      try { geoData = JSON.parse(rawText); }
      catch { results.failed++; results.details.push({ name: b.name, status: "parse_error" }); continue; }

      if (geoData.status === "OK" && geoData.results?.[0]) {
        const loc = geoData.results[0].geometry.location;
        await Business.findByIdAndUpdate(b._id, {
          "coordinates.lat": loc.lat,
          "coordinates.lng": loc.lng,
        });
        results.success++;
        results.details.push({ name: b.name, status: "ok", lat: loc.lat, lng: loc.lng });
      } else {
        results.failed++;
        results.details.push({ name: b.name, address: b.address, status: "failed", reason: geoData.status });
      }
    } catch (err) {
      results.failed++;
      results.details.push({ name: b.name, status: "error", error: err.message });
    }
    if (i < businesses.length - 1) await new Promise((r) => setTimeout(r, 100));
  }

  return res.status(200).json(results);
};

// ══════════════════════════════════════════════════════════════════════════════
// PROXY DIRECTIONS
// ══════════════════════════════════════════════════════════════════════════════
const proxyDirections = asyncHandler(async (req, res) => {
  const { originLat, originLng, destLat, destLng } = req.body;

  if (!originLat || !originLng || !destLat || !destLng) {
    return res.status(400).json({ error: "originLat, originLng, destLat, destLng are required" });
  }

  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": ROUTING_API,
      "X-Goog-FieldMask": [
        "routes.duration",
        "routes.distanceMeters",
        "routes.polyline.encodedPolyline",
        "routes.legs.steps.navigationInstruction",
        "routes.legs.steps.distanceMeters",
        "routes.legs.steps.staticDuration",
        "routes.legs.steps.startLocation",
        "routes.legs.steps.endLocation",
        "routes.legs.distanceMeters",
        "routes.legs.duration",
      ].join(","),
    },
    body: JSON.stringify({
      origin:      { location: { latLng: { latitude: Number(originLat), longitude: Number(originLng) } } },
      destination: { location: { latLng: { latitude: Number(destLat),   longitude: Number(destLng)   } } },
      travelMode:              "DRIVE",
      routingPreference:       "TRAFFIC_AWARE",
      computeAlternativeRoutes: false,
      languageCode: "en-US",
      units: "METRIC",
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("[proxyDirections] Routes API error:", data);
    return res.status(response.status).json({ error: data.error?.message || "Routes API error" });
  }

  return res.status(200).json(data);
});

// ══════════════════════════════════════════════════════════════════════════════
// CACHE INVALIDATION HELPER (used by instruction.controller.js)
// ══════════════════════════════════════════════════════════════════════════════
function invalidateBusinessDetailCache(businessId) {
  if (!businessId) return;
  cacheDelete("businessDetail", String(businessId));
}

module.exports = {
  searchFoursquarePlaces,
  reverseGeocode,
  getBusinesses,
  getBusinessDetails,
  createBusiness,
  createFromGlobal,
  updateEntryPin,
  backfillCoordinatesGoogle,
  getSearchHistory,
  addSearchHistory,
  proxyDirections,
  getNearbyBusinesses,
  invalidateBusinessDetailCache,
};
