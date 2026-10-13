import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, waitForEvent } from "./helpers.js";

let ctx;
before(async () => {
  ctx = await startTestServer();
});
after(() => ctx.stop());

const pause = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

// sends an event and resolves with what the server answers
const ask = (socket, event, payload) => socket.timeout(2000).emitWithAck(event, payload);

// two (or more) users, each with one connected socket
const connect = async (count = 2) => {
  const people = [];
  for (let i = 0; i < count; i += 1) {
    const user = await ctx.createUser();
    people.push({ ...user, socket: await ctx.connectSocket({ token: user.token }) });
  }
  return people;
};

const close = (...people) => people.forEach((person) => person.socket.close());

// a rings b, resolves with the call id once b's phone rings
const ring = async (a, b, kind = "audio") => {
  const incoming = waitForEvent(b.socket, "call:incoming");
  const started = await ask(a.socket, "call:start", { to: b.id, kind });
  assert.equal(started.ok, true);
  await incoming;
  return started.callId;
};

const callLog = (socket) => waitForEvent(socket, "newMessage", { filter: (message) => Boolean(message.call) });

describe("starting a call", () => {
  test("rings every tab of the other person, with who is calling", async () => {
    const [a, b] = await connect();
    const tab2 = await ctx.connectSocket({ token: b.token });

    const rings = Promise.all([waitForEvent(b.socket, "call:incoming"), waitForEvent(tab2, "call:incoming")]);
    const started = await ask(a.socket, "call:start", { to: b.id, kind: "video" });
    const [first, second] = await rings;

    assert.equal(started.ok, true);
    assert.equal(first.callId, started.callId);
    assert.equal(second.callId, started.callId);
    assert.equal(first.kind, "video");
    assert.equal(first.from._id, a.id);
    assert.equal(first.from.fullName, a.fullName);
    // nothing private about the caller travels along
    assert.deepEqual(Object.keys(first.from).sort(), ["_id", "fullName", "profilePic"]);

    a.socket.emit("call:end", { callId: started.callId });
    await waitForEvent(b.socket, "call:ended");
    tab2.close();
    close(a, b);
  });

  test("refuses bad requests without crashing", async () => {
    const [a, b] = await connect();
    const bad = [
      null,
      { to: b.id },
      { to: b.id, kind: "hologram" },
      { to: a.id, kind: "audio" },
      { to: { $ne: null }, kind: "audio" },
      { to: "not-an-id", kind: "audio" },
    ];
    for (const payload of bad) {
      const answer = await ask(a.socket, "call:start", payload);
      assert.equal(answer.ok, false);
      assert.equal(answer.reason, "invalid");
    }
    const ghost = await ask(a.socket, "call:start", { to: "64b000000000000000000000", kind: "audio" });
    assert.equal(ghost.reason, "not_found");
    // an event without a callback is fine too
    a.socket.emit("call:start", { to: "nope" });
    a.socket.emit("call:accept", null);
    a.socket.emit("call:signal", { callId: 5 });
    await pause();
    assert.equal((await ctx.api("GET", "/api/status")).status, 200);
    close(a, b);
  });

  test("somebody who is offline gets a missed call", async () => {
    const [a] = await connect(1);
    const b = await ctx.createUser();

    const logged = callLog(a.socket);
    const answer = await ask(a.socket, "call:start", { to: b.id, kind: "audio" });
    assert.equal(answer.ok, false);
    assert.equal(answer.reason, "offline");
    assert.deepEqual((await logged).call, { kind: "audio", status: "missed" });

    const list = await ctx.api("GET", "/api/messages/users", { token: b.token });
    assert.equal(list.body.unseenMessages[a.id], 1);
    assert.deepEqual(list.body.lastMessages[a.id].call, { kind: "audio", status: "missed" });
    close(a);
  });

  test("somebody who is already on a call is busy, and nobody can be in two calls", async () => {
    const [a, b, c] = await connect(3);
    const callId = await ring(a, b);

    let rang = false;
    b.socket.on("call:incoming", () => (rang = true));
    assert.equal((await ask(c.socket, "call:start", { to: b.id, kind: "audio" })).reason, "busy");
    assert.equal((await ask(c.socket, "call:start", { to: a.id, kind: "audio" })).reason, "busy");
    assert.equal((await ask(a.socket, "call:start", { to: c.id, kind: "audio" })).reason, "in_call");
    await pause();
    assert.equal(rang, false);

    // once the call is over both are free again
    a.socket.emit("call:end", { callId });
    await waitForEvent(b.socket, "call:ended");
    const next = await ring(c, b);
    c.socket.emit("call:end", { callId: next });
    await waitForEvent(b.socket, "call:ended");
    close(a, b, c);
  });
});

