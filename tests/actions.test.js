import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { PNG_DATA_URI, startTestServer, waitForEvent } from "./helpers.js";

let ctx;
before(async () => {
  ctx = await startTestServer();
});
after(() => ctx.stop());

const send = async (from, to, body) => {
  const res = await ctx.api("POST", `/api/messages/send/${to.id}`, { token: from.token, body });
  assert.equal(res.status, 201, res.text);
  return res.body.newMessage;
};
const trio = async () => [await ctx.createUser(), await ctx.createUser(), await ctx.createUser()];

describe("reply", () => {
  test("a reply carries the quoted message", async () => {
    const [a, b] = await trio();
    const first = await send(a, b, { text: "are you coming?" });
    const reply = await send(b, a, { text: "yes!", replyTo: first._id });
    assert.equal(reply.replyTo._id, first._id);
    assert.equal(reply.replyTo.text, "are you coming?");
    assert.equal(reply.replyTo.senderId, a.id);

    const history = await ctx.api("GET", `/api/messages/${b.id}`, { token: a.token });
    assert.equal(history.body.messages[1].replyTo.text, "are you coming?");
    assert.equal(history.body.messages[0].replyTo, undefined);
  });

  test("cannot quote a message from somebody else's conversation", async () => {
    const [a, b, c] = await trio();
    const secret = await send(a, b, { text: "only for b" });
    const res = await ctx.api("POST", `/api/messages/send/${a.id}`, {
      token: c.token,
      body: { text: "what did you say?", replyTo: secret._id },
    });
    assert.equal(res.status, 404);
    assert.ok(!res.text.includes("only for b"));
  });

  test("rejects a malformed reply id", async () => {
    const [a, b] = await trio();
    for (const replyTo of ["nope", { $ne: null }, 42]) {
      const res = await ctx.api("POST", `/api/messages/send/${b.id}`, { token: a.token, body: { text: "hi", replyTo } });
      assert.equal(res.status, 400);
    }
  });
});

describe("edit", () => {
  test("the sender can edit and both people are told", async () => {
    const [a, b] = await trio();
    const message = await send(a, b, { text: "helo" });
    const [socketA, socketB] = [await ctx.connectSocket({ token: a.token }), await ctx.connectSocket({ token: b.token })];
    const told = Promise.all([waitForEvent(socketA, "messageUpdated"), waitForEvent(socketB, "messageUpdated")]);

    const res = await ctx.api("PUT", `/api/messages/${message._id}`, { token: a.token, body: { text: "  hello  " } });
    assert.equal(res.status, 200);
    assert.equal(res.body.message.text, "hello");
    assert.ok(res.body.message.editedAt);
    const [forA, forB] = await told;
    assert.equal(forA.text, "hello");
    assert.equal(forB._id, message._id);
    socketA.close();
    socketB.close();
  });

  test("nobody else can edit it", async () => {
    const [a, b, c] = await trio();
    const message = await send(a, b, { text: "original" });
    const byReceiver = await ctx.api("PUT", `/api/messages/${message._id}`, { token: b.token, body: { text: "hacked" } });
    const byStranger = await ctx.api("PUT", `/api/messages/${message._id}`, { token: c.token, body: { text: "hacked" } });
    assert.equal(byReceiver.status, 403);
    assert.equal(byStranger.status, 404);
    assert.equal((await ctx.Message.findById(message._id)).text, "original");
  });

  test("rejects empty, too long and non-string text", async () => {
    const [a, b] = await trio();
    const message = await send(a, b, { text: "original" });
    for (const text of ["   ", "x".repeat(2001), { $ne: null }, undefined]) {
      const res = await ctx.api("PUT", `/api/messages/${message._id}`, { token: a.token, body: { text } });
      assert.equal(res.status, 400);
    }
  });

  test("cannot edit after 15 minutes or after deleting", async () => {
    const [a, b] = await trio();
    const old = await send(a, b, { text: "old" });
    // createdAt cannot be changed through mongoose, so the test writes to the collection directly
    const stored = await ctx.Message.findById(old._id);
    await ctx.Message.collection.updateOne({ _id: stored._id }, { $set: { createdAt: new Date(Date.now() - 16 * 60 * 1000) } });
    const late = await ctx.api("PUT", `/api/messages/${old._id}`, { token: a.token, body: { text: "new" } });
    assert.equal(late.status, 400);

    const gone = await send(a, b, { text: "gone" });
    await ctx.api("DELETE", `/api/messages/${gone._id}`, { token: a.token });
    const res = await ctx.api("PUT", `/api/messages/${gone._id}`, { token: a.token, body: { text: "back" } });
    assert.equal(res.status, 400);
  });
});

