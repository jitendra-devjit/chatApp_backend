import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { FAKE_IMAGE_URL, PNG_DATA_URI, startTestServer } from "./helpers.js";

let ctx;
before(async () => {
  ctx = await startTestServer();
});
after(() => ctx.stop());

const send = (from, to, body) => ctx.api("POST", `/api/messages/send/${to.id}`, { token: from.token, body });

describe("send message", () => {
  test("saves a text message", async () => {
    const [a, b] = [await ctx.createUser(), await ctx.createUser()];
    const res = await send(a, b, { text: "  hello  " });
    assert.equal(res.status, 201);
    assert.equal(res.body.newMessage.text, "hello");
    assert.equal(res.body.newMessage.senderId, a.id);
    assert.equal(res.body.newMessage.receiverId, b.id);
    assert.equal(res.body.newMessage.seen, false);
  });

  test("the sender is always the logged in user", async () => {
    const [a, b, c] = [await ctx.createUser(), await ctx.createUser(), await ctx.createUser()];
    const res = await send(a, b, { text: "hi", senderId: c.id, seen: true });
    assert.equal(res.body.newMessage.senderId, a.id);
    assert.equal(res.body.newMessage.seen, false);
  });

  test("saves an image message", async () => {
    const [a, b] = [await ctx.createUser(), await ctx.createUser()];
    const res = await send(a, b, { image: PNG_DATA_URI });
    assert.equal(res.status, 201);
    assert.equal(res.body.newMessage.image, FAKE_IMAGE_URL);
  });

  test("keeps html as plain text", async () => {
    const [a, b] = [await ctx.createUser(), await ctx.createUser()];
    const payload = '<img src=x onerror="alert(1)">';
    const res = await send(a, b, { text: payload });
    assert.equal(res.body.newMessage.text, payload); // React escapes it when rendering
  });

  test("needs a token", async () => {
    const b = await ctx.createUser();
    const res = await ctx.api("POST", `/api/messages/send/${b.id}`, { body: { text: "hi" } });
    assert.equal(res.status, 401);
  });

  test("rejects bad input", async () => {
    const [a, b] = [await ctx.createUser(), await ctx.createUser()];
    const cases = [
      [{}, 400],
      [{ text: "   " }, 400],
      [{ text: "x".repeat(2001) }, 400],
      [{ text: { $ne: null } }, 400],
      [{ image: "data:text/html;base64,PGI+" }, 400],
      [{ image: "https://evil.example.com/a.png" }, 400],
    ];
    for (const [body, status] of cases) {
      const res = await send(a, b, body);
      assert.equal(res.status, status, JSON.stringify(body).slice(0, 60));
    }
  });

  test("rejects an invalid, unknown or own receiver id", async () => {
    const a = await ctx.createUser();
    const invalid = await ctx.api("POST", "/api/messages/send/not-an-id", { token: a.token, body: { text: "hi" } });
    assert.equal(invalid.status, 400);
    const unknown = await ctx.api("POST", "/api/messages/send/64b7f0c2a1b2c3d4e5f60718", {
      token: a.token,
      body: { text: "hi" },
    });
    assert.equal(unknown.status, 404);
    const self = await send(a, a, { text: "hi" });
    assert.equal(self.status, 400);
  });
});

