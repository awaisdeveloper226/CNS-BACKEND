// backend/routes/businesses.js  (add this route alongside your existing ones)
//
// POST /api/businesses/from-global
//
// Called when a user drops a courier entry pin on a globally-searched business
// for the first time. It upserts a local Business record (keyed on placeId) and
// saves the entry pin in one atomic operation.
//
// Body:
//   placeId      string   (required) — Nominatim / external place identifier
//   name         string   (required)
//   address      string   (required)
//   type         string   'Mall' | 'Standalone' | 'Other'   (default 'Other')
//   source       string   'nominatim' | 'manual' | 'foursquare'  (default 'nominatim')
//   coordinates  { lat, lng } | null
//   entryPin     { lat, lng, label, updatedBy }   (required — why we're here)
//
// Response: the full Business document (201 on insert, 200 on update)

const express = require("express");
const router = express.Router();
const Business = require("../models/Business");

// ── Existing routes live above / below this block ────────────────────────────

/**
 * POST /api/businesses/from-global
 *
 * Upsert a business by placeId, then stamp the entryPin.
 * Uses findOneAndUpdate with upsert:true so concurrent requests are safe.
 */
router.post("/from-global", async (req, res) => {
  try {
    const {
      placeId,
      name,
      address,
      type = "Other",
      source = "nominatim",
      coordinates = null,
      entryPin,
    } = req.body;

    // ── Validate required fields ─────────────────────────────────────────────
    if (!placeId || typeof placeId !== "string" || !placeId.trim()) {
      return res.status(400).json({ message: "placeId is required" });
    }
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ message: "name is required" });
    }
    if (!address || typeof address !== "string" || !address.trim()) {
      return res.status(400).json({ message: "address is required" });
    }
    if (!entryPin || entryPin.lat == null || entryPin.lng == null) {
      return res
        .status(400)
        .json({ message: "entryPin with lat/lng is required" });
    }

    const validTypes = ["Mall", "Standalone", "Other"];
    const safeType = validTypes.includes(type) ? type : "Other";

    const validSources = ["manual", "foursquare", "nominatim"];
    const safeSource = validSources.includes(source) ? source : "nominatim";

    // ── Build the entryPin subdoc ────────────────────────────────────────────
    const pinDoc = {
      lat: entryPin.lat,
      lng: entryPin.lng,
      label: (entryPin.label || "Courier Entry").trim().slice(0, 80),
      updatedBy: (entryPin.updatedBy || "Anonymous Courier").trim().slice(0, 80),
      updatedAt: new Date(),
    };

    // ── Upsert ───────────────────────────────────────────────────────────────
    // $setOnInsert only fires when a new doc is created (insert path).
    // $set fires on both insert and update — always refreshes pin + coords.
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
          ...(coordinates?.lat != null && coordinates?.lng != null
            ? { coordinates: { lat: coordinates.lat, lng: coordinates.lng } }
            : {}),
        },
      },
      {
        new: true,          // return the updated/inserted document
        upsert: true,       // create if not found
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    // 201 if the document was just created, 200 if it already existed
    const statusCode = doc.createdAt?.getTime() === doc.updatedAt?.getTime()
      ? 201
      : 200;

    return res.status(statusCode).json(doc);
  } catch (err) {
    console.error("[POST /businesses/from-global]", err);

    // Duplicate key on placeId means two requests raced; retry by fetching
    if (err.code === 11000) {
      try {
        const existing = await Business.findOne({ placeId: req.body.placeId });
        if (existing) return res.status(200).json(existing);
      } catch (_) {}
    }

    return res.status(500).json({ message: err.message || "Server error" });
  }
});

module.exports = router;


