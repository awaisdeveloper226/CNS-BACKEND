const mongoose = require("mongoose");

const shareLinkSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    business: { type: mongoose.Schema.Types.ObjectId, ref: "Business", default: null },
    placeId: { type: String, default: null }, // set instead of `business` for unregistered/global businesses
   businessMeta: {
  name: String,
  address: String,
  type: { type: String },
  coordinates: { lat: Number, lng: Number },
},
    sharedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    claimedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    status: { type: String, enum: ["active", "claimed", "expired", "revoked"], default: "active" },
    expiresAt: { type: Date, required: true, index: { expires: 0 } }, // TTL — Mongo auto-deletes after this
  },
  { timestamps: true }
);

module.exports = mongoose.model("ShareLink", shareLinkSchema);
