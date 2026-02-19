// backend/controllers/instruction.controller.js

const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Instruction = require('../models/Instruction');
const Business = require('../models/Business');
const User = require('../models/User');

/* =========================================
   GAMIFICATION HELPER - CALCULATE LEVEL
   ========================================= */
const calculateUserLevel = (totalContributions) => {
    // Define level thresholds based on contributions made
    if (totalContributions >= 100) return 10;
    if (totalContributions >= 50)  return 9;
    if (totalContributions >= 30)  return 8;
    if (totalContributions >= 20)  return 7;
    if (totalContributions >= 15)  return 6;
    if (totalContributions >= 10)  return 5;
    if (totalContributions >= 7)   return 4;
    if (totalContributions >= 5)   return 3;
    if (totalContributions >= 3)   return 2;
    return 1;
};

/* =========================================
   GAMIFICATION HELPER - GET BADGES FOR LEVEL
   ========================================= */
const getBadgesForLevel = (level) => {
    const badges = [];

    if (level >= 1)  badges.push('Rookie Courier');
    if (level >= 3)  badges.push('Expert Navigator');
    if (level >= 5)  badges.push('Local Guide');
    if (level >= 10) badges.push('Master Mapper');

    return badges;
};

/* =========================================
   GAMIFICATION HELPER - UPDATE USER LEVEL & BADGES
   ========================================= */
const updateUserLevelAndBadges = async (userId, session) => {
    const user = await User.findById(userId).session(session);

    if (!user) return;

    const oldLevel = user.level;
    const newLevel = calculateUserLevel(user.contributions || 0);

    if (newLevel !== oldLevel) {
        console.log(`🎉 Level up! User ${user.name} is now level ${newLevel} (was ${oldLevel})`);
        user.level = newLevel;

        const newBadges = getBadgesForLevel(newLevel);
        user.badges = newBadges;

        console.log(`🏆 Badges updated for ${user.name}:`, newBadges);

        await user.save({ session });
    }
};

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
            audioUrl: i.audioUrl,
            audioDuration: i.audioDuration,
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
        audioUrl: instruction.audioUrl,
        audioDuration: instruction.audioDuration,
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

    if (!businessId || !type || !category) {
        res.status(400);
        throw new Error('Missing required fields: businessId, type, and category are required');
    }

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
                notes: notes || '',
                audioUrl: audioUrl || null,
                audioDuration: audioDuration || null,
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

        // ✅ Check and update level & badges after contribution count increases
        await updateUserLevelAndBadges(userId, session);

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
   (No longer updates level/badges — that's contribution-based now)
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

        if (voteIndex === -1) {
            // New vote
            update = {
                $inc: { [voteAction + 's']: 1 },
                $push: { votedUsers: { user: userId, voteType: voteAction } },
            };
        } else if (instruction.votedUsers[voteIndex].voteType === voteAction) {
            // Already voted the same way
            await session.abortTransaction();
            session.endSession();
            return res.status(200).json({ message: 'Already voted' });
        } else {
            // Changing vote
            update = {
                $inc: {
                    [voteAction + 's']: 1,
                    [opposite + 's']: -1,
                },
                $set: { [`votedUsers.${voteIndex}.voteType`]: voteAction },
            };
        }

        const updated = await Instruction.findByIdAndUpdate(
            instructionId,
            update,
            { new: true, session }
        );

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