describe("answering", () => {
  test("accepting connects the two and passes signals both ways, to nobody else", async () => {
    const [a, b, c] = await connect(3);
    const callId = await ring(a, b, "video");

    // signals are not passed on before the call is answered
    let early = false;
    b.socket.on("call:signal", () => (early = true));
    a.socket.emit("call:signal", { callId, data: { description: { type: "offer", sdp: "too early" } } });
    await pause(200);
    assert.equal(early, false);

    const accepted = waitForEvent(a.socket, "call:accepted");
    assert.deepEqual(await ask(b.socket, "call:accept", { callId }), { ok: true });
    assert.deepEqual(await accepted, { callId });

    let leaked = false;
    c.socket.on("call:signal", () => (leaked = true));

    const offer = waitForEvent(b.socket, "call:signal");
    a.socket.emit("call:signal", { callId, data: { description: { type: "offer", sdp: "v=0" } } });
    assert.deepEqual(await offer, { callId, data: { description: { type: "offer", sdp: "v=0" } } });

    const answer = waitForEvent(a.socket, "call:signal");
    b.socket.emit("call:signal", { callId, data: { description: { type: "answer", sdp: "v=0" } } });
    assert.equal((await answer).data.description.type, "answer");

    // an outsider cannot talk into the call, end it or answer it
    let injected = false;
    a.socket.on("call:signal", () => (injected = true));
    let ended = false;
    a.socket.on("call:ended", () => (ended = true));
    c.socket.emit("call:signal", { callId, data: { candidate: { candidate: "evil" } } });
    c.socket.emit("call:end", { callId });
    c.socket.emit("call:decline", { callId });
    assert.equal((await ask(c.socket, "call:accept", { callId })).ok, false);
    // junk and oversized signals are dropped
    b.socket.emit("call:signal", { callId, data: "text" });
    b.socket.emit("call:signal", { callId, data: { sdp: "x".repeat(70 * 1024) } });
    await pause();
    assert.equal(leaked, false);
    assert.equal(injected, false);
    assert.equal(ended, false);

    const logs = Promise.all([callLog(a.socket), callLog(b.socket)]);
    const over = waitForEvent(a.socket, "call:ended");
    b.socket.emit("call:end", { callId });
    assert.deepEqual(await over, { callId, reason: "ended" });

    const [forCaller, forCallee] = await logs;
    assert.equal(forCaller._id, forCallee._id);
    assert.equal(forCaller.senderId, a.id);
    assert.equal(forCaller.receiverId, b.id);
    assert.equal(forCaller.call.kind, "video");
    assert.equal(forCaller.call.status, "completed");
    assert.equal(typeof forCaller.call.duration, "number");
    assert.equal(forCaller.seen, true);
    close(a, b, c);
  });

  test("the other tabs stop ringing, and only the tab that answered is in the call", async () => {
    const [a, b] = await connect();
    const tab2 = await ctx.connectSocket({ token: b.token });
    const callId = await ring(a, b);

    const stopped = waitForEvent(tab2, "call:ended");
    await ask(b.socket, "call:accept", { callId });
    assert.deepEqual(await stopped, { callId, reason: "answered_elsewhere" });
    // a call is answered once
    assert.equal((await ask(tab2, "call:accept", { callId })).ok, false);

    let relayed = false;
    a.socket.on("call:signal", () => (relayed = true));
    tab2.emit("call:signal", { callId, data: { candidate: {} } });
    await pause(200);
    assert.equal(relayed, false);

    a.socket.emit("call:end", { callId });
    await waitForEvent(b.socket, "call:ended");
    tab2.close();
    close(a, b);
  });

  test("a call whose browsers cannot reach each other ends as failed, for both, and is not a conversation", async () => {
    const [a, b] = await connect();
    const callId = await ring(a, b);
    await ask(b.socket, "call:accept", { callId });

    const log = callLog(a.socket);
    const over = Promise.all([waitForEvent(a.socket, "call:ended"), waitForEvent(b.socket, "call:ended")]);
    b.socket.emit("call:end", { callId, failed: true });
    assert.deepEqual(await over, [{ callId, reason: "failed" }, { callId, reason: "failed" }]);
    assert.deepEqual((await log).call, { kind: "audio", status: "missed" });
    close(a, b);
  });

  test("declining ends it for the caller and is written down as declined", async () => {
    const [a, b] = await connect();
    const callId = await ring(a, b);

    const log = callLog(a.socket);
    const over = waitForEvent(a.socket, "call:ended");
    b.socket.emit("call:decline", { callId });
    assert.deepEqual(await over, { callId, reason: "declined" });

    const message = await log;
    assert.deepEqual(message.call, { kind: "audio", status: "declined" });
    assert.equal(message.seen, true);
    close(a, b);
  });
});

