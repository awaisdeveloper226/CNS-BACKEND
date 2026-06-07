// backend/models/Instruction.js
const mongoose = require('mongoose');

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
}, { _id: false });

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
        required: false,
    },
    audioUrl: {
        type: String,
        required: false,
    },
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
        type: [String],
        default: [],
    },
    videos: {
        type: [String],
        default: [],
    },
    likes: {
        type: Number,
        default: 0,
    },
    dislikes: {
        type: Number,
        default: 0,
    },
    votedUsers: {
        type: [UserVoteSchema],
        default: [],
    },
    tags: {
        type: [String],
        default: [],
    },
    // ── Owner / source label ───────────────────────────────────────────────
    // true  → uploader claimed to be the business owner → "Business Owner" badge
    // false → regular courier submission → "From Courier" label
    isVerifiedBusinessInstruction: {
        type: Boolean,
        default: false,
    },
}, {
    timestamps: true,
});

InstructionSchema.index({ 'votedUsers.user': 1 }, { unique: false, sparse: true });

InstructionSchema.pre('validate', function(next) {
    if (!this.notes && !this.audioUrl) {
        next(new Error('Either notes or audioUrl must be provided'));
    } else {
        next();
    }
});

module.exports = mongoose.model('Instruction', InstructionSchema);
