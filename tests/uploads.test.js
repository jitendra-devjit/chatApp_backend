import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PNG_DATA_URI, startTestServer } from "./helpers.js";

let ctx;
let storage;
before(async () => {
  ctx = await startTestServer();
  storage = await import("../lib/storage.js");
});
after(() => ctx.stop());

const PNG = Buffer.from(PNG_DATA_URI.split(",")[1], "base64");

// uploads a file the way the browser does: ask for a ticket, then send the file to it
const upload = async (user, kind, name, body = PNG) => {
  const ticket = await ctx.api("POST", "/api/uploads/ticket", { token: user.token, body: { kind } });
  assert.equal(ticket.status, 200, ticket.text);
  const res = await fetch(ticket.body.ticket.url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${user.token}`, "X-File-Name": encodeURIComponent(name), "Content-Type": "application/octet-stream" },
    body,
  });
  return { status: res.status, receipt: await res.json() };
};
const attach = async (user, kind, name, extra = {}) => ({ kind, upload: (await upload(user, kind, name)).receipt, name, ...extra });
const send = (from, to, body) => ctx.api("POST", `/api/messages/send/${to.id}`, { token: from.token, body });
const fileOf = (receipt) => path.join(storage.LOCAL_UPLOAD_DIR, path.basename(receipt.public_id));
const pair = async () => [await ctx.createUser(), await ctx.createUser()];

describe("upload tickets", () => {
  test("need a login and a known kind", async () => {
    const [a] = await pair();
    assert.equal((await ctx.api("POST", "/api/uploads/ticket", { body: { kind: "image" } })).status, 401);
    for (const kind of ["exe", "", null, { $ne: null }, "__proto__", "constructor"]) {
      const res = await ctx.api("POST", "/api/uploads/ticket", { token: a.token, body: { kind } });
      assert.equal(res.status, 400, JSON.stringify(kind));
    }
  });

  test("say what is allowed", async () => {
    const [a] = await pair();
    const res = await ctx.api("POST", "/api/uploads/ticket", { token: a.token, body: { kind: "video" } });
    assert.deepEqual(res.body.ticket.formats, ["mp4", "webm", "mov"]);
    assert.equal(res.body.ticket.maxBytes, 100 * 1024 * 1024);
  });
});

describe("sending files", () => {
  test("a message carries its files, with name, size and kind", async () => {
    const [a, b] = await pair();
    const res = await send(a, b, {
      text: "holiday",
      attachments: [await attach(a, "image", "beach.png"), await attach(a, "file", "tickets.pdf")],
    });
    assert.equal(res.status, 201, res.text);
    const [photo, doc] = res.body.newMessage.attachments;
    assert.equal(photo.type, "image");
    assert.equal(photo.name, "beach.png");
    assert.equal(photo.size, PNG.length);
    assert.equal(doc.type, "file");
    assert.match(doc.url, /\/uploads\/[0-9a-f-]+\.pdf$/);

    // the file is really there, and the frontend on another port may load it
    const served = await fetch(photo.url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

    const history = await ctx.api("GET", `/api/messages/${a.id}`, { token: b.token });
    assert.equal(history.body.messages[0].attachments.length, 2);
    const list = await ctx.api("GET", "/api/messages/users", { token: b.token });
    assert.deepEqual(list.body.lastMessages[a.id].attachment, { type: "image", name: "beach.png", count: 2 });
  });

  test("a file alone is a message, and a reply shows the quoted files", async () => {
    const [a, b] = await pair();
    const first = await send(a, b, { attachments: [await attach(a, "video", "clip.mp4")] });
    assert.equal(first.status, 201);
    assert.equal(first.body.newMessage.text, undefined);
    const reply = await send(b, a, { text: "nice", replyTo: first.body.newMessage._id });
    assert.equal(reply.body.newMessage.replyTo.attachments[0].type, "video");
  });

  test("a voice note keeps its length and waveform", async () => {
    const [a, b] = await pair();
    const waveform = [0, 12, 80, 100, 44];
    const res = await send(a, b, { attachments: [await attach(a, "audio", "voice.webm", { duration: 7.4, waveform })] });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.newMessage.attachments[0].duration, 7.4);
    assert.deepEqual(res.body.newMessage.attachments[0].waveform, waveform);

    for (const bad of [{ waveform: [101] }, { waveform: [1.5] }, { waveform: "loud" }, { waveform: Array(65).fill(1) }, { duration: -1 }, { duration: "long" }]) {
      const rejected = await send(a, b, { attachments: [await attach(a, "audio", "voice.webm", bad)] });
      assert.equal(rejected.status, 400, JSON.stringify(bad).slice(0, 40));
    }
  });

  test("works in a group, for members only", async () => {
    const [a, b] = await pair();
    const outsider = await ctx.createUser();
    const group = (await ctx.api("POST", "/api/groups", { token: a.token, body: { name: "Photos", memberIds: [b.id] } })).body.group;
    const ok = await ctx.api("POST", `/api/groups/${group._id}/messages`, { token: b.token, body: { attachments: [await attach(b, "image", "a.png")] } });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.newMessage.attachments[0].type, "image");
    const no = await ctx.api("POST", `/api/groups/${group._id}/messages`, { token: outsider.token, body: { attachments: [await attach(outsider, "image", "a.png")] } });
    assert.equal(no.status, 404);
  });
});

describe("what is refused", () => {
  test("file types that are not on the list, and files that are too big", async () => {
    const [a] = await pair();
    for (const [kind, name] of [["file", "virus.exe"], ["file", "page.html"], ["image", "drawing.svg"], ["image", "noextension"], ["video", "movie.avi"]]) {
      assert.equal((await upload(a, kind, name)).status, 400, name);
    }
    assert.equal((await upload(a, "image", "empty.png", Buffer.alloc(0))).status, 400);
    assert.equal((await upload(a, "image", "huge.png", Buffer.alloc(10 * 1024 * 1024 + 1))).status, 413);
    const unknownKind = await fetch(`${ctx.url}/api/uploads/local/nonsense`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.token}`, "X-File-Name": "a.png", "Content-Type": "application/octet-stream" },
      body: PNG,
    });
    assert.equal(unknownKind.status, 400);
  });

  test("uploading needs a login", async () => {
    const res = await fetch(`${ctx.url}/api/uploads/local/image`, { method: "PUT", headers: { "X-File-Name": "a.png" }, body: PNG });
    assert.equal(res.status, 401);
  });

  test("receipts that are forged, belong to another kind or point elsewhere", async () => {
    const [a, b] = await pair();
    const real = (await upload(a, "image", "real.png")).receipt;
    const forged = [
      { kind: "image", upload: { ...real, signature: "0".repeat(64) } },
      { kind: "image", upload: { ...real, public_id: "local/image/somebody-else.png" } },
      { kind: "file", upload: real }, // an image receipt used as a document
      { kind: "image", upload: { public_id: "https://evil.example.com/track.png", signature: "x" } },
      { kind: "image", upload: { ...real, public_id: { $ne: null } } },
      { kind: "image", upload: null },
      { kind: "image" },
      { kind: "exe", upload: real },
      "not an object",
    ];
    for (const item of forged) {
      const res = await send(a, b, { text: "look", attachments: [item] });
      assert.equal(res.status, 400, JSON.stringify(item).slice(0, 70));
    }
    assert.equal(await ctx.Message.countDocuments({ senderId: a.id }), 0);
  });

  test("more than 10 files, or something that is not a list", async () => {
    const [a, b] = await pair();
    const one = await attach(a, "image", "a.png");
    assert.equal((await send(a, b, { attachments: Array(11).fill(one) })).status, 400);
    assert.equal((await send(a, b, { attachments: { 0: one } })).status, 400);
    assert.equal((await send(a, b, { attachments: [] })).status, 400); // nothing to send
  });

  test("when one file of a message is bad, the good ones are cleaned up", async () => {
    const [a, b] = await pair();
    const good = await attach(a, "image", "good.png");
    assert.ok(fs.existsSync(fileOf(good.upload)));
    const res = await send(a, b, { attachments: [good, { kind: "image", upload: { public_id: "local/image/x.png", signature: "bad" } }] });
    assert.equal(res.status, 400);
    assert.ok(!fs.existsSync(fileOf(good.upload)));
  });
});

