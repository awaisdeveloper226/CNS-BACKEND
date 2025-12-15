// controllers/business.controller.js

const asyncHandler = require("express-async-handler");
const Business = require("../models/Business");
const Instruction = require("../models/Instruction");

/**
 * @desc  Get all businesses (including search for frontend)
 * @route   GET /api/businesses
 * @access  Public
 */
const getBusinesses = asyncHandler(async (req, res) => {
  const keyword = req.query.search
    ? {
        $or: [
          { name: { $regex: req.query.search, $options: "i" } },
          { address: { $regex: req.query.search, $options: "i" } },
          { tags: { $regex: req.query.search, $options: "i" } },
        ],
      }
    : {};

  const businesses = await Business.find(keyword).sort({
    totalContributions: -1,
  });
  res.status(200).json(businesses);
});

/**
 * @desc  Get single business by ID with its instructions
 * @route   GET /api/businesses/:id
 * @access  Public
 */
const getBusinessDetails = asyncHandler(async (req, res) => {
  console.log('🔍 Fetching business details for ID:', req.params.id);
  
  const business = await Business.findById(req.params.id)
    .lean()
    .populate({
      path: "contributions",
      model: "Instruction",
      populate: {
        path: "user",
        model: "User",
        select: "name level contributions totalLikesReceived",
      },
    });

  if (!business) {
    res.status(404);
    throw new Error("Business not found");
  }

  console.log('✅ Business found with', business.contributions?.length || 0, 'contributions');

  // --- Server-Side Sorting for Rating ---
  if (business.contributions && business.contributions.length > 0) {
    business.contributions.sort((a, b) => {
      const scoreA = (a.likes || 0) - (a.dislikes || 0);
      const scoreB = (b.likes || 0) - (b.dislikes || 0);

      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }

  // FIX: Map contributions with proper null/undefined handling
  const detailedBusiness = {
    id: business._id,
    name: business.name,
    address: business.address,
    type: business.type,
    totalContributions: business.totalContributions,
    isVerified: business.isVerified,
    coordinates: business.coordinates,
    contributions: business.contributions.map((instr) => ({
      // Instruction fields
      id: instr._id,
      notes: instr.notes,
      photos: instr.photos || [],
      videos: instr.videos || [],
      type: instr.type,
      category: instr.category,
      likes: instr.likes || 0,
      dislikes: instr.dislikes || 0,
      timestamp: instr.createdAt,
      tags: instr.tags || [],
      
      // FIX: User fields with proper fallbacks
      userId: instr.user?._id?.toString() || 'unknown',
      userName: instr.user?.name || 'Anonymous User',
      userLevel: instr.user?.level || 1,
      
      // FIX: Include votedUsers for frontend vote tracking
      votedUsers: (instr.votedUsers || []).map(vote => ({
        userId: vote.user?.toString() || vote.user,
        voteType: vote.voteType
      }))
    })),
  };

  res.status(200).json(detailedBusiness);
});

/**
 * @desc  Create new business
 * @route   POST /api/businesses
 * @access  Private
 */
const createBusiness = asyncHandler(async (req, res) => {
  const { name, address, type, lat, lng, courierType } = req.body;

  if (
    !name ||
    !address ||
    !type ||
    lat == null ||
    lng == null ||
    !courierType
  ) {
    res.status(400);
    throw new Error(
      "Name, address, type, coordinates (lat/lng), and courier type are required"
    );
  }

  if (!["Mall", "Standalone"].includes(type)) {
    res.status(400);
    throw new Error("Invalid business type. Must be Mall or Standalone.");
  }

  const validCourierTypes = [
    "Courier/Parcel Delivery",
    "Food Delivery",
    "Both",
  ];
  if (!validCourierTypes.includes(courierType)) {
    res.status(400);
    throw new Error(
      `Invalid courier type. Must be one of: ${validCourierTypes.join(", ")}`
    );
  }

  const existing = await Business.findOne({ name, address });
  if (existing) {
    res.status(400);
    throw new Error("Business with this name and address already exists");
  }

  const business = await Business.create({
    name,
    address,
    type,
    coordinates: { lat, lng },
    tags: [courierType],
  });

  res.status(201).json(business);
});

module.exports = {
  getBusinesses,
  getBusinessDetails,
  createBusiness,
};