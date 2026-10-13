import { deleteImage, uploadImage } from "../lib/cloudinary.js";
import { HttpError } from "../lib/httpError.js";
import { cleanText, collectAttachments, deleteAttachments, fetchPage, REPLY_FIELDS, searchPage, toPreview } from "../lib/messageHelpers.js";
import { emitToUser } from "../lib/socket.js";
import { requireImageDataUri, requireObjectId, requireString } from "../lib/validate.js";
import Group, { MAX_GROUP_MEMBERS } from "../models/Group.js";
import Message from "../models/Message.js";
import User from "../models/User.js";
import { originOf } from "../routes/uploadRoutes.js";

// what other members may know about a member
const MEMBER_FIELDS = "fullName profilePic bio lastSeen";

const withMembers = (query) => query.populate("members.user", MEMBER_FIELDS);

// works whether members.user is populated or not
const memberId = (member) => String(member.user?._id ?? member.user);
const findMember = (group, userId) => group.members.find((member) => memberId(member) === String(userId));

// The group, if the user is in it. 404 otherwise, so outsiders cannot tell which groups exist
const requireMembership = async (groupId, userId) => {
    const group = await Group.findOne({ _id: requireObjectId(groupId, "group id"), "members.user": userId });
    if (!group) throw new HttpError(404, "Group not found");
    return group;
};

const requireAdmin = (group, userId) => {
    if (findMember(group, userId)?.role !== "admin") throw new HttpError(403, "Only group admins can do this");
};

const emitToGroup = (group, event, payload, exceptUserId) => {
    for (const member of group.members) {
        if (memberId(member) !== String(exceptUserId)) emitToUser(memberId(member), event, payload);
    }
};

// Sends the current state of the group to all of its members
const broadcastGroup = async (groupId) => {
    const group = await withMembers(Group.findById(groupId));
    emitToGroup(group, "groupUpdated", group);
    return group;
};

// A line in the conversation like "Aarav added Sara", shown to everybody
const postSystemMessage = async (group, actorId, text) => {
    const message = await Message.create({ groupId: group._id, senderId: actorId, system: true, text });
    emitToGroup(group, "newMessage", message);
};

const firstName = (user) => user.fullName.split(" ")[0];

// only messages sent after the member joined are theirs to read
const visibleMessages = (group, userId) => ({
    groupId: group._id,
    createdAt: { $gte: findMember(group, userId).joinedAt },
});

// Ids from the request that are real users and not yet in the group
const pickNewMembers = async (rawIds, group) => {
    if (!Array.isArray(rawIds)) throw new HttpError(400, "Choose at least one person");
    const wanted = [...new Set(rawIds.map((id) => requireObjectId(id, "user id")))].filter((id) => !findMember(group, id));
    if (wanted.length === 0) return [];
    if (group.members.length + wanted.length > MAX_GROUP_MEMBERS) {
        throw new HttpError(400, `A group can have at most ${MAX_GROUP_MEMBERS} members`);
    }
    const users = await User.find({ _id: { $in: wanted } }).select("fullName");
    if (users.length !== wanted.length) throw new HttpError(404, "One of these people was not found");
    return users;
};

// create a group, the creator becomes its admin

export const createGroup = async (req, res) => {
    const { name, description, memberIds, avatar } = req.body || {};
    const me = req.user;

    const group = new Group({
        name: requireString(name, "Group name", { min: 2, max: 50 }),
        description: description == null ? "" : requireString(description, "Description", { min: 0, max: 160 }),
        createdBy: me._id,
        members: [{ user: me._id, role: "admin" }],
    });

    const others = await pickNewMembers(memberIds, group);
    if (others.length === 0) throw new HttpError(400, "Choose at least one person");
    others.forEach((user) => group.members.push({ user: user._id }));

    if (avatar) group.avatar = await uploadImage(requireImageDataUri(avatar), "groups");
    await group.save();

    await postSystemMessage(group, me._id, `${firstName(me)} created the group`);
    res.status(201).json({ success: true, group: await broadcastGroup(group._id) });
};

// my groups, with the last message and the number of unread messages of each

