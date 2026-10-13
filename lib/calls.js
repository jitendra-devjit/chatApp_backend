import { randomUUID } from "crypto";
import mongoose from "mongoose";
import Message from "../models/Message.js";
import User from "../models/User.js";

// One-to-one voice and video calls. The media goes straight from browser to browser (WebRTC),
// this file only rings the other person, passes the connection details along and writes
// the line that shows up in the chat afterwards.

export const CALL_KINDS = ["audio", "video"];

const DEFAULT_RING_TIMEOUT_MS = 35 * 1000;
// an offer with audio, video and a shared screen is a few KB, nothing honest is near this
const MAX_SIGNAL_CHARS = 64 * 1024;
const MAX_STARTS_PER_MINUTE = 10;
const MINUTE_MS = 60 * 1000;

const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"];

const calls = new Map(); // call id -> call
const callOfUser = new Map(); // user id -> id of the call they are ringing or talking in
const recentStarts = new Map(); // user id -> times of their latest call attempts

const ringTimeoutMs = () => Number(process.env.CALL_RING_TIMEOUT_MS) || DEFAULT_RING_TIMEOUT_MS;

const splitList = (value) => (value || "").split(",").map((item) => item.trim()).filter(Boolean);

// ---------- keeping the relay inside its free allowance ----------
// A TURN server is paid by the gigabyte once a free monthly amount is used up (Cloudflare: 1,000 GB).
// Three limits make sure that amount is never reached:
//   - a call ends by itself after CALL_MAX_MINUTES
//   - once the calls of this month add up to CALL_MONTHLY_HOURS, no relay is handed out until next month
//     (calls on networks with a direct path keep working, they cost nothing)
//   - the browsers cap their video bitrate (see CallContext)
// A relayed hour of video is at most about 4.5 GB when both directions are counted, so the
// default of 150 hours stays under 700 GB even in the worst case.
const DEFAULT_MAX_CALL_MINUTES = 60;
const DEFAULT_MONTHLY_CALL_HOURS = 150;
const USAGE_REUSE_MS = 5 * 60 * 1000;

const maxCallMs = () => (Number(process.env.CALL_MAX_MINUTES) || DEFAULT_MAX_CALL_MINUTES) * MINUTE_MS;
const monthlyHours = () => Number(process.env.CALL_MONTHLY_HOURS) || DEFAULT_MONTHLY_CALL_HOURS;

let usageCache = null; // { month, seconds, until }
export const forgetCallUsage = () => {
  usageCache = null;
};

// How long people talked this month, and whether that is over the limit. Every answered call
// counts, also those that never touched the relay, so the real usage is always lower
export const getCallUsage = async () => {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (!usageCache || usageCache.month !== monthStart.getTime() || usageCache.until < Date.now()) {
    const [total] = await Message.aggregate([
      { $match: { "call.status": "completed", createdAt: { $gte: monthStart } } },
      { $group: { _id: null, seconds: { $sum: "$call.duration" } } },
    ]);
    usageCache = { month: monthStart.getTime(), seconds: total?.seconds || 0, until: Date.now() + USAGE_REUSE_MS };
  }
  const hours = usageCache.seconds / 3600;
  return { hours, limit: monthlyHours(), exceeded: hours >= monthlyHours() };
};

const CLOUDFLARE_TURN_API = "https://rtc.live.cloudflare.com/v1/turn/keys";
// A login from Cloudflare works for two hours, longer than the longest call, and is reused for
// half an hour. Short, so a copied login is of little use to anybody
const CLOUDFLARE_TTL_SECONDS = 2 * 60 * 60;
const CLOUDFLARE_REUSE_MS = 30 * 60 * 1000;
const CLOUDFLARE_TIMEOUT_MS = 5000;

let cloudflareCache = null; // { keyId, servers, until }

