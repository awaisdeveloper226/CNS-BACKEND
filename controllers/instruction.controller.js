// backend/controllers/instruction.controller.js

const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Instruction = require('../models/Instruction');
const Business = require('../models/Business');
const User = require('../models/User');

/* =========================================
   GET INSTRUCTIONS FOR A BUSINESS
   ========================================= */
const getInstructionsByBusiness = asyncHandler(async (req, res) => {
    const { businessId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(businessId)) {
        res.status(400);
        throw new Error('Invalid business ID');
    }

    const instructions = await Instruction.find({ business: businessId })
        .populate('user', 'name level')
        .sort({ createdAt: -1 });

    res.status(200).json(
        instructions.map(i => ({
            id: i._id.toString(),
            userId: i.user?._id,
            userName: i.user?.name || 'Anonymous',
            userLevel: i.user?.level || 1,
            notes: i.notes,
            audioUrl: i.audioUrl, // Include audio URL
            audioDuration: i.audioDuration, // FIX: Include audio duration
            type: i.type,
            category: i.category,
            photos: i.photos,
            videos: i.videos,
            likes: i.likes,
            dislikes: i.dislikes,
            tags: i.tags,
            votedUsers: i.votedUsers.map(v => ({
                userId: v.user.toString(),
                voteType: v.voteType,
            })),
            timestamp: i.createdAt,
        }))
    );
});

/* =========================================
   GET SINGLE INSTRUCTION BY ID
   ========================================= */
const getInstructionById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400);
        throw new Error('Invalid instruction ID');
    }

    const instruction = await Instruction.findById(id)
        .populate('user', 'name level');

    if (!instruction) {
        res.status(404);
        throw new Error('Instruction not found');
    }

    res.status(200).json({
        id: instruction._id.toString(),
        userId: instruction.user?._id,
        userName: instruction.user?.name || 'Anonymous',
        userLevel: instruction.user?.level || 1,
        notes: instruction.notes,
        audioUrl: instruction.audioUrl, // Include audio URL
        audioDuration: instruction.audioDuration, // FIX: Include audio duration
        type: instruction.type,
        category: instruction.category,
        photos: instruction.photos,
        videos: instruction.videos,
        likes: instruction.likes,
        dislikes: instruction.dislikes,
        tags: instruction.tags,
        votedUsers: instruction.votedUsers.map(v => ({
            userId: v.user.toString(),
            voteType: v.voteType,
        })),
        timestamp: instruction.createdAt,
    });
});

/* =========================================
   CREATE INSTRUCTION
   ========================================= */
const createInstruction = asyncHandler(async (req, res) => {
    const { businessId, notes, audioUrl, audioDuration, type, category, tags, photos = [], videos = [] } = req.body;
    const userId = req.user._id;

    // UPDATED: Validate required fields
    if (!businessId || !type || !category) {
        res.status(400);
        throw new Error('Missing required fields: businessId, type, and category are required');
    }

    // UPDATED: Ensure either notes OR audioUrl is provided
    if (!notes && !audioUrl) {
        res.status(400);
        throw new Error('Either notes or audioUrl must be provided');
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const [instruction] = await Instruction.create(
            [{
                business: businessId,
                user: userId,
                notes: notes || '', // Provide empty string if not present
                audioUrl: audioUrl || null, // Include audio URL
                audioDuration: audioDuration || null, // FIX: Include audio duration
                type,
                category,
                tags,
                photos,
                videos,
            }],
            { session }
        );

        await Business.findByIdAndUpdate(
            businessId,
            {
                $inc: { totalContributions: 1 },
                $push: { contributions: instruction._id },
            },
            { session }
        );

        await User.findByIdAndUpdate(
            userId,
            { $inc: { contributions: 1 } },
            { session }
        );

        await session.commitTransaction();
        session.endSession();

        res.status(201).json(instruction);
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        res.status(400);
        throw new Error(error.message);
    }
});

/* =========================================
   LIKE / DISLIKE HANDLER
   ========================================= */
const handleVote = async (req, res, voteAction) => {
    const instructionId = req.params.id;
    const userId = req.user._id;
    const isLike = voteAction === 'like';
    const opposite = isLike ? 'dislike' : 'like';

    if (!mongoose.Types.ObjectId.isValid(instructionId)) {
        res.status(400);
        throw new Error('Invalid instruction ID');
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const instruction = await Instruction.findById(instructionId).session(session);

        if (!instruction) {
            res.status(404);
            throw new Error('Instruction not found');
        }

        const voteIndex = instruction.votedUsers.findIndex(v =>
            v.user.equals(userId)
        );

        let update = {};
        let userUpdate = {};

        if (voteIndex === -1) {
            update = {
                $inc: { [voteAction + 's']: 1 },
                $push: { votedUsers: { user: userId, voteType: voteAction } },
            };
            if (isLike) userUpdate = { $inc: { totalLikesReceived: 1 } };
        } else if (instruction.votedUsers[voteIndex].voteType === voteAction) {
            await session.abortTransaction();
            session.endSession();
            return res.status(200).json({ message: 'Already voted' });
        } else {
            update = {
                $inc: {
                    [voteAction + 's']: 1,
                    [opposite + 's']: -1,
                },
                $set: { [`votedUsers.${voteIndex}.voteType`]: voteAction },
            };

            userUpdate = isLike
                ? { $inc: { totalLikesReceived: 1 } }
                : { $inc: { totalLikesReceived: -1 } };
        }

        const updated = await Instruction.findByIdAndUpdate(
            instructionId,
            update,
            { new: true, session }
        );

        if (Object.keys(userUpdate).length) {
            await User.findByIdAndUpdate(updated.user, userUpdate, { session });
        }

        await session.commitTransaction();
        session.endSession();

        res.status(200).json({
            id: updated._id.toString(),
            likes: updated.likes,
            dislikes: updated.dislikes,
            votedUsers: updated.votedUsers.map(v => ({
                userId: v.user.toString(),
                voteType: v.voteType,
            })),
        });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        res.status(400);
        throw new Error(error.message);
    }
};

const likeInstruction = (req, res) => handleVote(req, res, 'like');
const dislikeInstruction = (req, res) => handleVote(req, res, 'dislike');

module.exports = {
    getInstructionsByBusiness,
    getInstructionById,
    createInstruction,
    likeInstruction,
    dislikeInstruction,
};
