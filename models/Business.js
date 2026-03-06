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

        // ── Foursquare integration ──────────────────────────────────────────
        // Unique Foursquare place ID. sparse=true means documents without a
        // placeId (manually created businesses) are excluded from the unique
        // index so they don't conflict with each other.
        placeId: {
            type: String,
            default: null,
            sparse: true,
            unique: true,
        },
        // 'manual'     → created directly by a user inside the app
        // 'foursquare' → auto-created when a Foursquare result is picked and
        //                the user submits their first instruction
        source: {
            type: String,
            enum: ['manual', 'foursquare'],
            default: 'manual',
        },
        // ───────────────────────────────────────────────────────────────────

        contributions: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Instruction',
            },
        ],
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model('Business', businessSchema);
