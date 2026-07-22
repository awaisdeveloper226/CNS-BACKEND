// backend/controllers/instruction.controller.js

const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const Instruction = require('../models/Instruction');
const Business = require('../models/Business');
const User = require('../models/User');
const Comment = require('../models/Comment');
// NEW: so writes here also bust the cached getBusinessDetails payload —
// otherwise a new instruction / edit / vote wouldn't show up on the business
// detail screen until that cache's own TTL expired.
const { invalidateBusinessDetailCache } = require('./business.controller');

// ══════════════════════════════════════════════════════════════════════════════
// IN-MEMORY CACHE (same lightweight pattern as business.controller.js)
// ──────────────────────────────────────────────────────────────────────────────
// getInstructionsByBusiness / getInstructionById are read very frequently
// (every time a courier opens a business or taps into a single instruction),
// and each one does a populate + a separate comment-count aggregate. Caching
// the assembled response means every user after the first one in a TTL
// window gets it instantly with zero Mongo round trip.
//
// Writes (create/update/vote) explicitly invalidate the relevant entries
// instead of waiting out the TTL, so nobody sees stale likes/notes/audio.
// ══════════════════════════════════════════════════════════════════════════════

const _caches = new Map(); // cacheName -> Map<key, { value, expiresAt }>

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

    // Opportunistic cleanup so the Map doesn't grow unbounded.
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

const _inFlight = new Map(); // cacheName:key -> Promise

async function dedupeInFlight(cacheName, key, fn) {
    const flightKey = `${cacheName}:${key}`;
    if (_inFlight.has(flightKey)) {
        return _inFlight.get(flightKey);
    }
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

const INSTRUCTIONS_BY_BUSINESS_TTL_MS = 30 * 1000; // 30 seconds
const INSTRUCTION_DETAIL_TTL_MS = 30 * 1000; // 30 seconds

/**
 * Clears every cache entry tied to a single instruction: its own detail
 * cache plus the parent business's instruction-list cache (since that list
 * embeds the same fields and would otherwise go stale).
 */
function invalidateInstructionCaches(instructionId, businessId) {
    if (instructionId) cacheDelete('instructionDetail', String(instructionId));
    if (businessId) {
        cacheDelete('instructionsByBusiness', String(businessId));
        // The business detail payload also embeds contributions — keep it
        // in sync too.
        invalidateBusinessDetailCache(businessId);
    }
}

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

    // ── Cache check ──────────────────────────────────────────────────────────
    const cached = cacheGet('instructionsByBusiness', businessId);
    if (cached !== undefined) {
        console.log('✅ Instructions-by-business cache hit for:', businessId);
        return res.status(200).json(cached);
    }

    const payload = await dedupeInFlight('instructionsByBusiness', businessId, async () => {
        // NEW: userName/userLevel are now stored directly on the Instruction
        // document (denormalized at creation time), so no more populate('user').
        const instructions = await Instruction.find({ business: businessId })
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

        const result = instructions.map(i => ({
            id: i._id.toString(),
            userId: i.user?.toString(),
            userName: i.userName || 'Anonymous',
            userLevel: i.userLevel || 1,
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
        }));

        cacheSet('instructionsByBusiness', businessId, result, INSTRUCTIONS_BY_BUSINESS_TTL_MS);
        return result;
    });

    res.status(200).json(payload);
});

const getInstructionById = asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        res.status(400);
        throw new Error('Invalid instruction ID');
    }

    // ── Cache check ──────────────────────────────────────────────────────────
    const cached = cacheGet('instructionDetail', id);
    if (cached !== undefined) {
        console.log('✅ Instruction detail cache hit for:', id);
        return res.status(200).json(cached);
    }

    const result = await dedupeInFlight('instructionDetail', id, async () => {
        // NEW: no more populate('user') — userName/userLevel live on the doc.
        const instruction = await Instruction.findById(id);

        if (!instruction) {
            const err = new Error('Instruction not found');
            err.statusCode = 404;
            throw err;
        }

        const commentCount = await Comment.countDocuments({ instruction: id });

        const payload = {
            id: instruction._id.toString(),
            userId: instruction.user?.toString(),
            userName: instruction.userName || 'Anonymous',
            userLevel: instruction.userLevel || 1,
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
        };

        // Only cache successful lookups — never lock in a 404.
        cacheSet('instructionDetail', id, payload, INSTRUCTION_DETAIL_TTL_MS);
        return payload;
    }).catch((err) => {
        if (err.statusCode === 404) {
            res.status(404);
            throw new Error('Instruction not found');
        }
        throw err;
    });

    res.status(200).json(result);
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
                // NEW: snapshot the author's name/level onto the instruction
                // itself, so it stays independent of the User doc later.
                userName: req.user.name,
                userLevel: req.user.level ?? 1,
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

        // NEW: a brand-new instruction invalidates this business's instruction
        // list + the cached business-detail payload, so it shows up immediately
        // for the next person who opens this business.
        invalidateInstructionCaches(null, businessId);

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

    // NEW: edited notes/audio/media must be visible immediately — bust this
    // instruction's own cache, its parent business's instruction list, and
    // the business-detail cache (which embeds the same contribution data).
    invalidateInstructionCaches(updated._id, updated.business);

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

        // NEW: vote counts changed — invalidate so the next read (this
        // instruction's detail, its business's list, and the business
        // detail page) reflects the new likes/dislikes immediately.
        invalidateInstructionCaches(updated._id, updated.business);

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