export const getGroups = async (req, res) => {
    const userId = req.user._id;
    const groups = await withMembers(Group.find({ "members.user": userId }));

    const lastMessages = {};
    const unseenMessages = {};
    if (groups.length > 0) {
        // per group: when I joined (older messages are not mine) and what I have read
        const myMember = new Map(groups.map((group) => [String(group._id), findMember(group, userId)]));
        const dateOf = (field, fallback) => ({
            $switch: {
                branches: groups.map((group) => ({
                    case: { $eq: ["$groupId", group._id] },
                    then: myMember.get(String(group._id))[field],
                })),
                default: fallback,
            },
        });

        const stats = await Message.aggregate([
            { $match: { groupId: { $in: groups.map((group) => group._id) } } },
            { $match: { $expr: { $gte: ["$createdAt", dateOf("joinedAt", new Date())] } } },
            { $sort: { createdAt: -1 } },
            {
                $group: {
                    _id: "$groupId",
                    lastMessage: { $first: "$$ROOT" },
                    unseen: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $ne: ["$senderId", userId] },
                                        { $ne: ["$system", true] },
                                        { $gt: ["$createdAt", dateOf("lastReadAt", new Date())] },
                                    ],
                                },
                                1,
                                0,
                            ],
                        },
                    },
                },
            },
        ]);

        for (const { _id, lastMessage, unseen } of stats) {
            lastMessages[_id] = toPreview(lastMessage);
            if (unseen > 0) unseenMessages[_id] = unseen;
        }
    }

    res.json({ success: true, groups, lastMessages, unseenMessages });
};

// Everything up to now is read by this member, the others are told so their ticks update
const markRead = async (group, userId) => {
    const lastReadAt = new Date();
    await Group.updateOne(
        { _id: group._id, "members.user": userId },
        { $set: { "members.$.lastReadAt": lastReadAt } },
        { timestamps: false }
    );
    emitToGroup(group, "groupRead", { groupId: group._id, userId, lastReadAt }, userId);
};

// messages of a group, see fetchPage for the query options

export const getGroupMessages = async (req, res) => {
    const group = await requireMembership(req.params.id, req.user._id);
    const { messages, hasMore } = await fetchPage(visibleMessages(group, req.user._id), req.query);
    await markRead(group, req.user._id);
    res.json({ success: true, messages, hasMore });
};

// search the text of a group conversation, ?q=

export const searchGroupMessages = async (req, res) => {
    const group = await requireMembership(req.params.id, req.user._id);
    const results = await searchPage(visibleMessages(group, req.user._id), req.query.q);
    res.json({ success: true, results });
};

// called when a message arrives while the group is open

export const markGroupRead = async (req, res) => {
    const group = await requireMembership(req.params.id, req.user._id);
    await markRead(group, req.user._id);
    res.json({ success: true });
};

// send a message to a group

export const sendGroupMessage = async (req, res) => {
    const { text, image, replyTo, attachments: uploads } = req.body || {};
    const senderId = req.user._id;
    const group = await requireMembership(req.params.id, senderId);

    const messageText = cleanText(text);
    const hasFiles = Array.isArray(uploads) && uploads.length > 0;
    if (!messageText && !image && !hasFiles) throw new HttpError(400, "Message is empty");

    // a reply can only quote a message of this same group
    let replyToId;
    if (replyTo !== undefined && replyTo !== null) {
        const quoted = await Message.exists({
            _id: requireObjectId(replyTo, "reply id"),
            system: { $ne: true },
            ...visibleMessages(group, senderId),
        });
        if (!quoted) throw new HttpError(404, "The message you are replying to was not found");
        replyToId = quoted._id;
    }

    const imageUrl = image ? await uploadImage(requireImageDataUri(image), "messages") : undefined;
    const attachments = await collectAttachments(uploads, originOf(req));
    const created = await Message.create({
        groupId: group._id,
        senderId,
        text: messageText || undefined,
        image: imageUrl,
        attachments,
        replyTo: replyToId,
    });
    const newMessage = replyToId ? await created.populate("replyTo", REPLY_FIELDS) : created;

    emitToGroup(group, "newMessage", newMessage, senderId);
    await markRead(group, senderId);

    res.status(201).json({ success: true, newMessage });
};

// change name, description or picture (admins)