describe("clean up", () => {
  test("deleting a message deletes its files", async () => {
    const [a, b] = await pair();
    const items = [await attach(a, "image", "one.png"), await attach(a, "file", "two.pdf")];
    const sent = await send(a, b, { attachments: items });
    items.forEach((item) => assert.ok(fs.existsSync(fileOf(item.upload))));

    const res = await ctx.api("DELETE", `/api/messages/${sent.body.newMessage._id}`, { token: a.token });
    assert.deepEqual(res.body.message.attachments, []);
    items.forEach((item) => assert.ok(!fs.existsSync(fileOf(item.upload))));
  });

  test("a group that ends takes its files with it", async () => {
    const [a, b] = await pair();
    const group = (await ctx.api("POST", "/api/groups", { token: a.token, body: { name: "Short lived", memberIds: [b.id] } })).body.group;
    const item = await attach(a, "video", "clip.mp4");
    await ctx.api("POST", `/api/groups/${group._id}/messages`, { token: a.token, body: { attachments: [item] } });
    await ctx.api("DELETE", `/api/groups/${group._id}/members/${b.id}`, { token: b.token });
    await ctx.api("DELETE", `/api/groups/${group._id}/members/${a.id}`, { token: a.token });
    assert.ok(!fs.existsSync(fileOf(item.upload)));
  });
});

