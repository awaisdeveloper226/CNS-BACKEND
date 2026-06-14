// backend/controllers/instruction.controller.js

const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Instruction = require('../models/Instruction');
const Business = require('../models/Business');
const User = require('../models/User');
const Comment = require('../models/Comment');

const calculateUserLevel = (totalContributions) => {
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

const getBadgesForLevel = (level) => {
    const badges = [];
    if (level >= 1)  badges.push('Rookie Courier');
    if (level >= 3)  badges.push('Expert Navigator');
    if (level >= 5)  badges.push('Local Guide');
    if (level >= 10) badges.push('Master Mapper');
    return badges;
};

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

const getInstructionsByBusiness = asyncHandler(async (req, res) => {
    const { businessId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(businessId)) {
        res.status(400);
        throw new Error('Invalid business ID');
    }

    const instructions = await Instruction.find({ business: businessId })
        .populate('user', 'name level')
        .sort({ createdAt: -1 });

    const instructionIds = instructions.map(i => i._id);
    const commentCounts = await Comment.aggregate([
        { $match: { instruction: { $in: instructionIds } } },
        { $group: { _id: '$instruction', count: { $sum: 1 } } },
    ]);

    const commentCountMap = {};
    commentCounts.forEach(c => {
        commentCountMap[c._id.toString()] = c.count;
    });

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
            isVerifiedBusinessInstruction: i.isVerifiedBusinessInstruction ?? false,
            votedUsers: i.votedUsers.map(v => ({
                userId: v.user.toString(),
                voteType: v.voteType,
            })),
            timestamp: i.createdAt,
            commentCount: commentCountMap[i._id.toString()] || 0,
        }))
    );
});

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

    const commentCount = await Comment.countDocuments({ instruction: id });

    res.status(200).json({
        id: instruction._id.toString(),
        userId: instruction.user?._id?.toString(),
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
        isVerifiedBusinessInstruction: instruction.isVerifiedBusinessInstruction ?? false,
        votedUsers: instruction.votedUsers.map(v => ({
            userId: v.user.toString(),
            voteType: v.voteType,
        })),
        timestamp: instruction.createdAt,
        commentCount,
    });
});

const createInstruction = asyncHandler(async (req, res) => {
    const {
        businessId,
        notes,
        audioUrl,
        audioDuration,
        type,
        category,
        tags,
        photos = [],
        videos = [],
        // ── NEW: owner claim flag sent from the frontend checkbox ──────────
        isVerifiedBusinessInstruction = false,
    } = req.body;

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
                // Coerce to boolean so a stray string "false" doesn't slip through
                isVerifiedBusinessInstruction: isVerifiedBusinessInstruction === true,
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

const updateInstruction = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400);
        throw new Error('Invalid instruction ID');
    }

    const instruction = await Instruction.findById(id);

    if (!instruction) {
        res.status(404);
        throw new Error('Instruction not found');
    }

    if (!instruction.user.equals(userId)) {
        res.status(403);
        throw new Error('You can only edit your own instructions');
    }

    const {
        notes,
        audioUrl,
        audioDuration,
        type,
        category,
        tags,
        photos,
        videos,
    } = req.body;

    if (notes !== undefined) instruction.notes = notes;
    if (audioUrl !== undefined) instruction.audioUrl = audioUrl;
    if (audioDuration !== undefined) instruction.audioDuration = audioDuration;
    if (type !== undefined) instruction.type = type;
    if (category !== undefined) instruction.category = category;
    if (tags !== undefined) instruction.tags = tags;
    if (photos !== undefined) instruction.photos = photos;
    if (videos !== undefined) instruction.videos = videos;

    const updated = await instruction.save();

    res.status(200).json({
        id: updated._id.toString(),
        notes: updated.notes,
        audioUrl: updated.audioUrl,
        audioDuration: updated.audioDuration,
        type: updated.type,
        category: updated.category,
        photos: updated.photos,
        videos: updated.videos,
        tags: updated.tags,
    });
});






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
            update = {
                $inc: { [voteAction + 's']: 1 },
                $push: { votedUsers: { user: userId, voteType: voteAction } },
            };
        } else if (instruction.votedUsers[voteIndex].voteType === voteAction) {
            update = {
                $inc: { [voteAction + 's']: -1 },
                $pull: { votedUsers: { user: userId } },
            };
        } else {
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
    updateInstruction,
    likeInstruction,
    dislikeInstruction,
};
