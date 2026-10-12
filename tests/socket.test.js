import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { startTestServer, waitForEvent } from "./helpers.js";

let ctx;
before(async () => {
  ctx = await startTestServer();
});
after(() => ctx.stop());

const onlineIncludes = (id) => ({ filter: (ids) => ids.includes(id) });
const onlineExcludes = (id) => ({ filter: (ids) => !ids.includes(id) });

describe("socket authentication", () => {
  test("rejects a connection without a token", async () => {
    await assert.rejects(ctx.connectSocket({}), /Unauthorized/);
  });

  test("rejects a claimed userId without a token (the old impersonation hole)", async () => {
    const victim = await ctx.createUser();
    await assert.rejects(ctx.connectSocket({ userId: victim.id }), /Unauthorized/);
  });

  test("rejects a forged token", async () => {
    const victim = await ctx.createUser();
    const forged = jwt.sign({ id: victim.id }, "attacker-secret");
    await assert.rejects(ctx.connectSocket({ token: forged }), /Unauthorized/);
  });

  test("rejects the token of a deleted user", async () => {
    const user = await ctx.createUser();
    await ctx.User.findByIdAndDelete(user.id);
    await assert.rejects(ctx.connectSocket({ token: user.token }), /Unauthorized/);
  });

  test("ignores a userId that does not match the token", async () => {
    const [attacker, victim] = [await ctx.createUser(), await ctx.createUser()];
    const sender = await ctx.createUser();
    const socket = await ctx.connectSocket({ token: attacker.token, userId: victim.id });

    let leaked = false;
    socket.on("newMessage", () => (leaked = true));
    await ctx.api("POST", `/api/messages/send/${victim.id}`, { token: sender.token, body: { text: "private" } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(leaked, false);
    socket.close();
  });
});

describe("realtime", () => {
  test("delivers a new message only to the receiver", async () => {
    const [a, b, c] = [await ctx.createUser(), await ctx.createUser(), await ctx.createUser()];
    const socketB = await ctx.connectSocket({ token: b.token });
    const socketC = await ctx.connectSocket({ token: c.token });

    let leaked = false;
    socketC.on("newMessage", () => (leaked = true));

    const received = waitForEvent(socketB, "newMessage");
    await ctx.api("POST", `/api/messages/send/${b.id}`, { token: a.token, body: { text: "hey b" } });
    const message = await received;

    assert.equal(message.text, "hey b");
    assert.equal(message.senderId, a.id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(leaked, false);
    socketB.close();
    socketC.close();
  });

  test("delivers to every open tab of the receiver", async () => {
    const [a, b] = [await ctx.createUser(), await ctx.createUser()];
    const tab1 = await ctx.connectSocket({ token: b.token });
    const tab2 = await ctx.connectSocket({ token: b.token });

    const both = Promise.all([waitForEvent(tab1, "newMessage"), waitForEvent(tab2, "newMessage")]);
    await ctx.api("POST", `/api/messages/send/${b.id}`, { token: a.token, body: { text: "both tabs" } });
    const [m1, m2] = await both;
    assert.equal(m1._id, m2._id);
    tab1.close();
    tab2.close();
  });

  test("relays typing to the other person with the real sender id", async () => {
    const [a, b, c] = [await ctx.createUser(), await ctx.createUser(), await ctx.createUser()];
    const socketA = await ctx.connectSocket({ token: a.token });
    const socketB = await ctx.connectSocket({ token: b.token });
    const socketC = await ctx.connectSocket({ token: c.token });

    let leaked = false;
    socketC.on("typing", () => (leaked = true));

    const typing = waitForEvent(socketB, "typing");
    // "from" is ignored, nobody can type as somebody else
    socketA.emit("typing", { to: b.id, isTyping: true, from: c.id });
    assert.deepEqual(await typing, { from: a.id, isTyping: true });

    const stopped = waitForEvent(socketB, "typing");
    socketA.emit("typing", { to: b.id, isTyping: false });
    assert.deepEqual(await stopped, { from: a.id, isTyping: false });

    // bad payloads are dropped without crashing the server
    socketA.emit("typing", null);
    socketA.emit("typing", { to: { $ne: null }, isTyping: true });
    socketA.emit("typing", { to: "not-an-id", isTyping: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(leaked, false);
    assert.equal((await ctx.api("GET", "/api/status")).status, 200);
    [socketA, socketB, socketC].forEach((socket) => socket.close());
  });

  test("tells the sender when their messages are read", async () => {
    const [a, b] = [await ctx.createUser(), await ctx.createUser()];
    const socketA = await ctx.connectSocket({ token: a.token });

    // b opens the chat
    await ctx.api("POST", `/api/messages/send/${b.id}`, { token: a.token, body: { text: "one" } });
    const seenOnOpen = waitForEvent(socketA, "messagesSeen");
    await ctx.api("GET", `/api/messages/${a.id}`, { token: b.token });
    assert.deepEqual(await seenOnOpen, { by: b.id });

    // b marks a single message while the chat is already open
    const { body } = await ctx.api("POST", `/api/messages/send/${b.id}`, { token: a.token, body: { text: "two" } });
    const seenOnMark = waitForEvent(socketA, "messagesSeen");
    await ctx.api("PUT", `/api/messages/mark/${body.newMessage._id}`, { token: b.token });
    assert.deepEqual(await seenOnMark, { by: b.id });

    const users = await ctx.api("GET", "/api/messages/users", { token: a.token });
    assert.equal(users.body.lastMessages[b.id].seen, true);
    socketA.close();
  });

  test("tracks who is online across tabs", async () => {
    const [a, b] = [await ctx.createUser(), await ctx.createUser()];
    const watcher = await ctx.connectSocket({ token: a.token });

    const cameOnline = waitForEvent(watcher, "getOnlineUsers", onlineIncludes(b.id));
    const tab1 = await ctx.connectSocket({ token: b.token });
    await cameOnline;

    const tab2 = await ctx.connectSocket({ token: b.token });
    // closing one of two tabs must not show the user as offline
    const afterFirstClose = waitForEvent(watcher, "getOnlineUsers");
    tab1.close();
    assert.ok((await afterFirstClose).includes(b.id));

    const wentOffline = waitForEvent(watcher, "getOnlineUsers", onlineExcludes(b.id));
    tab2.close();
    await wentOffline;
    watcher.close();
  });
});
