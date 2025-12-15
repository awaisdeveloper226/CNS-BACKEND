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
            enum: ['Mall', 'Standalone'],
            required: true,
        },
        coordinates: { // Section 8.1
            lat: { type: Number, required: true },
            lng: { type: Number, required: true },
        },
        totalContributions: { // Section 8.1 (Crowdsourcing metric)
            type: Number,
            default: 0,
        },
        isVerified: { // Section 6.1 (Verification status)
            type: Boolean,
            default: false,
        },
        tags: [String], // Section 4.1, 8.1
        
        // CRITICAL FIX: ADD THIS FIELD TO ENABLE POPULATION
        contributions: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'Instruction', // Reference the Instruction model
            },
        ],
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model('Business', businessSchema);