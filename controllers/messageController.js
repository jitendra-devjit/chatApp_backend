import { deleteImage, uploadImage } from "../lib/cloudinary.js";
import { HttpError } from "../lib/httpError.js";
import { cleanText, collectAttachments, deleteAttachments, fetchPage, REPLY_FIELDS, searchPage, toPreview } from "../lib/messageHelpers.js";
import { emitToUser } from "../lib/socket.js";
import { temporaryLink } from "../lib/storage.js";
import { requireEmoji, requireImageDataUri, requireObjectId } from "../lib/validate.js";
import Group from "../models/Group.js";
import Message from "../models/Message.js";
import User from "../models/User.js";
import { originOf } from "../routes/uploadRoutes.js";

// a message can be edited for this long after it was sent
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
// a message can be sent on to this many chats in one go
export const MAX_FORWARD_TARGETS = 5;

// the two directions of a one-to-one conversation
const conversationFilter = (userA, userB) => ({
    groupId: null,
    $or: [
        { senderId: userA, receiverId: userB },
        { senderId: userB, receiverId: userA },
    ],
});

// Finds a message the user may see: one of their own conversation, or of a group they are in. 404 otherwise
const findAccessibleMessage = async (id, userId) => {
    const message = await Message.findById(requireObjectId(id, "message id"));
    const allowed = message && (message.groupId
        ? await Group.exists({ _id: message.groupId, "members.user": userId })
        : message.senderId.equals(userId) || message.receiverId.equals(userId));
    // lines written by the server (group events, calls) cannot be edited, deleted or reacted to
    if (!allowed || message.system || message.call) throw new HttpError(404, "Message not found");
    return message;
};

// Sends the changed message to everybody in the conversation, on every tab they have open
const broadcastUpdate = async (message) => {
    const updated = await message.populate("replyTo", REPLY_FIELDS);
    if (updated.groupId) {
        const group = await Group.findById(updated.groupId).select("members.user");
        group?.members.forEach((member) => emitToUser(member.user, "messageUpdated", updated));
    } else {
        emitToUser(updated.senderId, "messageUpdated", updated);
        emitToUser(updated.receiverId, "messageUpdated", updated);
    }
    return updated;
};

