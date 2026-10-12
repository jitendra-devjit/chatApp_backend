import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // who sent the message
      required: true,
    },
    receiverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", // who gets the message
      required: function () {
        return !this.groupId; // a group message has no single receiver
      },
    },
    // set when the message belongs to a group conversation
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
    },
    // a line like "Aarav added Sara", written by the server
    system: {
      type: Boolean,
    },
    text: {
      type: String,
      trim: true,
      maxlength: 2000,
    },
    image: {
        type: String,
    },
    seen: {
        type: Boolean, default: false
    },
    // the message this one answers
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
    },
    // at most one emoji per person
    reactions: [
      {
        _id: false,
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        emoji: { type: String, required: true },
      },
    ],
    editedAt: {
      type: Date,
    },
    // set when the sender deletes it for everyone, text and image are wiped then
    deletedAt: {
      type: Date,
    },
  },
  { timestamps: true } // adds createdAt, updatedAt
);

// loading one conversation, newest first
messageSchema.index({ senderId: 1, receiverId: 1, createdAt: -1 });
// loading one group conversation, newest first
messageSchema.index({ groupId: 1, createdAt: -1 });
// counting unseen messages per sender
messageSchema.index({ receiverId: 1, seen: 1, senderId: 1 });

const Message = mongoose.model("Message", messageSchema);

export default Message;
