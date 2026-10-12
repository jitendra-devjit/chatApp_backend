import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { FAKE_IMAGE_ID, PNG_DATA_URI, startTestServer, waitForEvent } from "./helpers.js";

let ctx;
before(async () => {
  ctx = await startTestServer();
});
after(() => ctx.stop());

const people = (count) => Promise.all(Array.from({ length: count }, () => ctx.createUser()));

const createGroup = async (owner, members, extra = {}) => {
  const res = await ctx.api("POST", "/api/groups", {
    token: owner.token,
    body: { name: "Weekend trip", memberIds: members.map((user) => user.id), ...extra },
  });
  assert.equal(res.status, 201, res.text);
  return res.body.group;
};
const say = async (user, group, body) => {
  const res = await ctx.api("POST", `/api/groups/${group._id}/messages`, { token: user.token, body });
  assert.equal(res.status, 201, res.text);
  return res.body.newMessage;
};
const history = (user, group, query = "") => ctx.api("GET", `/api/groups/${group._id}/messages${query}`, { token: user.token });
const roleOf = (group, user) => group.members.find((member) => member.user._id === user.id)?.role;

describe("create a group", () => {
  test("the creator is admin, everybody is told and gets the group in their list", async () => {
    const [a, b, c] = await people(3);
    const socketB = await ctx.connectSocket({ token: b.token });
    const told = waitForEvent(socketB, "groupUpdated");

    const group = await createGroup(a, [b, c], { description: "Goa in December" });
    assert.equal(group.name, "Weekend trip");
    assert.equal(group.members.length, 3);
    assert.equal(roleOf(group, a), "admin");
    assert.equal(roleOf(group, b), "member");
    assert.equal((await told)._id, group._id);

    const list = await ctx.api("GET", "/api/groups", { token: c.token });
    assert.deepEqual(list.body.groups.map((item) => item._id), [group._id]);
    assert.equal(list.body.lastMessages[group._id].system, true);
    socketB.close();
  });

  test("members never expose private fields", async () => {
    const [a, b] = await people(2);
    await createGroup(a, [b]);
    const list = await ctx.api("GET", "/api/groups", { token: b.token });
    assert.ok(!list.text.includes("@example.com"));
    assert.ok(!list.text.includes("$2"));
    assert.ok(!list.text.includes("pinnedChats"));
  });

  test("rejects bad input", async () => {
    const [a, b] = await people(2);
    const cases = [
      { name: "x", memberIds: [b.id] },
      { name: "x".repeat(51), memberIds: [b.id] },
      { name: { $ne: null }, memberIds: [b.id] },
      { name: "No members", memberIds: [] },
      { name: "Only me", memberIds: [a.id] },
      { name: "Not a list", memberIds: b.id },
      { name: "Bad id", memberIds: ["nope"] },
      { name: "Injection", memberIds: [{ $ne: null }] },
      { name: "Bad picture", memberIds: [b.id], avatar: "data:text/html;base64,PGI+" },
    ];
    for (const body of cases) {
      const res = await ctx.api("POST", "/api/groups", { token: a.token, body });
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    }
    const ghost = await ctx.api("POST", "/api/groups", { token: a.token, body: { name: "Ghost", memberIds: ["64b7f0c2a1b2c3d4e5f60718"] } });
    assert.equal(ghost.status, 404);
    assert.equal((await ctx.api("POST", "/api/groups", { body: { name: "Anon", memberIds: [b.id] } })).status, 401);
  });
});

