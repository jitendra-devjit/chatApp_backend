import { uploadImage } from "../lib/cloudinary.js";
import { HttpError } from "../lib/httpError.js";
import { emitToUser } from "../lib/socket.js";
import { MAX_MESSAGE_LENGTH, requireEmoji, requireImageDataUri, requireObjectId } from "../lib/validate.js";
import Message from "../models/Message.js";
import User from "../models/User.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
// a message can be edited for this long after it was sent
export const EDIT_WINDOW_MS = 15 * 60 * 1000;

// the part of a quoted message that travels with the reply
const REPLY_FIELDS = "text image senderId deletedAt";

const cleanText = (text) => {
    if (text !== undefined && text !== null && typeof text !== "string") {
        throw new HttpError(400, "Message text must be a string");
    }
    const trimmed = (text || "").trim();
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
        throw new HttpError(400, `Message must be at most ${MAX_MESSAGE_LENGTH} characters`);
    }
    return trimmed;
};

// Finds a message the user is part of (as sender or receiver), 404 otherwise
const findOwnConversationMessage = async (id, userId) => {
    const message = await Message.findOne({
        _id: requireObjectId(id, "message id"),
        $or: [{ senderId: userId }, { receiverId: userId }],
    });
    if (!message) throw new HttpError(404, "Message not found");
    return message;
};

// Sends the changed message to both people, on every tab they have open
const broadcastUpdate = async (message) => {
    const updated = await message.populate("replyTo", REPLY_FIELDS);
    emitToUser(updated.senderId, "messageUpdated", updated);
    emitToUser(updated.receiverId, "messageUpdated", updated);
    return updated;
};

// get all users except the logged in user
export const getUserForSidebar = async (req, res) => {
    const userId = req.user._id;
    const filteredUsers = await User.find({_id: {$ne: userId}}).select("fullName profilePic bio createdAt lastSeen");

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
            _id: lastMessage._id,
            text: lastMessage.text || "",
            hasImage: Boolean(lastMessage.image),
            deleted: Boolean(lastMessage.deletedAt),
            senderId: lastMessage.senderId,
            seen: lastMessage.seen,
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
    const page = await Message.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .populate("replyTo", REPLY_FIELDS);
    const hasMore = page.length > limit;
    const messages = page.slice(0, limit).reverse(); // oldest → newest

    const result = await Message.updateMany(
      { senderId: selectedUserId, receiverId: myId, seen: false },
      { seen: true }
    );
    // tell the sender their messages were just read
    if (result.modifiedCount > 0) emitToUser(selectedUserId, "messagesSeen", { by: myId });

    res.json({success: true, messages, hasMore})
};

// 📌 api to Mark messages as seen using message id
export const markMessageAsSeen = async (req, res) => {
    const id = requireObjectId(req.params.id, "message id");

    // only the person who received the message can mark it as seen
    const message = await Message.findOneAndUpdate({_id: id, receiverId: req.user._id}, {seen: true})
    if (!message) throw new HttpError(404, "Message not found");
    if (!message.seen) emitToUser(message.senderId, "messagesSeen", { by: req.user._id });

    res.json({
      success: true,
      message: "Messages marked as seen",
    });
};

// send message to selected user

export const sendMessage = async(req, res) => {
    const {text, image, replyTo} = req.body || {};
    const receiverId = requireObjectId(req.params.id, "user id");
    const senderId = req.user._id;

    const messageText = cleanText(text);
    if (!messageText && !image) throw new HttpError(400, "Message is empty");

    if (senderId.equals(receiverId)) throw new HttpError(400, "You cannot message yourself");
    const receiver = await User.exists({ _id: receiverId });
    if (!receiver) throw new HttpError(404, "User not found");

    // a reply can only quote a message of this same conversation
    let replyToId;
    if (replyTo !== undefined && replyTo !== null) {
        const quoted = await Message.exists({
            _id: requireObjectId(replyTo, "reply id"),
            $or: [
                { senderId, receiverId },
                { senderId: receiverId, receiverId: senderId },
            ],
        });
        if (!quoted) throw new HttpError(404, "The message you are replying to was not found");
        replyToId = quoted._id;
    }

    let imageUrl;
    if(image){
        imageUrl = await uploadImage(requireImageDataUri(image), "messages");
    }
    const created = await Message.create({
        senderId,
        receiverId,
        text: messageText || undefined,
        image: imageUrl,
        replyTo: replyToId,
    })
    const newMessage = await created.populate("replyTo", REPLY_FIELDS);

    //Emit the new message to every open socket of the receiver
    emitToUser(receiverId, "newMessage", newMessage);

    res.status(201).json({success: true, newMessage})
}

// edit the text of a message you sent

export const editMessage = async (req, res) => {
    const message = await findOwnConversationMessage(req.params.id, req.user._id);
    if (!message.senderId.equals(req.user._id)) throw new HttpError(403, "You can only edit your own messages");
    if (message.deletedAt) throw new HttpError(400, "This message was deleted");
    if (Date.now() - message.createdAt.getTime() > EDIT_WINDOW_MS) {
        throw new HttpError(400, "Messages can only be edited for 15 minutes");
    }

    const text = cleanText(req.body?.text);
    if (!text) throw new HttpError(400, "Message is empty");

    if (text !== message.text) {
        message.text = text;
        message.editedAt = new Date();
        await message.save();
    }

    res.json({ success: true, message: await broadcastUpdate(message) });
};

// delete a message you sent, for both people. The row stays so replies and order keep working

export const deleteMessage = async (req, res) => {
    const message = await findOwnConversationMessage(req.params.id, req.user._id);
    if (!message.senderId.equals(req.user._id)) throw new HttpError(403, "You can only delete your own messages");

    if (!message.deletedAt) {
        message.text = undefined;
        message.image = undefined;
        message.reactions = [];
        message.deletedAt = new Date();
        await message.save();
    }

    res.json({ success: true, message: await broadcastUpdate(message) });
};

// react to a message with one emoji. The same emoji again, or an empty one, removes it

export const reactToMessage = async (req, res) => {
    const userId = req.user._id;
    const message = await findOwnConversationMessage(req.params.id, userId);
    if (message.deletedAt) throw new HttpError(400, "This message was deleted");

    const raw = req.body?.emoji;
    const emoji = raw === null || raw === undefined || raw === "" ? null : requireEmoji(raw);

    const current = message.reactions.find((reaction) => reaction.userId.equals(userId));
    message.reactions = message.reactions.filter((reaction) => !reaction.userId.equals(userId));
    if (emoji && current?.emoji !== emoji) message.reactions.push({ userId, emoji });
    await message.save();

    res.json({ success: true, message: await broadcastUpdate(message) });
};
