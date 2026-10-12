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
      required: true,
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
    }
  },
  { timestamps: true } // adds createdAt, updatedAt
);

// loading one conversation, newest first
messageSchema.index({ senderId: 1, receiverId: 1, createdAt: -1 });
// counting unseen messages per sender
messageSchema.index({ receiverId: 1, seen: 1, senderId: 1 });

const Message = mongoose.model("Message", messageSchema);

export default Message;