describe("group messages", () => {
  test("reach every other member in real time, with reply support", async () => {
    const [a, b, c, outsider] = await people(4);
    const group = await createGroup(a, [b, c]);
    const [socketB, socketC, socketX] = await Promise.all([b, c, outsider].map((user) => ctx.connectSocket({ token: user.token })));
    let leaked = false;
    socketX.on("newMessage", () => (leaked = true));

    const got = Promise.all([waitForEvent(socketB, "newMessage"), waitForEvent(socketC, "newMessage")]);
    const first = await say(a, group, { text: "who is driving?" });
    const [forB] = await got;
    assert.equal(forB.groupId, group._id);
    assert.equal(forB.senderId, a.id);
    assert.equal(first.receiverId, undefined);

    const reply = await say(b, group, { text: "me", replyTo: first._id });
    assert.equal(reply.replyTo.text, "who is driving?");

    const res = await history(c, group);
    assert.deepEqual(res.body.messages.filter((m) => !m.system).map((m) => m.text), ["who is driving?", "me"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(leaked, false);
    [socketB, socketC, socketX].forEach((socket) => socket.close());
  });

  test("outsiders cannot read, write, search or even see that the group exists", async () => {
    const [a, b, outsider] = await people(3);
    const group = await createGroup(a, [b]);
    await say(a, group, { text: "top secret plan" });
    const t = { token: outsider.token };

    assert.equal((await history(outsider, group)).status, 404);
    assert.equal((await ctx.api("POST", `/api/groups/${group._id}/messages`, { ...t, body: { text: "hi" } })).status, 404);
    assert.equal((await ctx.api("GET", `/api/groups/${group._id}/search?q=secret`, t)).status, 404);
    assert.equal((await ctx.api("PUT", `/api/groups/${group._id}`, { ...t, body: { name: "Hacked" } })).status, 404);
    assert.equal((await ctx.api("POST", `/api/groups/${group._id}/members`, { ...t, body: { userIds: [outsider.id] } })).status, 404);
    assert.deepEqual((await ctx.api("GET", "/api/groups", t)).body.groups, []);
    assert.equal((await history(a, { _id: "not-an-id" })).status, 400);
  });

  test("an outsider cannot quote, edit, delete or react to a group message", async () => {
    const [a, b, outsider] = await people(3);
    const group = await createGroup(a, [b]);
    const message = await say(a, group, { text: "for members only" });
    const t = { token: outsider.token };

    const quote = await ctx.api("POST", `/api/messages/send/${a.id}`, { ...t, body: { text: "?", replyTo: message._id } });
    assert.equal(quote.status, 404);
    assert.equal((await ctx.api("PUT", `/api/messages/${message._id}`, { ...t, body: { text: "x" } })).status, 404);
    assert.equal((await ctx.api("DELETE", `/api/messages/${message._id}`, t)).status, 404);
    assert.equal((await ctx.api("PUT", `/api/messages/${message._id}/reaction`, { ...t, body: { emoji: "👍" } })).status, 404);
  });

  test("members can react, only the sender can edit or delete, all members are told", async () => {
    const [a, b, c] = await people(3);
    const group = await createGroup(a, [b, c]);
    const message = await say(a, group, { text: "helo team" });
    const socketC = await ctx.connectSocket({ token: c.token });

    const reacted = waitForEvent(socketC, "messageUpdated");
    await ctx.api("PUT", `/api/messages/${message._id}/reaction`, { token: b.token, body: { emoji: "🔥" } });
    assert.deepEqual((await reacted).reactions, [{ userId: b.id, emoji: "🔥" }]);

    assert.equal((await ctx.api("PUT", `/api/messages/${message._id}`, { token: b.token, body: { text: "x" } })).status, 403);
    assert.equal((await ctx.api("DELETE", `/api/messages/${message._id}`, { token: b.token })).status, 403);

    const edited = waitForEvent(socketC, "messageUpdated");
    await ctx.api("PUT", `/api/messages/${message._id}`, { token: a.token, body: { text: "hello team" } });
    assert.equal((await edited).text, "hello team");
    socketC.close();
  });

  test("system lines cannot be edited, deleted or reacted to", async () => {
    const [a, b] = await people(2);
    const group = await createGroup(a, [b]);
    const line = (await history(a, group)).body.messages.find((m) => m.system);
    assert.match(line.text, /created the group/);
    assert.equal((await ctx.api("DELETE", `/api/messages/${line._id}`, { token: a.token })).status, 404);
    assert.equal((await ctx.api("PUT", `/api/messages/${line._id}/reaction`, { token: a.token, body: { emoji: "👍" } })).status, 404);
  });

  test("unread counts are per member and reading tells the others", async () => {
    const [a, b, c] = await people(3);
    const group = await createGroup(a, [b, c]);
    await say(a, group, { text: "one" });
    await say(a, group, { text: "two" });
    await say(b, group, { text: "three" });

    const listFor = async (user) => (await ctx.api("GET", "/api/groups", { token: user.token })).body;
    assert.equal((await listFor(c)).unseenMessages[group._id], 3);
    assert.equal((await listFor(b)).unseenMessages[group._id], undefined); // b wrote last, so b has read it all
    assert.equal((await listFor(a)).unseenMessages[group._id], 1);
    assert.equal((await listFor(c)).lastMessages[group._id].text, "three");

    const socketA = await ctx.connectSocket({ token: a.token });
    const read = waitForEvent(socketA, "groupRead", { filter: (payload) => payload.userId === c.id });
    await history(c, group);
    const payload = await read;
    assert.equal(payload.groupId, group._id);
    assert.ok(payload.lastReadAt);
    assert.equal((await listFor(c)).unseenMessages[group._id], undefined);

    await say(a, group, { text: "four" });
    assert.equal((await listFor(c)).unseenMessages[group._id], 1);
    assert.equal((await ctx.api("PUT", `/api/groups/${group._id}/read`, { token: c.token })).status, 200);
    assert.equal((await listFor(c)).unseenMessages[group._id], undefined);
    socketA.close();
  });

  test("group messages never show up in one-to-one chats", async () => {
    const [a, b] = await people(2);
    const group = await createGroup(a, [b]);
    await say(a, group, { text: "group only" });
    const direct = await ctx.api("GET", `/api/messages/${a.id}`, { token: b.token });
    assert.deepEqual(direct.body.messages, []);
    const sidebar = await ctx.api("GET", "/api/messages/users", { token: b.token });
    assert.deepEqual(sidebar.body.lastMessages, {});
    assert.deepEqual(sidebar.body.unseenMessages, {});
  });
});

describe("group members", () => {
  test("an admin adds people, who only see messages from then on", async () => {
    const [a, b, late] = await people(3);
    const group = await createGroup(a, [b]);
    await say(a, group, { text: "before you joined" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const lateSocket = await ctx.connectSocket({ token: late.token });
    const told = waitForEvent(lateSocket, "groupUpdated");
    const res = await ctx.api("POST", `/api/groups/${group._id}/members`, { token: a.token, body: { userIds: [late.id, b.id] } });
    assert.equal(res.status, 200);
    assert.equal(res.body.group.members.length, 3);
    await told;

    await say(a, group, { text: "welcome" });
    const seen = await history(late, group);
    assert.ok(!seen.text.includes("before you joined"));
    assert.ok(seen.text.includes("welcome"));
    const search = await ctx.api("GET", `/api/groups/${group._id}/search?q=before`, { token: late.token });
    assert.deepEqual(search.body.results, []);
    lateSocket.close();
  });

  test("only admins add, remove, rename and change roles", async () => {
    const [a, b, c, d] = await people(4);
    const group = await createGroup(a, [b, c]);
    const asB = { token: b.token };
    assert.equal((await ctx.api("POST", `/api/groups/${group._id}/members`, { ...asB, body: { userIds: [d.id] } })).status, 403);
    assert.equal((await ctx.api("DELETE", `/api/groups/${group._id}/members/${c.id}`, asB)).status, 403);
    assert.equal((await ctx.api("PUT", `/api/groups/${group._id}`, { ...asB, body: { name: "Mine now" } })).status, 403);
    assert.equal((await ctx.api("PUT", `/api/groups/${group._id}/members/${b.id}`, { ...asB, body: { role: "admin" } })).status, 403);
  });

  test("an admin renames the group, with a line in the chat", async () => {
    const [a, b] = await people(2);
    const group = await createGroup(a, [b]);
    const res = await ctx.api("PUT", `/api/groups/${group._id}`, { token: a.token, body: { name: "  Goa 2026  ", description: "Flights booked" } });
    assert.equal(res.body.group.name, "Goa 2026");
    assert.equal(res.body.group.description, "Flights booked");
    assert.ok((await history(b, group)).text.includes('renamed the group to \\"Goa 2026\\"'));
    assert.equal((await ctx.api("PUT", `/api/groups/${group._id}`, { token: a.token, body: { name: "x" } })).status, 400);
  });

  test("a removed member is told and loses access", async () => {
    const [a, b, c] = await people(3);
    const group = await createGroup(a, [b, c]);
    const socketC = await ctx.connectSocket({ token: c.token });
    const removed = waitForEvent(socketC, "groupRemoved");

    const res = await ctx.api("DELETE", `/api/groups/${group._id}/members/${c.id}`, { token: a.token });
    assert.equal(res.body.group.members.length, 2);
    assert.deepEqual(await removed, { groupId: group._id });
    assert.equal((await history(c, group)).status, 404);
    assert.equal((await ctx.api("DELETE", `/api/groups/${group._id}/members/${c.id}`, { token: a.token })).status, 404);
    socketC.close();
  });

  test("roles can be changed but the last admin cannot step down", async () => {
    const [a, b] = await people(2);
    const group = await createGroup(a, [b]);
    const setRole = (target, role) => ctx.api("PUT", `/api/groups/${group._id}/members/${target.id}`, { token: a.token, body: { role } });

    assert.equal((await setRole(a, "member")).status, 400);
    assert.equal(roleOf((await setRole(b, "admin")).body.group, b), "admin");
    assert.equal(roleOf((await setRole(a, "member")).body.group, a), "member");
    assert.equal((await setRole(b, "member")).status, 403); // a is no admin any more
    assert.equal((await ctx.api("PUT", `/api/groups/${group._id}/members/${a.id}`, { token: b.token, body: { role: "owner" } })).status, 400);
  });

  test("when the only admin leaves, the oldest member takes over", async () => {
    const [a, b, c] = await people(3);
    const group = await createGroup(a, [b, c]);
    const left = await ctx.api("DELETE", `/api/groups/${group._id}/members/${a.id}`, { token: a.token });
    assert.equal(left.status, 200);
    assert.equal(left.body.group, null);

    const list = await ctx.api("GET", "/api/groups", { token: b.token });
    const updated = list.body.groups[0];
    assert.equal(updated.members.length, 2);
    assert.equal(updated.members.filter((member) => member.role === "admin").length, 1);
    assert.deepEqual((await ctx.api("GET", "/api/groups", { token: a.token })).body.groups, []);
  });

  test("when the last member leaves, the group, its messages and pictures are deleted", async () => {
    const [a, b] = await people(2);
    const group = await createGroup(a, [b]);
    await say(a, group, { image: PNG_DATA_URI });
    ctx.destroyed.length = 0;

    await ctx.api("DELETE", `/api/groups/${group._id}/members/${b.id}`, { token: b.token });
    await ctx.api("DELETE", `/api/groups/${group._id}/members/${a.id}`, { token: a.token });
    assert.equal(await ctx.Message.countDocuments({ groupId: group._id }), 0);
    assert.deepEqual(ctx.destroyed, [FAKE_IMAGE_ID]);
    assert.equal((await history(a, group)).status, 404);
  });
});

describe("typing in a group", () => {
  test("is relayed to the other members only", async () => {
    const [a, b, outsider] = await people(3);
    const group = await createGroup(a, [b]);
    const [socketA, socketB, socketX] = await Promise.all([a, b, outsider].map((user) => ctx.connectSocket({ token: user.token })));
    let leaked = false;
    socketX.on("typing", () => (leaked = true));
    socketA.on("typing", () => (leaked = true)); // not echoed to the typer

    const typing = waitForEvent(socketB, "typing");
    socketA.emit("typing", { to: group._id, isGroup: true, isTyping: true });
    assert.deepEqual(await typing, { from: a.id, groupId: group._id, isTyping: true });

    // an outsider claiming to type in the group reaches nobody
    let fromOutsider = false;
    socketB.on("typing", (payload) => {
      if (payload.from === outsider.id) fromOutsider = true;
    });
    socketX.emit("typing", { to: group._id, isGroup: true, isTyping: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(leaked, false);
    assert.equal(fromOutsider, false);
    [socketA, socketB, socketX].forEach((socket) => socket.close());
  });
});

describe("search and opening a chat at an old message", () => {
  test("finds text in a one-to-one chat, ignoring case and deleted messages", async () => {
    const [a, b, c] = await people(3);
    const send = (from, to, text) => ctx.api("POST", `/api/messages/send/${to.id}`, { token: from.token, body: { text } });
    await send(a, b, "The Invoice is attached");
    await send(b, a, "got the invoice, thanks");
    const gone = await send(a, b, "wrong invoice");
    await ctx.api("DELETE", `/api/messages/${gone.body.newMessage._id}`, { token: a.token });
    await send(a, c, "invoice for somebody else");

    const res = await ctx.api("GET", `/api/messages/search/${b.id}?q=INVOICE`, { token: a.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.results.map((m) => m.text), ["got the invoice, thanks", "The Invoice is attached"]);
  });

  test("treats the search text literally and validates it", async () => {
    const [a, b] = await people(2);
    await ctx.api("POST", `/api/messages/send/${b.id}`, { token: a.token, body: { text: "price is $5.00 (approx)" } });
    await ctx.api("POST", `/api/messages/send/${b.id}`, { token: a.token, body: { text: "anything else" } });

    const literal = await ctx.api("GET", `/api/messages/search/${b.id}?q=${encodeURIComponent("$5.00 (")}`, { token: a.token });
    assert.equal(literal.body.results.length, 1);
    const wildcard = await ctx.api("GET", `/api/messages/search/${b.id}?q=${encodeURIComponent(".*")}`, { token: a.token });
    assert.deepEqual(wildcard.body.results, []);

    assert.equal((await ctx.api("GET", `/api/messages/search/${b.id}?q=a`, { token: a.token })).status, 400);
    assert.equal((await ctx.api("GET", `/api/messages/search/${b.id}`, { token: a.token })).status, 400);
    assert.equal((await ctx.api("GET", `/api/messages/search/${b.id}?q[$ne]=x`, { token: a.token })).status, 400);
    assert.equal((await ctx.api("GET", `/api/messages/search/${b.id}?q=hello`)).status, 401);
  });

  test("?since returns everything from an old message until now", async () => {
    const [a, b] = await people(2);
    const sent = [];
    for (let i = 1; i <= 6; i++) {
      const res = await ctx.api("POST", `/api/messages/send/${b.id}`, { token: a.token, body: { text: `m${i}` } });
      sent.push(res.body.newMessage);
    }
    const since = encodeURIComponent(sent[2].createdAt);
    const res = await ctx.api("GET", `/api/messages/${b.id}?since=${since}&limit=2`, { token: a.token });
    assert.deepEqual(res.body.messages.map((m) => m.text), ["m3", "m4", "m5", "m6"]);
    assert.equal(res.body.hasMore, true);

    const all = await ctx.api("GET", `/api/messages/${b.id}?since=${encodeURIComponent(sent[0].createdAt)}`, { token: a.token });
    assert.equal(all.body.messages.length, 6);
    assert.equal(all.body.hasMore, false);
    assert.equal((await ctx.api("GET", `/api/messages/${b.id}?since=nope`, { token: a.token })).status, 400);
  });
});

describe("pin, mute and archive", () => {
  const prefs = (user, body) => ctx.api("PUT", "/api/auth/chat-prefs", { token: user.token, body });

  test("are saved per user and returned with the session", async () => {
    const [a, b] = await people(2);
    let res = await prefs(a, { chatId: b.id, pinned: true, muted: true });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.user.pinnedChats, [b.id]);
    assert.deepEqual(res.body.user.mutedChats, [b.id]);
    assert.deepEqual(res.body.user.archivedChats, []);

    res = await prefs(a, { chatId: b.id, pinned: true }); // twice changes nothing
    assert.deepEqual(res.body.user.pinnedChats, [b.id]);

    res = await prefs(a, { chatId: b.id, pinned: false, archived: true });
    assert.deepEqual(res.body.user.pinnedChats, []);
    assert.deepEqual(res.body.user.archivedChats, [b.id]);

    const check = await ctx.api("GET", "/api/auth/check", { token: a.token });
    assert.deepEqual(check.body.user.mutedChats, [b.id]);
    // b's own settings are untouched and a's are invisible to b
    const forB = await ctx.api("GET", "/api/messages/users", { token: b.token });
    assert.ok(!forB.text.includes("mutedChats"));
    assert.deepEqual((await ctx.api("GET", "/api/auth/check", { token: b.token })).body.user.mutedChats, []);
  });

  test("allow at most 5 pinned chats and reject bad input", async () => {
    const [a, ...others] = await people(7);
    for (const other of others.slice(0, 5)) assert.equal((await prefs(a, { chatId: other.id, pinned: true })).status, 200);
    const sixth = await prefs(a, { chatId: others[5].id, pinned: true });
    assert.equal(sixth.status, 400);
    assert.match(sixth.body.message, /up to 5/);

    assert.equal((await prefs(a, { chatId: "nope", pinned: true })).status, 400);
    assert.equal((await prefs(a, { chatId: { $ne: null }, pinned: true })).status, 400);
    assert.equal((await prefs(a, { chatId: others[0].id, pinned: "yes" })).status, 400);
    assert.equal((await ctx.api("PUT", "/api/auth/chat-prefs", { body: { chatId: others[0].id, pinned: true } })).status, 401);
  });
});

describe("pictures are removed from storage when they are no longer used", () => {
  test("deleting a message deletes its picture", async () => {
    const [a, b] = await people(2);
    const sent = await ctx.api("POST", `/api/messages/send/${b.id}`, { token: a.token, body: { image: PNG_DATA_URI } });
    ctx.destroyed.length = 0;
    await ctx.api("DELETE", `/api/messages/${sent.body.newMessage._id}`, { token: a.token });
    assert.deepEqual(ctx.destroyed, [FAKE_IMAGE_ID]);

    // deleting again, or deleting a text message, removes nothing
    await ctx.api("DELETE", `/api/messages/${sent.body.newMessage._id}`, { token: a.token });
    const text = await ctx.api("POST", `/api/messages/send/${b.id}`, { token: a.token, body: { text: "no picture" } });
    await ctx.api("DELETE", `/api/messages/${text.body.newMessage._id}`, { token: a.token });
    assert.equal(ctx.destroyed.length, 1);
  });

  test("replacing or removing a profile picture deletes the old one", async () => {
    const [a] = await people(1);
    const update = (profilePic) => ctx.api("PUT", "/api/auth/update-profile", { token: a.token, body: { profilePic } });
    ctx.destroyed.length = 0;
    await update(PNG_DATA_URI); // first picture, nothing to delete
    assert.equal(ctx.destroyed.length, 0);
    await update(PNG_DATA_URI);
    assert.equal(ctx.destroyed.length, 1);
    await update("");
    assert.equal(ctx.destroyed.length, 2);
    // changing only the name leaves the picture alone
    await ctx.api("PUT", "/api/auth/update-profile", { token: a.token, body: { fullName: "New Name" } });
    assert.equal(ctx.destroyed.length, 2);
  });
});