describe("with Cloudinary as storage", () => {
  const SECRET = "test-api-secret";
  const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");
  let cloudinary;

  before(async () => {
    cloudinary = (await import("../lib/cloudinary.js")).default;
    cloudinary.config({ cloud_name: "democloud", api_key: "123456", api_secret: SECRET });
    process.env.STORAGE_DRIVER = "cloudinary";
  });
  after(() => {
    process.env.STORAGE_DRIVER = "local";
  });

  test("a ticket is signed, so folder and formats cannot be changed", () => {
    const ticket = storage.createUploadTicket("image", "http://ignored");
    assert.equal(ticket.url, "https://api.cloudinary.com/v1_1/democloud/image/upload");
    const { signature, api_key, ...params } = ticket.fields;
    assert.equal(api_key, "123456");
    assert.equal(params.folder, "chat-app/image");
    assert.equal(params.allowed_formats, "png,jpg,jpeg,webp,gif");
    const toSign = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join("&");
    assert.equal(signature, sha1(toSign + SECRET));
    assert.ok(!JSON.stringify(ticket).includes(SECRET)); // the secret never leaves the server

    // voice notes go to Cloudinary's "video" type, documents to "raw"
    assert.match(storage.createUploadTicket("audio", "").url, /\/video\/upload$/);
    assert.match(storage.createUploadTicket("file", "").url, /\/raw\/upload$/);
  });

  test("only a receipt signed by Cloudinary for our folder is accepted", async () => {
    const receipt = (public_id, extra = {}) => ({
      public_id, version: 1700000000, signature: sha1(`public_id=${public_id}&version=1700000000${SECRET}`), ...extra,
    });

    const image = await storage.verifyUpload("image", receipt("chat-app/image/abc", { format: "png", bytes: 2048, width: 640, height: 480 }), "");
    assert.equal(image.url, "https://res.cloudinary.com/democloud/image/upload/v1700000000/chat-app/image/abc.png");
    assert.deepEqual([image.size, image.width, image.height], [2048, 640, 480]);

    const doc = await storage.verifyUpload("file", receipt("chat-app/file/report.pdf", { bytes: 10 }), "");
    assert.equal(doc.url, "https://res.cloudinary.com/democloud/raw/upload/v1700000000/chat-app/file/report.pdf");
    assert.equal(doc.resourceType, "raw");

    ctx.destroyed.length = 0;
    const rejected = [
      ["image", { ...receipt("chat-app/image/abc", { format: "png" }), signature: sha1("guess") }],
      ["image", receipt("other-folder/abc", { format: "png" })],
      ["image", receipt("chat-app/file/abc", { format: "png" })],
      ["image", receipt("chat-app/image/abc", { format: "svg" })],
      ["image", receipt("chat-app/image/abc", { format: "png", bytes: 11 * 1024 * 1024 })],
      ["file", receipt("chat-app/file/tool.exe")],
    ];
    for (const [kind, upload] of rejected) {
      await assert.rejects(storage.verifyUpload(kind, upload, ""), (error) => error.status === 400, upload.public_id);
    }
    // a real upload of a wrong type or size is removed again
    assert.deepEqual(ctx.destroyed, ["chat-app/image/abc", "chat-app/image/abc", "chat-app/file/tool.exe"]);
  });
});
