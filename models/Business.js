// backend/models/Business.js
const mongoose = require('mongoose');

const businessSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    address: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ['Mall', 'Standalone', 'Other'],
      required: true,
    },
    totalContributions: {
      type: Number,
      default: 0,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    tags: [String],

    placeId: {
      type: String,
      sparse: true,
      unique: true,
    },

    // 'manual' | 'foursquare' | 'nominatim'
    source: {
      type: String,
      enum: ['manual', 'foursquare', 'nominatim'],
      default: 'manual',
    },

    coordinates: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },

    // ── Courier entry pin ──────────────────────────────────────────────────
    // Community-editable pin: marks the exact courier entry point
    // (loading dock, delivery entrance, gate, etc.)
    entryPin: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      label: { type: String, trim: true, default: '' },
      updatedBy: { type: String, trim: true, default: '' }, // display name
      updatedAt: { type: Date, default: null },
    },
    // ───────────────────────────────────────────────────────────────────────

    contributions: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Instruction',
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Business', businessSchema);
