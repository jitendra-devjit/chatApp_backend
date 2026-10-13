import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PNG_DATA_URI, startTestServer, waitForEvent } from "./helpers.js";

let ctx;
let storage;
before(async () => {
  ctx = await startTestServer();
  storage = await import("../lib/storage.js");
});
after(() => ctx.stop());

const PNG = Buffer.from(PNG_DATA_URI.split(",")[1], "base64");

// uploads a file the way the browser does: ask for a ticket, then send the file to it
const attach = async (user, kind, name) => {
  const ticket = await ctx.api("POST", "/api/uploads/ticket", { token: user.token, body: { kind } });
  const res = await fetch(ticket.body.ticket.url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${user.token}`, "X-File-Name": encodeURIComponent(name), "Content-Type": "application/octet-stream" },
    body: PNG,
  });
  return { kind, upload: await res.json(), name };
};
const send = async (from, to, body) => (await ctx.api("POST", `/api/messages/send/${to.id}`, { token: from.token, body })).body.newMessage;
const forward = (user, messageId, body) => ctx.api("POST", `/api/messages/${messageId}/forward`, { token: user.token, body });
const fileOf = (attachment) => path.join(storage.LOCAL_UPLOAD_DIR, path.basename(attachment.publicId));
const people = async (count) => Promise.all(Array.from({ length: count }, () => ctx.createUser()));

describe("forwarding a message", () => {
  test("sends the text on to people and groups, marked as forwarded", async () => {
    const [a, b, c, d] = await people(4);
    const group = (await ctx.api("POST", "/api/groups", { token: b.token, body: { name: "Friends", memberIds: [d.id] } })).body.group;
    const original = await send(a, b, { text: "the plan for Sunday" });

    const socketC = await ctx.connectSocket({ token: c.token });
    const socketD = await ctx.connectSocket({ token: d.token });
    const arrivals = Promise.all([waitForEvent(socketC, "newMessage"), waitForEvent(socketD, "newMessage")]);

    const res = await forward(b, original._id, { userIds: [c.id], groupIds: [group._id] });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.messages.length, 2);
    const [toC, toGroup] = await arrivals;
    assert.equal(toC.text, "the plan for Sunday");
    assert.equal(toC.forwarded, true);
    assert.equal(toC.senderId, b.id); // it comes from the person who forwarded it
    assert.equal(toGroup.groupId, group._id);

    const list = await ctx.api("GET", "/api/messages/users", { token: c.token });
    assert.equal(list.body.lastMessages[b.id].forwarded, true);
    assert.equal(list.body.unseenMessages[b.id], 1);
    socketC.close();
    socketD.close();
  });

  test("the files travel along and stay until the last message that shows them is deleted", async () => {
    const [a, b, c] = await people(3);
    const original = await send(a, b, { text: "look", attachments: [await attach(a, "image", "beach.png")] });
    const file = fileOf(original.attachments[0]);

    const res = await forward(b, original._id, { userIds: [c.id] });
    const [copy] = res.body.messages;
    assert.equal(copy.attachments[0].url, original.attachments[0].url);
    assert.equal(copy.attachments[0].name, "beach.png");

    // the original goes, the forwarded message still shows the picture
    await ctx.api("DELETE", `/api/messages/${original._id}`, { token: a.token });
    assert.ok(fs.existsSync(file));
    // the last one goes, now the file goes too
    await ctx.api("DELETE", `/api/messages/${copy._id}`, { token: b.token });
    assert.ok(!fs.existsSync(file));
  });

  test("only somebody in the conversation can forward, and only to chats they are in", async () => {
    const [a, b, outsider, c] = await people(4);
    const original = await send(a, b, { text: "private" });
    const closed = (await ctx.api("POST", "/api/groups", { token: a.token, body: { name: "Closed", memberIds: [b.id] } })).body.group;

    assert.equal((await forward(outsider, original._id, { userIds: [c.id] })).status, 404);
    assert.equal((await forward(b, original._id, { groupIds: [closed._id] })).status, 201);
    assert.equal((await forward(c, original._id, { userIds: [a.id] })).status, 404);
    // b is in the conversation but c is not in the group
    const viaGroup = (await ctx.api("GET", `/api/groups/${closed._id}/messages`, { token: a.token })).body.messages.at(-1);
    assert.equal((await forward(c, viaGroup._id, { userIds: [a.id] })).status, 404);
    assert.equal((await forward(b, original._id, { groupIds: ["64b000000000000000000000"] })).status, 404);
    assert.equal((await forward(b, original._id, { userIds: ["64b000000000000000000000"] })).status, 404);
  });

  test("refuses bad requests", async () => {
    const [a, b, ...others] = await people(8);
    const original = await send(a, b, { text: "hello" });
    assert.equal((await forward(b, original._id, {})).status, 400);
    assert.equal((await forward(b, original._id, { userIds: [] })).status, 400);
    assert.equal((await forward(b, original._id, { userIds: [b.id] })).status, 400); // only to yourself
    assert.equal((await forward(b, original._id, { userIds: { $ne: null } })).status, 400);
    assert.equal((await forward(b, original._id, { userIds: [{ $ne: null }] })).status, 400);
    assert.equal((await forward(b, original._id, { userIds: others.map((user) => user.id) })).status, 400); // six chats
    assert.equal((await forward(b, "not-an-id", { userIds: [a.id] })).status, 400);

    await ctx.api("DELETE", `/api/messages/${original._id}`, { token: a.token });
    assert.equal((await forward(b, original._id, { userIds: [others[0].id] })).status, 400);
  });
});

describe("a link to a file of a message", () => {
  test("is given to the people of the conversation only", async () => {
    const [a, b, outsider] = await people(3);
    const message = await send(a, b, { attachments: [await attach(a, "file", "tickets.pdf")] });
    const link = (user, index = 0, query = "") => ctx.api("GET", `/api/messages/${message._id}/files/${index}/link${query}`, { token: user.token });

    const mine = await link(b);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.url, message.attachments[0].url); // demo storage has nothing to sign
    assert.equal((await link(outsider)).status, 404);
    assert.equal((await link(b, 1)).status, 404);
    assert.equal((await link(b, "x")).status, 404);
    assert.equal((await link(b, -1)).status, 404);
    assert.equal((await ctx.api("GET", `/api/messages/${message._id}/files/0/link`)).status, 401);
  });

  test("for a document on Cloudinary it is a signed link that runs out", async () => {
    const cloudinary = (await import("../lib/cloudinary.js")).default;
    const before = cloudinary.config();
    cloudinary.config({ cloud_name: "democloud", api_key: "123456", api_secret: "test-api-secret" });
    try {
      const pdf = { url: "https://res.cloudinary.com/democloud/raw/upload/v1/chat-app/file/abc.pdf", publicId: "chat-app/file/abc.pdf", resourceType: "raw" };
      const open = new URL(storage.temporaryLink(pdf));
      assert.equal(open.origin + open.pathname, "https://api.cloudinary.com/v1_1/democloud/raw/download");
      assert.equal(open.searchParams.get("public_id"), "chat-app/file/abc.pdf");
      assert.ok(open.searchParams.get("signature"));
      const expires = Number(open.searchParams.get("expires_at"));
      assert.ok(expires > Date.now() / 1000 && expires <= Date.now() / 1000 + 301);
      assert.notEqual(open.searchParams.get("attachment"), "true");
      assert.equal(new URL(storage.temporaryLink(pdf, { download: true })).searchParams.get("attachment"), "true");

      // pictures and videos open with the link they have
      const photo = { url: "https://res.cloudinary.com/democloud/image/upload/v1/chat-app/image/a.png", publicId: "chat-app/image/a", resourceType: "image" };
      assert.equal(storage.temporaryLink(photo), photo.url);
    } finally {
      cloudinary.config({ cloud_name: before.cloud_name, api_key: before.api_key, api_secret: before.api_secret });
    }
  });
});
