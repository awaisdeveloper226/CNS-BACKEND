// backend/models/Instruction.js

const mongoose = require('mongoose');

// Schema for tracking which users have voted and how (Required for Section 5.3 integrity)
const UserVoteSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    voteType: {
        type: String,
        enum: ['like', 'dislike'],
        required: true,
    },
}, { _id: false }); // Do not generate an ID for subdocuments

const InstructionSchema = new mongoose.Schema({
    business: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Business',
        required: true,
    },
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    notes: {
        type: String,
        required: false, // CHANGED: Made optional since audio can replace text
    },
    // NEW: Audio instruction URL
    audioUrl: {
        type: String,
        required: false,
    },
    // NEW: Audio duration in seconds
    audioDuration: {
        type: Number,
        required: false,
    },
    type: {
        type: String,
        enum: ['Courier/Parcel Delivery', 'Food Delivery', 'Both'],
        required: true,
    },
    category: {
        type: String,
        enum: [
            'Parking / Entry Points',
            'Navigation to Store Inside Mall',
            'Delivery Procedure',
            'Food Delivery Instructions',
            'Courier/Parcel Delivery Instructions',
        ],
        required: false,
    },
    photos: {
        type: [String], // URLs for images
        default: [],
    },
    videos: {
        type: [String], // URLs for videos (optional)
        default: [],
    },
    
    // --- Rating System (Section 5.3) ---
    likes: {
        type: Number,
        default: 0,
    },
    dislikes: {
        type: Number,
        default: 0,
    },
    
    // Array to prevent duplicate voting and track user's vote history
    votedUsers: {
        type: [UserVoteSchema], 
        default: [],
    },
    
    tags: {
        type: [String], // Array of strings
        default: [],
    },
    
    // Optional field to link official verified instructions (Section 6.1)
    isVerifiedBusinessInstruction: {
        type: Boolean,
        default: false,
    },

}, {
    timestamps: true,
});

// Create a compound index to ensure a user can only vote on a specific instruction once
InstructionSchema.index({ 'votedUsers.user': 1 }, { unique: false, sparse: true });

// NEW: Custom validation - ensure either notes OR audioUrl is provided
InstructionSchema.pre('validate', function(next) {
    if (!this.notes && !this.audioUrl) {
        next(new Error('Either notes or audioUrl must be provided'));
    } else {
        next();
    }
});

module.exports = mongoose.model('Instruction', InstructionSchema);