// Short-lived TURN logins from Cloudflare Realtime, [] when it is not set up or cannot be reached
const getCloudflareServers = async () => {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const token = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !token) return [];
  if (cloudflareCache?.keyId === keyId && cloudflareCache.until > Date.now()) return cloudflareCache.servers;

  try {
    const response = await fetch(`${CLOUDFLARE_TURN_API}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: CLOUDFLARE_TTL_SECONDS }),
      signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Cloudflare TURN answered ${response.status}`);
    const { iceServers } = await response.json();
    const servers = [iceServers].flat().filter(Boolean).map((server) => ({
      ...server,
      // browsers refuse to connect to port 53, and waiting for that slows every call down
      urls: [server.urls].flat().filter((url) => !/:53(\?|$)/.test(url)),
    })).filter((server) => server.urls.length > 0);
    cloudflareCache = { keyId, servers, until: Date.now() + CLOUDFLARE_REUSE_MS };
    return servers;
  } catch (error) {
    console.error("TURN:", error.message);
    return [];
  }
};

// What browsers use to find a path to each other. STUN is free and works when both networks
// allow a direct connection. Phones on mobile data usually do not: there the call has to be
// relayed by a TURN server. Two ways to add one:
//   CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN   Cloudflare Realtime TURN
//   TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL          any TURN server with a fixed login
export const getIceServers = async () => {
  const stunUrls = splitList(process.env.STUN_URLS);
  const servers = [{ urls: stunUrls.length > 0 ? stunUrls : DEFAULT_STUN_URLS }];
  // this month's allowance is used up: no relay, so nothing can be billed
  if ((await getCallUsage()).exceeded) return servers;
  const turnUrls = splitList(process.env.TURN_URLS);
  if (turnUrls.length > 0) {
    servers.push({ urls: turnUrls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
  }
  servers.push(...(await getCloudflareServers()));
  return servers;
};

// true when calls can be relayed, false when only a direct connection is possible
export const hasTurnServer = (servers) => servers.some((server) => [server.urls].flat().some((url) => /^turns?:/.test(url)));

const allowStart = (userId) => {
  const now = Date.now();
  const recent = (recentStarts.get(userId) || []).filter((time) => now - time < MINUTE_MS);
  if (recent.length >= MAX_STARTS_PER_MINUTE) return false;
  recent.push(now);
  recentStarts.set(userId, recent);
  return true;
};

const reply = (ack, payload) => {
  if (typeof ack === "function") ack(payload);
};
const refuse = (ack, reason, message) => reply(ack, { ok: false, reason, message });

// `deps` come from socket.js: { io, emitToUser, isOnline, userRoom }
export const registerCallHandlers = (socket, { io, emitToUser, isOnline, userRoom }) => {
  const { userId } = socket.data;

  // The line in the chat: "Video call · 5 min", "Missed voice call". Only a missed call counts as unread
  const logCall = async ({ callerId, calleeId, kind }, status, duration) => {
    const message = await Message.create({
      senderId: callerId,
      receiverId: calleeId,
      call: { kind, status, duration },
      seen: status !== "missed",
    });
    emitToUser(callerId, "newMessage", message);
    emitToUser(calleeId, "newMessage", message);
    if (status === "completed") forgetCallUsage();
  };

  // reason: declined, cancelled, missed, ended, disconnected, failed (answered, but the browsers
  // found no path to each other), limit (it ran for the longest time a call may take)
  const endCall = async (call, reason) => {
    if (!calls.delete(call.id)) return; // somebody else ended it a moment ago
    clearTimeout(call.ringTimer);
    clearTimeout(call.limitTimer);
    const people = [call.callerId, call.calleeId];
    for (const id of people) {
      if (callOfUser.get(id) === call.id) callOfUser.delete(id);
      emitToUser(id, "call:ended", { callId: call.id, reason });
    }

    // a call that never connected was not a conversation, whoever picked up
    const wasAnswered = Boolean(call.answeredAt) && reason !== "failed";
    const status = wasAnswered ? "completed" : reason === "declined" ? "declined" : "missed";
    const duration = wasAnswered ? Math.round((Date.now() - call.answeredAt) / 1000) : undefined;
    try {
      await logCall(call, status, duration);
    } catch (error) {
      console.error(error.message);
    }
  };

  // the call this user is part of, null for anything else
  const findMyCall = (payload) => {
    const call = typeof payload?.callId === "string" ? calls.get(payload.callId) : null;
    return call && (call.callerId === userId || call.calleeId === userId) ? call : null;
  };

  socket.on("call:start", async (payload, ack) => {
    try {
      const to = payload?.to;
      const kind = payload?.kind;
      if (typeof to !== "string" || !mongoose.isValidObjectId(to) || to === userId || !CALL_KINDS.includes(kind)) {
        return refuse(ack, "invalid", "This call could not be started");
      }
      if (callOfUser.has(userId)) return refuse(ack, "in_call", "You are already in a call");
      if (!allowStart(userId)) return refuse(ack, "rate_limited", "Too many calls, try again in a minute");

      const [caller, callee] = await Promise.all([
        User.findById(userId).select("fullName profilePic"),
        User.findById(to).select("fullName"),
      ]);
      if (!caller || !callee) return refuse(ack, "not_found", "User not found");
      // a second tab can have started a call while the database was being asked
      if (callOfUser.has(userId)) return refuse(ack, "in_call", "You are already in a call");

      const firstName = callee.fullName.split(" ")[0];
      if (!isOnline(to)) {
        await logCall({ callerId: userId, calleeId: to, kind }, "missed");
        return refuse(ack, "offline", `${firstName} is offline. They will see a missed call`);
      }
      if (callOfUser.has(to)) {
        await logCall({ callerId: userId, calleeId: to, kind }, "missed");
        return refuse(ack, "busy", `${firstName} is on another call`);
      }

      const call = {
        id: randomUUID(),
        callerId: userId,
        calleeId: to,
        kind,
        answeredAt: null,
        // which tab of each person holds the call, the callee's is known once they accept
        sockets: { [userId]: socket.id },
      };
      call.ringTimer = setTimeout(() => endCall(call, "missed"), ringTimeoutMs());
      calls.set(call.id, call);
      callOfUser.set(userId, call.id);
      callOfUser.set(to, call.id);

      reply(ack, { ok: true, callId: call.id });
      emitToUser(to, "call:incoming", { callId: call.id, kind, from: caller });
    } catch (error) {
      console.error(error.message);
      refuse(ack, "error", "Something went wrong");
    }
  });

  socket.on("call:accept", (payload, ack) => {
    const call = findMyCall(payload);
    if (!call || call.calleeId !== userId || call.answeredAt) return refuse(ack, "gone", "This call has ended");

    clearTimeout(call.ringTimer);
    call.answeredAt = Date.now();
    call.limitTimer = setTimeout(() => endCall(call, "limit"), maxCallMs());
    call.sockets[userId] = socket.id;
    reply(ack, { ok: true });
    io.to(call.sockets[call.callerId]).emit("call:accepted", { callId: call.id });
    // their other tabs stop ringing
    socket.to(userRoom(userId)).emit("call:ended", { callId: call.id, reason: "answered_elsewhere" });
  });

  socket.on("call:decline", (payload) => {
    const call = findMyCall(payload);
    if (call && call.calleeId === userId && !call.answeredAt) endCall(call, "declined");
  });

  // hang up, or stop ringing somebody
  socket.on("call:end", (payload) => {
    const call = findMyCall(payload);
    if (!call) return;
    if (call.answeredAt) endCall(call, payload.failed === true ? "failed" : "ended");
    else endCall(call, call.callerId === userId ? "cancelled" : "declined");
  });

  // offers, answers and network candidates go to the other person untouched
  socket.on("call:signal", (payload) => {
    const call = findMyCall(payload);
    if (!call || !call.answeredAt || call.sockets[userId] !== socket.id) return;
    const data = payload.data;
    if (!data || typeof data !== "object") return;
    try {
      if (JSON.stringify(data).length > MAX_SIGNAL_CHARS) return;
    } catch {
      return;
    }
    const peerId = call.callerId === userId ? call.calleeId : call.callerId;
    io.to(call.sockets[peerId]).emit("call:signal", { callId: call.id, data });
  });

  socket.on("disconnect", () => {
    const call = calls.get(callOfUser.get(userId));
    if (!call) return;
    if (call.sockets[userId] === socket.id) {
      // the tab that was calling or talking is gone
      endCall(call, call.answeredAt ? "disconnected" : "cancelled");
    } else if (!call.answeredAt && call.calleeId === userId && !isOnline(userId)) {
      // the person being rung closed their last tab
      endCall(call, "missed");
    }
  });
};