describe("get messages", () => {
  test("returns only the conversation between the two users, oldest first", async () => {
    const [a, b, c] = [await ctx.createUser(), await ctx.createUser(), await ctx.createUser()];
    await send(a, b, { text: "one" });
    await send(b, a, { text: "two" });
    await send(a, c, { text: "secret for c" });

    const res = await ctx.api("GET", `/api/messages/${b.id}`, { token: a.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.messages.map((m) => m.text), ["one", "two"]);
    assert.equal(res.body.hasMore, false);

    // b cannot read what a wrote to c
    const other = await ctx.api("GET", `/api/messages/${c.id}`, { token: b.token });
    assert.deepEqual(other.body.messages, []);
  });

  test("marks received messages as seen, not sent ones", async () => {
    const [a, b] = [await ctx.createUser(), await ctx.createUser()];
    await send(a, b, { text: "to b" });
    await send(b, a, { text: "to a" });

    await ctx.api("GET", `/api/messages/${b.id}`, { token: a.token });
    const toA = await ctx.Message.findOne({ text: "to a", receiverId: a.id });
    const toB = await ctx.Message.findOne({ text: "to b", receiverId: b.id });
    assert.equal(toA.seen, true);
    assert.equal(toB.seen, false);
  });

  test("pages through history with limit and before", async () => {
    const [a, b] = [await ctx.createUser(), await ctx.createUser()];
    for (let i = 1; i <= 5; i++) await send(a, b, { text: `m${i}` });

    const latest = await ctx.api("GET", `/api/messages/${b.id}?limit=2`, { token: a.token });
    assert.deepEqual(latest.body.messages.map((m) => m.text), ["m4", "m5"]);
    assert.equal(latest.body.hasMore, true);

    const before = encodeURIComponent(latest.body.messages[0].createdAt);
    const older = await ctx.api("GET", `/api/messages/${b.id}?limit=2&before=${before}`, { token: a.token });
    assert.deepEqual(older.body.messages.map((m) => m.text), ["m2", "m3"]);
    assert.equal(older.body.hasMore, true);

    const oldestCursor = encodeURIComponent(older.body.messages[0].createdAt);
    const oldest = await ctx.api("GET", `/api/messages/${b.id}?limit=2&before=${oldestCursor}`, { token: a.token });
    assert.deepEqual(oldest.body.messages.map((m) => m.text), ["m1"]);
    assert.equal(oldest.body.hasMore, false);
  });

  test("caps the page size and rejects bad input", async () => {
    const [a, b] = [await ctx.createUser(), await ctx.createUser()];
    const huge = await ctx.api("GET", `/api/messages/${b.id}?limit=999999`, { token: a.token });
    assert.equal(huge.status, 200);
    const badDate = await ctx.api("GET", `/api/messages/${b.id}?before=yesterday`, { token: a.token });
    assert.equal(badDate.status, 400);
    const badId = await ctx.api("GET", "/api/messages/123", { token: a.token });
    assert.equal(badId.status, 400);
    const noToken = await ctx.api("GET", `/api/messages/${b.id}`);
    assert.equal(noToken.status, 401);
  });
});

describe("mark as seen", () => {
  test("only the receiver can mark a message as seen", async () => {
    const [a, b, c] = [await ctx.createUser(), await ctx.createUser(), await ctx.createUser()];
    const { body } = await send(a, b, { text: "hi" });
    const id = body.newMessage._id;

    const bySender = await ctx.api("PUT", `/api/messages/mark/${id}`, { token: a.token });
    const byStranger = await ctx.api("PUT", `/api/messages/mark/${id}`, { token: c.token });
    assert.equal(bySender.status, 404);
    assert.equal(byStranger.status, 404);
    assert.equal((await ctx.Message.findById(id)).seen, false);

    const byReceiver = await ctx.api("PUT", `/api/messages/mark/${id}`, { token: b.token });
    assert.equal(byReceiver.status, 200);
    assert.equal((await ctx.Message.findById(id)).seen, true);
  });

  test("rejects an invalid id and a missing token", async () => {
    const a = await ctx.createUser();
    const invalid = await ctx.api("PUT", "/api/messages/mark/abc", { token: a.token });
    assert.equal(invalid.status, 400);
    const noToken = await ctx.api("PUT", "/api/messages/mark/64b7f0c2a1b2c3d4e5f60718");
    assert.equal(noToken.status, 401);
  });
});

describe("users for sidebar", () => {
  test("lists other users without private fields", async () => {
    const [a, b] = [await ctx.createUser(), await ctx.createUser()];
    const res = await ctx.api("GET", "/api/messages/users", { token: a.token });
    assert.equal(res.status, 200);

    const ids = res.body.users.map((u) => u._id);
    assert.ok(ids.includes(b.id));
    assert.ok(!ids.includes(a.id));
    for (const user of res.body.users) {
      assert.equal(user.password, undefined);
      assert.equal(user.email, undefined);
    }
    assert.ok(!res.text.includes("$2")); // no password hash leaks
    assert.ok(!res.text.includes("@example.com"));
  });

  test("returns unseen counts and the last message per conversation", async () => {
    const [a, b, c] = [await ctx.createUser(), await ctx.createUser(), await ctx.createUser()];
    await send(b, a, { text: "first" });
    await send(b, a, { text: "second" });
    await send(a, c, { image: PNG_DATA_URI });

    const res = await ctx.api("GET", "/api/messages/users", { token: a.token });
    assert.equal(res.body.unseenMessages[b.id], 2);
    assert.equal(res.body.unseenMessages[c.id], undefined); // a sent it, nothing unseen for a
    assert.equal(res.body.lastMessages[b.id].text, "second");
    assert.equal(res.body.lastMessages[b.id].senderId, b.id);
    assert.equal(res.body.lastMessages[c.id].hasImage, true);

    // opening the chat clears the count
    await ctx.api("GET", `/api/messages/${b.id}`, { token: a.token });
    const after = await ctx.api("GET", "/api/messages/users", { token: a.token });
    assert.equal(after.body.unseenMessages[b.id], undefined);
  });

  test("needs a token", async () => {
    const res = await ctx.api("GET", "/api/messages/users");
    assert.equal(res.status, 401);
  });
});
