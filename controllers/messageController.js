import { uploadImage } from "../lib/cloudinary.js";
import { HttpError } from "../lib/httpError.js";
import { emitToUser } from "../lib/socket.js";
import { MAX_MESSAGE_LENGTH, requireImageDataUri, requireObjectId } from "../lib/validate.js";
import Message from "../models/Message.js";
import User from "../models/User.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

// get all users except the logged in user
export const getUserForSidebar = async (req, res) => {
    const userId = req.user._id;
    const filteredUsers = await User.find({_id: {$ne: userId}}).select("fullName profilePic bio");

    // last message and number of unseen messages for every conversation, in one query
    const conversations = await Message.aggregate([
        { $match: { $or: [{ senderId: userId }, { receiverId: userId }] } },
        { $sort: { createdAt: -1 } },
        {
            $group: {
                _id: { $cond: [{ $eq: ["$senderId", userId] }, "$receiverId", "$senderId"] },
                lastMessage: { $first: "$$ROOT" },
                unseen: {
                    $sum: {
                        $cond: [{ $and: [{ $eq: ["$receiverId", userId] }, { $eq: ["$seen", false] }] }, 1, 0],
                    },
                },
            },
        },
    ]);

    const unseenMessages = {}
    const lastMessages = {}
    for (const { _id, lastMessage, unseen } of conversations) {
        if (unseen > 0) unseenMessages[_id] = unseen;
        lastMessages[_id] = {
            text: lastMessage.text || "",
            hasImage: Boolean(lastMessage.image),
            senderId: lastMessage.senderId,
            createdAt: lastMessage.createdAt,
        };
    }

    res.json({success: true, users: filteredUsers, unseenMessages, lastMessages})
};

// 📌 Get messages for selected user, newest page first.
// ?before=<ISO date> loads the page older than that date, ?limit= sets the page size
export const getMessages = async (req, res) => {
    const selectedUserId = requireObjectId(req.params.id, "user id");
    const myId = req.user._id;

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const filter = {
      $or: [
        { senderId: myId, receiverId: selectedUserId },
        { senderId: selectedUserId, receiverId: myId }, // both directions
      ],
    };

    if (req.query.before !== undefined) {
      const before = new Date(String(req.query.before));
      if (Number.isNaN(before.getTime())) throw new HttpError(400, "Invalid before date");
      filter.createdAt = { $lt: before };
    }

    // one extra message tells us whether an older page exists
    const page = await Message.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1);
    const hasMore = page.length > limit;
    const messages = page.slice(0, limit).reverse(); // oldest → newest

    await Message.updateMany(
      { senderId: selectedUserId, receiverId: myId, seen: false },
      { seen: true }
    );

    res.json({success: true, messages, hasMore})
};

// 📌 api to Mark messages as seen using message id
export const markMessageAsSeen = async (req, res) => {
    const id = requireObjectId(req.params.id, "message id");

    // only the person who received the message can mark it as seen
    const result = await Message.updateOne({_id: id, receiverId: req.user._id}, {seen: true})
    if (result.matchedCount === 0) throw new HttpError(404, "Message not found");

    res.json({
      success: true,
      message: "Messages marked as seen",
    });
};

// send message to selected user

export const sendMessage = async(req, res) => {
    const {text, image} = req.body || {};
    const receiverId = requireObjectId(req.params.id, "user id");
    const senderId = req.user._id;

    if (text !== undefined && text !== null && typeof text !== "string") {
        throw new HttpError(400, "Message text must be a string");
    }
    const cleanText = (text || "").trim();
    if (cleanText.length > MAX_MESSAGE_LENGTH) {
        throw new HttpError(400, `Message must be at most ${MAX_MESSAGE_LENGTH} characters`);
    }
    if (!cleanText && !image) throw new HttpError(400, "Message is empty");

    if (senderId.equals(receiverId)) throw new HttpError(400, "You cannot message yourself");
    const receiver = await User.exists({ _id: receiverId });
    if (!receiver) throw new HttpError(404, "User not found");

    let imageUrl;
    if(image){
        imageUrl = await uploadImage(requireImageDataUri(image), "messages");
    }
    const newMessage = await Message.create({
        senderId,
        receiverId,
        text: cleanText || undefined,
        image: imageUrl
    })

    //Emit the new message to every open socket of the receiver
    emitToUser(receiverId, "newMessage", newMessage);

    res.status(201).json({success: true, newMessage})
}