describe("calls that are not answered", () => {
  test("the caller giving up leaves a missed call", async () => {
    const [a, b] = await connect();
    const callId = await ring(a, b);

    const log = callLog(b.socket);
    const over = waitForEvent(b.socket, "call:ended");
    a.socket.emit("call:end", { callId });
    assert.deepEqual(await over, { callId, reason: "cancelled" });

    const message = await log;
    assert.deepEqual(message.call, { kind: "audio", status: "missed" });
    assert.equal(message.seen, false);
    close(a, b);
  });

  test("ringing stops by itself after a while", async () => {
    process.env.CALL_RING_TIMEOUT_MS = "250";
    const [a, b] = await connect();
    const over = waitForEvent(a.socket, "call:ended");
    const log = callLog(b.socket);
    const callId = await ring(a, b);
    delete process.env.CALL_RING_TIMEOUT_MS;

    assert.deepEqual(await over, { callId, reason: "missed" });
    assert.equal((await log).call.status, "missed");
    close(a, b);
  });

  test("closing the tab ends the call for the other person", async () => {
    // the caller leaves while it rings
    const [a, b] = await connect();
    let callId = await ring(a, b);
    let over = waitForEvent(b.socket, "call:ended");
    a.socket.close();
    assert.deepEqual(await over, { callId, reason: "cancelled" });

    // the person being rung goes offline
    const [c, d] = await connect();
    callId = await ring(c, d);
    over = waitForEvent(c.socket, "call:ended");
    d.socket.close();
    assert.deepEqual(await over, { callId, reason: "missed" });

    // one of the two drops out in the middle of a call
    const [e, f] = await connect();
    callId = await ring(e, f);
    await ask(f.socket, "call:accept", { callId });
    over = waitForEvent(e.socket, "call:ended");
    const log = callLog(e.socket);
    f.socket.close();
    assert.deepEqual(await over, { callId, reason: "disconnected" });
    assert.equal((await log).call.status, "completed");
    close(b, c, e);
  });
});

