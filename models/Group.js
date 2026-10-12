import mongoose from "mongoose";

export const MAX_GROUP_MEMBERS = 50;

const memberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["admin", "member"], default: "member" },
    joinedAt: { type: Date, default: Date.now },
    // everything up to this moment counts as read by this member
    lastReadAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const groupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 50,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 160,
      default: "",
    },
    avatar: {
      type: String, //cloudinary_url
      default: "",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    members: {
      type: [memberSchema],
      validate: [(members) => members.length <= MAX_GROUP_MEMBERS, `A group can have at most ${MAX_GROUP_MEMBERS} members`],
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
  }
);

// finding the groups of one user
groupSchema.index({ "members.user": 1 });

const Group = mongoose.model("Group", groupSchema);

export default Group;
