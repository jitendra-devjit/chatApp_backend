import Message from "../models/Message.js";
import { HttpError } from "./httpError.js";
import { deleteUpload, verifyUpload } from "./storage.js";
import { MAX_MESSAGE_LENGTH, requireString } from "./validate.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
// most messages returned when a chat is opened at an old message
const MAX_SINCE_SIZE = 1000;
const MAX_SEARCH_RESULTS = 30;

// the part of a quoted message that travels with the reply
export const REPLY_FIELDS = "text image attachments senderId deletedAt";

export const MAX_ATTACHMENTS = 10;
const MAX_WAVEFORM_POINTS = 64;
const MAX_DURATION_SECONDS = 24 * 60 * 60;

export const cleanText = (text) => {
    if (text !== undefined && text !== null && typeof text !== "string") {
        throw new HttpError(400, "Message text must be a string");
    }
    const trimmed = (text || "").trim();
    if (trimmed.length > MAX_MESSAGE_LENGTH) {
        throw new HttpError(400, `Message must be at most ${MAX_MESSAGE_LENGTH} characters`);
    }
    return trimmed;
};

// Turns the upload receipts of a request into attachments of a message. Every receipt is
// checked against storage, see verifyUpload. `origin` is this server's own address.
// Body item: { kind, upload, name?, duration?, waveform? }
export const collectAttachments = async (raw, origin) => {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) {
        throw new HttpError(400, `A message can have at most ${MAX_ATTACHMENTS} files`);
    }

    const attachments = [];
    try {
        for (const item of raw) {
            if (!item || typeof item !== "object") throw new HttpError(400, "This upload is not valid");
            const asset = await verifyUpload(item.kind, item.upload, origin);
            const attachment = { type: item.kind, ...asset };
            attachments.push(attachment);

            if (item.name !== undefined && item.name !== null) {
                attachment.name = requireString(item.name, "File name", { min: 1, max: 150 });
            }
            // storage knows the length of a video, a recording made in the browser reports its own
            if (attachment.duration === undefined && item.duration !== undefined) {
                const duration = Number(item.duration);
                if (!(duration > 0 && duration <= MAX_DURATION_SECONDS)) throw new HttpError(400, "Invalid duration");
                attachment.duration = duration;
            }
            if (item.waveform !== undefined && item.kind === "audio") {
                const valid = Array.isArray(item.waveform) && item.waveform.length <= MAX_WAVEFORM_POINTS &&
                    item.waveform.every((point) => Number.isInteger(point) && point >= 0 && point <= 100);
                if (!valid) throw new HttpError(400, "Invalid waveform");
                attachment.waveform = item.waveform;
            }
        }
    } catch (error) {
        // the message will not be sent, so the files that did pass are orphans now
        await Promise.all(attachments.map(deleteUpload));
        throw error;
    }
    return attachments;
};

// Removes every stored file of a message
export const deleteAttachments = (message) => Promise.all((message.attachments || []).map(deleteUpload));

const parseDate = (value, name) => {
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) throw new HttpError(400, `Invalid ${name} date`);
    return date;
};

// Reads messages of one conversation (`baseFilter` selects it), oldest first.
//   no query        the newest page
//   ?before=<date>  the page older than that date
//   ?since=<date>   everything from that date until now, used to open a chat at an old message
//   ?limit=         page size
export const fetchPage = async (baseFilter, query) => {
    const find = (conditions, limit) =>
        Message.find({ $and: conditions })
            .sort({ createdAt: -1, _id: -1 })
            .limit(limit)
            .populate("replyTo", REPLY_FIELDS);

    if (query.since !== undefined) {
        const since = parseDate(query.since, "since");
        const page = await find([baseFilter, { createdAt: { $gte: since } }], MAX_SINCE_SIZE);
        const older = await Message.exists({ $and: [baseFilter, { createdAt: { $lt: since } }] });
        return { messages: page.reverse(), hasMore: Boolean(older) };
    }

    const limit = Math.min(Math.max(parseInt(query.limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const conditions = [baseFilter];
    if (query.before !== undefined) conditions.push({ createdAt: { $lt: parseDate(query.before, "before") } });

    // one extra message tells us whether an older page exists
    const page = await find(conditions, limit + 1);
    return { messages: page.slice(0, limit).reverse(), hasMore: page.length > limit };
};

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Messages of one conversation whose text contains `q`, newest first
export const searchPage = (baseFilter, q) => {
    const term = requireString(q, "Search text", { min: 2, max: 100 });
    return Message.find({
        $and: [baseFilter, { deletedAt: null, system: { $ne: true }, text: { $regex: escapeRegex(term), $options: "i" } }],
    })
        .sort({ createdAt: -1 })
        .limit(MAX_SEARCH_RESULTS)
        .select("text senderId receiverId groupId createdAt");
};

// what the chat list shows under a conversation
export const toPreview = (message) => ({
    _id: message._id,
    text: message.text || "",
    hasImage: Boolean(message.image),
    // kind and name of the first file, and how many there are
    attachment: message.attachments?.length
        ? { type: message.attachments[0].type, name: message.attachments[0].name, count: message.attachments.length }
        : undefined,
    deleted: Boolean(message.deletedAt),
    system: Boolean(message.system),
    call: message.call ? { kind: message.call.kind, status: message.call.status, duration: message.call.duration } : undefined,
    senderId: message.senderId,
    seen: message.seen,
    createdAt: message.createdAt,
});