// get all users except the logged in user
export const getUserForSidebar = async (req, res) => {
    const userId = req.user._id;
    const filteredUsers = await User.find({_id: {$ne: userId}}).select("fullName profilePic bio createdAt lastSeen");

    // last message and number of unseen messages for every conversation, in one query
    const conversations = await Message.aggregate([
        { $match: { groupId: null, $or: [{ senderId: userId }, { receiverId: userId }] } },
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
        lastMessages[_id] = toPreview(lastMessage);
    }

    res.json({success: true, users: filteredUsers, unseenMessages, lastMessages})
};

// 📌 Get messages for selected user, see fetchPage for the query options
export const getMessages = async (req, res) => {
    const selectedUserId = requireObjectId(req.params.id, "user id");
    const myId = req.user._id;

    const { messages, hasMore } = await fetchPage(conversationFilter(myId, selectedUserId), req.query);

    const result = await Message.updateMany(
      { senderId: selectedUserId, receiverId: myId, seen: false },
      { seen: true }
    );
    // tell the sender their messages were just read
    if (result.modifiedCount > 0) emitToUser(selectedUserId, "messagesSeen", { by: myId });

    res.json({success: true, messages, hasMore})
};

// search the text of a one-to-one conversation, ?q=
export const searchMessages = async (req, res) => {
    const selectedUserId = requireObjectId(req.params.id, "user id");
    const results = await searchPage(conversationFilter(req.user._id, selectedUserId), req.query.q);
    res.json({ success: true, results });
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
    const {text, image, replyTo, attachments: uploads} = req.body || {};
    const receiverId = requireObjectId(req.params.id, "user id");
    const senderId = req.user._id;

    const messageText = cleanText(text);
    const hasFiles = Array.isArray(uploads) && uploads.length > 0;
    if (!messageText && !image && !hasFiles) throw new HttpError(400, "Message is empty");

    if (senderId.equals(receiverId)) throw new HttpError(400, "You cannot message yourself");
    const receiver = await User.exists({ _id: receiverId });
    if (!receiver) throw new HttpError(404, "User not found");

    // a reply can only quote a message of this same conversation
    let replyToId;
    if (replyTo !== undefined && replyTo !== null) {
        const quoted = await Message.exists({
            _id: requireObjectId(replyTo, "reply id"),
            ...conversationFilter(senderId, receiverId),
        });
        if (!quoted) throw new HttpError(404, "The message you are replying to was not found");
        replyToId = quoted._id;
    }

    let imageUrl;
    if(image){
        imageUrl = await uploadImage(requireImageDataUri(image), "messages");
    }
    const attachments = await collectAttachments(uploads, originOf(req));
    const created = await Message.create({
        senderId,
        receiverId,
        text: messageText || undefined,
        image: imageUrl,
        attachments,
        replyTo: replyToId,
    })
    // only a reply has something to look up, every other message is ready as it is
    const newMessage = replyToId ? await created.populate("replyTo", REPLY_FIELDS) : created;

    //Emit the new message to every open socket of the receiver
    emitToUser(receiverId, "newMessage", newMessage);

    res.status(201).json({success: true, newMessage})
}

// Send a message on to other chats: `userIds` and `groupIds`, together at most MAX_FORWARD_TARGETS.
// The text and the files travel along, the reply quote and the reactions do not

const uniqueIds = (raw, field) => {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new HttpError(400, "Choose where to forward the message");
    return [...new Set(raw.map((id) => requireObjectId(id, field)))];
};

export const forwardMessage = async (req, res) => {
    const senderId = req.user._id;
    const source = await findAccessibleMessage(req.params.id, senderId);
    if (source.deletedAt) throw new HttpError(400, "This message was deleted");

    const attachments = source.attachments.toObject();
    // (a picture sent the old way, as `image`, has no record of where it is stored)
    if (!source.text && attachments.length === 0) throw new HttpError(400, "This message cannot be forwarded");

    const userIds = uniqueIds(req.body?.userIds, "user id").filter((id) => id !== String(senderId));
    const groupIds = uniqueIds(req.body?.groupIds, "group id");
    const total = userIds.length + groupIds.length;
    if (total === 0) throw new HttpError(400, "Choose where to forward the message");
    if (total > MAX_FORWARD_TARGETS) throw new HttpError(400, `A message can be forwarded to at most ${MAX_FORWARD_TARGETS} chats at once`);

    const [userCount, groups] = await Promise.all([
        User.countDocuments({ _id: { $in: userIds } }),
        Group.find({ _id: { $in: groupIds }, "members.user": senderId }).select("members.user"),
    ]);
    if (userCount !== userIds.length || groups.length !== groupIds.length) throw new HttpError(404, "One of these chats was not found");

    const content = { senderId, text: source.text, attachments, forwarded: true };
    const messages = await Message.create([
        ...userIds.map((receiverId) => ({ ...content, receiverId })),
        ...groups.map((group) => ({ ...content, groupId: group._id })),
    ]);

    for (const message of messages) {
        if (message.receiverId) {
            emitToUser(message.receiverId, "newMessage", message);
            continue;
        }
        const group = groups.find((item) => item._id.equals(message.groupId));
        for (const member of group.members) {
            if (!member.user.equals(senderId)) emitToUser(member.user, "newMessage", message);
        }
    }

    res.status(201).json({ success: true, messages });
};

// A link that opens one file of a message, or downloads it with ?download=1.
// Only somebody who can see the message gets one, and it stops working after a few minutes

export const getFileLink = async (req, res) => {
    const message = await findAccessibleMessage(req.params.id, req.user._id);
    const attachment = /^\d{1,2}$/.test(req.params.index) ? message.attachments[Number(req.params.index)] : null;
    if (!attachment) throw new HttpError(404, "File not found");
    res.json({ success: true, url: temporaryLink(attachment, { download: req.query.download === "1" }) });
};

// edit the text of a message you sent

export const editMessage = async (req, res) => {
    const message = await findAccessibleMessage(req.params.id, req.user._id);
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

// delete a message you sent, for everybody. The row stays so replies and order keep working

export const deleteMessage = async (req, res) => {
    const message = await findAccessibleMessage(req.params.id, req.user._id);
    if (!message.senderId.equals(req.user._id)) throw new HttpError(403, "You can only delete your own messages");

    if (!message.deletedAt) {
        const image = message.image;
        const files = { attachments: message.attachments.toObject() };
        message.text = undefined;
        message.image = undefined;
        message.attachments = [];
        message.reactions = [];
        message.deletedAt = new Date();
        await message.save();
        // the files themselves go too, not only the links to them
        await Promise.all([deleteImage(image), deleteAttachments(files)]);
    }

    res.json({ success: true, message: await broadcastUpdate(message) });
};

// react to a message with one emoji. The same emoji again, or an empty one, removes it

export const reactToMessage = async (req, res) => {
    const userId = req.user._id;
    const message = await findAccessibleMessage(req.params.id, userId);
    if (message.deletedAt) throw new HttpError(400, "This message was deleted");

    const raw = req.body?.emoji;
    const emoji = raw === null || raw === undefined || raw === "" ? null : requireEmoji(raw);

    const current = message.reactions.find((reaction) => reaction.userId.equals(userId));
    message.reactions = message.reactions.filter((reaction) => !reaction.userId.equals(userId));
    if (emoji && current?.emoji !== emoji) message.reactions.push({ userId, emoji });
    await message.save();

    res.json({ success: true, message: await broadcastUpdate(message) });
};
