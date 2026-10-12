import Message from "../models/Message.js";
import { HttpError } from "./httpError.js";
import { MAX_MESSAGE_LENGTH, requireString } from "./validate.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
// most messages returned when a chat is opened at an old message
const MAX_SINCE_SIZE = 1000;
const MAX_SEARCH_RESULTS = 30;

// the part of a quoted message that travels with the reply
export const REPLY_FIELDS = "text image senderId deletedAt";

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
    deleted: Boolean(message.deletedAt),
    system: Boolean(message.system),
    senderId: message.senderId,
    seen: message.seen,
    createdAt: message.createdAt,
});
