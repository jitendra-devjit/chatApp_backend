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
      ref: "User", // who sent the message
      required: true,
    },
    text: {
      type: String,
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

const Message = mongoose.model("Message", messageSchema);

export default Message;