describe("calls in the chat", () => {
  test("show up in the conversation and cannot be edited, deleted or reacted to", async () => {
    const [a, b] = await connect();
    const callId = await ring(a, b);
    const log = callLog(a.socket);
    b.socket.emit("call:decline", { callId });
    const message = await log;

    const chat = await ctx.api("GET", `/api/messages/${a.id}`, { token: b.token });
    assert.deepEqual(chat.body.messages.at(-1).call, { kind: "audio", status: "declined" });

    assert.equal((await ctx.api("PUT", `/api/messages/${message._id}`, { token: a.token, body: { text: "edited" } })).status, 404);
    assert.equal((await ctx.api("DELETE", `/api/messages/${message._id}`, { token: a.token })).status, 404);
    assert.equal((await ctx.api("PUT", `/api/messages/${message._id}/reaction`, { token: b.token, body: { emoji: "👍" } })).status, 404);
    close(a, b);
  });

  test("a client cannot write a call into a message itself", async () => {
    const [a, b] = await connect();
    const sent = await ctx.api("POST", `/api/messages/send/${b.id}`, {
      token: a.token,
      body: { text: "hi", call: { kind: "video", status: "completed", duration: 9999 } },
    });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.newMessage.call, undefined);
    close(a, b);
  });

  test("starting calls is limited per minute", async () => {
    const [a] = await connect(1);
    const b = await ctx.createUser();
    const reasons = [];
    for (let i = 0; i < 12; i += 1) reasons.push((await ask(a.socket, "call:start", { to: b.id, kind: "audio" })).reason);
    assert.equal(reasons.filter((reason) => reason === "offline").length, 10);
    assert.equal(reasons.at(-1), "rate_limited");
    close(a);
  });
});

describe("ICE servers", () => {
  test("need a login and offer STUN by default", async () => {
    assert.equal((await ctx.api("GET", "/api/calls/ice")).status, 401);
    const user = await ctx.createUser();
    const { status, body } = await ctx.api("GET", "/api/calls/ice", { token: user.token });
    assert.equal(status, 200);
    assert.equal(body.iceServers.length, 1);
    assert.match(body.iceServers[0].urls[0], /^stun:/);
    assert.equal(body.relay, false);
  });

  test("add short-lived logins from Cloudflare, and work without them when Cloudflare is down", async () => {
    Object.assign(process.env, { CLOUDFLARE_TURN_KEY_ID: "key-1", CLOUDFLARE_TURN_API_TOKEN: "token-1" });
    const user = await ctx.createUser();
    const realFetch = globalThis.fetch;
    const asked = [];
    let healthy = false;
    globalThis.fetch = async (url, options) => {
      if (!String(url).includes("rtc.live.cloudflare.com")) return realFetch(url, options);
      asked.push({ url: String(url), authorization: options.headers.Authorization });
      if (!healthy) return new Response("down", { status: 500 });
      return Response.json({
        iceServers: [
          { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
          { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "p" },
        ],
      });
    };
    try {
      const down = await ctx.api("GET", "/api/calls/ice", { token: user.token });
      assert.equal(down.status, 200);
      assert.equal(down.body.relay, false);

      healthy = true;
      const up = await ctx.api("GET", "/api/calls/ice", { token: user.token });
      assert.equal(up.body.relay, true);
      assert.match(asked[1].url, /\/keys\/key-1\/credentials\/generate-ice-servers$/);
      assert.equal(asked[1].authorization, "Bearer token-1");
      const turn = up.body.iceServers.at(-1);
      assert.equal(turn.username, "u");
      // port 53 is dropped, browsers do not connect to it
      assert.deepEqual(turn.urls, ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"]);

      // the login is reused instead of asking Cloudflare for every call
      await ctx.api("GET", "/api/calls/ice", { token: user.token });
      assert.equal(asked.length, 2);
    } finally {
      globalThis.fetch = realFetch;
      ["CLOUDFLARE_TURN_KEY_ID", "CLOUDFLARE_TURN_API_TOKEN"].forEach((key) => delete process.env[key]);
    }
  });

  test("add the TURN server from the environment", async () => {
    Object.assign(process.env, { TURN_URLS: "turn:turn.example.com:3478, turns:turn.example.com:5349", TURN_USERNAME: "u", TURN_CREDENTIAL: "p" });
    const user = await ctx.createUser();
    const { body } = await ctx.api("GET", "/api/calls/ice", { token: user.token });
    ["TURN_URLS", "TURN_USERNAME", "TURN_CREDENTIAL"].forEach((key) => delete process.env[key]);
    assert.deepEqual(body.iceServers[1], {
      urls: ["turn:turn.example.com:3478", "turns:turn.example.com:5349"],
      username: "u",
      credential: "p",
    });
  });
});