export const updateGroup = async (req, res) => {
    const me = req.user;
    const group = await requireMembership(req.params.id, me._id);
    requireAdmin(group, me._id);

    const { name, description, avatar } = req.body || {};
    const oldName = group.name;
    const oldAvatar = group.avatar;

    if (name !== undefined) group.name = requireString(name, "Group name", { min: 2, max: 50 });
    if (description !== undefined) group.description = requireString(description, "Description", { min: 0, max: 160 });
    if (avatar === "" || avatar === null) group.avatar = "";
    else if (avatar !== undefined) group.avatar = await uploadImage(requireImageDataUri(avatar), "groups");
    await group.save();

    if (group.avatar !== oldAvatar) await deleteImage(oldAvatar);
    if (group.name !== oldName) await postSystemMessage(group, me._id, `${firstName(me)} renamed the group to "${group.name}"`);

    res.json({ success: true, group: await broadcastGroup(group._id) });
};

// add people (admins)

export const addGroupMembers = async (req, res) => {
    const me = req.user;
    const group = await requireMembership(req.params.id, me._id);
    requireAdmin(group, me._id);

    const users = await pickNewMembers(req.body?.userIds, group);
    if (users.length > 0) {
        users.forEach((user) => group.members.push({ user: user._id }));
        await group.save();
        await postSystemMessage(group, me._id, `${firstName(me)} added ${users.map(firstName).join(", ")}`);
    }

    res.json({ success: true, group: await broadcastGroup(group._id) });
};

// remove somebody (admins), or leave the group yourself

export const removeGroupMember = async (req, res) => {
    const me = req.user;
    const targetId = requireObjectId(req.params.userId, "user id");
    const group = await requireMembership(req.params.id, me._id);
    const isLeaving = me._id.equals(targetId);
    if (!isLeaving) requireAdmin(group, me._id);

    if (!findMember(group, targetId)) throw new HttpError(404, "This person is not in the group");
    const target = isLeaving ? me : await User.findById(targetId).select("fullName");

    group.members = group.members.filter((member) => memberId(member) !== targetId);
    emitToUser(targetId, "groupRemoved", { groupId: group._id });

    // nobody is left: the group and its conversation go away
    if (group.members.length === 0) {
        const withFiles = await Message.find({
            groupId: group._id,
            $or: [{ image: { $exists: true } }, { "attachments.0": { $exists: true } }],
        }).select("image attachments");
        // the messages go first: a file is only removed when no message is left that shows it
        await Message.deleteMany({ groupId: group._id });
        await Promise.all([
            ...withFiles.map((message) => deleteImage(message.image)),
            ...withFiles.map((message) => deleteAttachments(message)),
            deleteImage(group.avatar),
        ]);
        await group.deleteOne();
        return res.json({ success: true, group: null });
    }

    // a group always keeps an admin: the longest standing member takes over
    if (!group.members.some((member) => member.role === "admin")) {
        [...group.members].sort((a, b) => a.joinedAt - b.joinedAt)[0].role = "admin";
    }
    await group.save();

    const name = target ? firstName(target) : "Someone";
    await postSystemMessage(group, me._id, isLeaving ? `${name} left the group` : `${firstName(me)} removed ${name}`);

    const updated = await broadcastGroup(group._id);
    res.json({ success: true, group: isLeaving ? null : updated });
};

// make somebody an admin or a normal member again (admins)

export const setGroupMemberRole = async (req, res) => {
    const me = req.user;
    const targetId = requireObjectId(req.params.userId, "user id");
    const role = req.body?.role;
    if (role !== "admin" && role !== "member") throw new HttpError(400, "Role must be admin or member");

    const group = await requireMembership(req.params.id, me._id);
    requireAdmin(group, me._id);
    const member = findMember(group, targetId);
    if (!member) throw new HttpError(404, "This person is not in the group");

    if (member.role !== role) {
        const admins = group.members.filter((item) => item.role === "admin");
        if (role === "member" && admins.length === 1) throw new HttpError(400, "A group needs at least one admin");
        member.role = role;
        await group.save();

        const target = await User.findById(targetId).select("fullName");
        if (role === "admin" && target) await postSystemMessage(group, me._id, `${firstName(me)} made ${firstName(target)} an admin`);
    }

    res.json({ success: true, group: await broadcastGroup(group._id) });
};