describe("delete for everyone", () => {
  test("wipes the content but keeps the row", async () => {
    const [a, b] = await trio();
    const message = await send(a, b, { text: "oops", image: PNG_DATA_URI });
    await ctx.api("PUT", `/api/messages/${message._id}/reaction`, { token: b.token, body: { emoji: "👍" } });
    const socketB = await ctx.connectSocket({ token: b.token });
    const told = waitForEvent(socketB, "messageUpdated");

    const res = await ctx.api("DELETE", `/api/messages/${message._id}`, { token: a.token });
    assert.equal(res.status, 200);
    assert.ok(res.body.message.deletedAt);
    assert.equal(res.body.message.text, undefined);
    assert.equal(res.body.message.image, undefined);
    assert.deepEqual(res.body.message.reactions, []);
    assert.ok((await told).deletedAt);

    const stored = await ctx.Message.findById(message._id);
    assert.equal(stored.text, undefined);
    assert.equal(stored.image, undefined);

    const users = await ctx.api("GET", "/api/messages/users", { token: b.token });
    assert.equal(users.body.lastMessages[a.id].deleted, true);
    assert.equal(users.body.lastMessages[a.id].text, "");
    socketB.close();
  });

  test("a reply to a deleted message no longer shows its text", async () => {
    const [a, b] = await trio();
    const first = await send(a, b, { text: "embarrassing" });
    await send(b, a, { text: "lol", replyTo: first._id });
    await ctx.api("DELETE", `/api/messages/${first._id}`, { token: a.token });

    const history = await ctx.api("GET", `/api/messages/${a.id}`, { token: b.token });
    assert.ok(!history.text.includes("embarrassing"));
    assert.ok(history.body.messages[1].replyTo.deletedAt);
  });

  test("only the sender can delete", async () => {
    const [a, b, c] = await trio();
    const message = await send(a, b, { text: "mine" });
    assert.equal((await ctx.api("DELETE", `/api/messages/${message._id}`, { token: b.token })).status, 403);
    assert.equal((await ctx.api("DELETE", `/api/messages/${message._id}`, { token: c.token })).status, 404);
    assert.equal((await ctx.api("DELETE", `/api/messages/${message._id}`)).status, 401);
    assert.equal((await ctx.api("DELETE", "/api/messages/not-an-id", { token: a.token })).status, 400);
    assert.equal((await ctx.Message.findById(message._id)).text, "mine");
  });
});

describe("reactions", () => {
  const react = (user, id, emoji) => ctx.api("PUT", `/api/messages/${id}/reaction`, { token: user.token, body: { emoji } });

  test("each person has one reaction, the same emoji again removes it", async () => {
    const [a, b] = await trio();
    const message = await send(a, b, { text: "great news" });

    let res = await react(b, message._id, "❤️");
    assert.deepEqual(res.body.message.reactions, [{ userId: b.id, emoji: "❤️" }]);

    res = await react(b, message._id, "😂"); // replaces
    assert.deepEqual(res.body.message.reactions, [{ userId: b.id, emoji: "😂" }]);

    res = await react(a, message._id, "👍"); // the sender can react too
    assert.equal(res.body.message.reactions.length, 2);

    res = await react(b, message._id, "😂"); // toggles off
    assert.deepEqual(res.body.message.reactions, [{ userId: a.id, emoji: "👍" }]);

    res = await react(a, message._id, ""); // empty removes
    assert.deepEqual(res.body.message.reactions, []);
  });

  test("both people are told", async () => {
    const [a, b] = await trio();
    const message = await send(a, b, { text: "hi" });
    const socketA = await ctx.connectSocket({ token: a.token });
    const told = waitForEvent(socketA, "messageUpdated");
    await react(b, message._id, "🔥");
    assert.deepEqual((await told).reactions, [{ userId: b.id, emoji: "🔥" }]);
    socketA.close();
  });

  test("outsiders cannot react and bad input is rejected", async () => {
    const [a, b, c] = await trio();
    const message = await send(a, b, { text: "hi" });
    assert.equal((await react(c, message._id, "👍")).status, 404);
    for (const emoji of ["hello", "<b>", "👍".repeat(10), { $ne: null }, 5]) {
      assert.equal((await react(b, message._id, emoji)).status, 400, JSON.stringify(emoji));
    }
    assert.deepEqual((await ctx.Message.findById(message._id)).reactions.toObject(), []);
  });

  test("cannot react to a deleted message", async () => {
    const [a, b] = await trio();
    const message = await send(a, b, { text: "hi" });
    await ctx.api("DELETE", `/api/messages/${message._id}`, { token: a.token });
    assert.equal((await react(b, message._id, "👍")).status, 400);
  });
});

describe("last seen", () => {
  test("is saved and announced when the last tab closes", async () => {
    const [a, b] = await trio();
    const watcher = await ctx.connectSocket({ token: a.token });
    const tab1 = await ctx.connectSocket({ token: b.token });
    const tab2 = await ctx.connectSocket({ token: b.token });

    let announced = null;
    watcher.on("lastSeen", (payload) => {
      if (payload.userId === b.id) announced = payload;
    });

    tab1.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(announced, null); // still online in the other tab

    const before = Date.now();
    tab2.close();
    await waitForEvent(watcher, "lastSeen", { filter: (payload) => payload.userId === b.id });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(new Date(announced.lastSeen).getTime() >= before - 1000);

    const users = await ctx.api("GET", "/api/messages/users", { token: a.token });
    const listed = users.body.users.find((user) => user._id === b.id);
    assert.ok(new Date(listed.lastSeen).getTime() >= before - 1000);
    watcher.close();
  });
});
