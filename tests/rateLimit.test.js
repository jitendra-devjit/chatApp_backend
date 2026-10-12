import { after, before, test } from "node:test";
import assert from "node:assert/strict";

// must be set before helpers.js loads the app
process.env.AUTH_RATE_LIMIT = "5";
process.env.MESSAGE_RATE_LIMIT = "3";
const { startTestServer } = await import("./helpers.js");

let ctx;
before(async () => {
  ctx = await startTestServer();
});
after(() => ctx.stop());

test("limits messages per user, not per IP", async () => {
  // 3 signups use 3 of the 5 auth attempts
  const [a, b, c] = [await ctx.createUser(), await ctx.createUser(), await ctx.createUser()];
  const send = (from) => ctx.api("POST", `/api/messages/send/${b.id}`, { token: from.token, body: { text: "spam" } });

  for (let i = 0; i < 3; i++) assert.equal((await send(a)).status, 201);
  const blocked = await send(a);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.success, false);

  // another user from the same IP is not affected
  assert.equal((await send(c)).status, 201);
});

test("blocks password guessing after too many attempts", async () => {
  const guess = () =>
    ctx.api("POST", "/api/auth/login", { body: { email: "user1@example.com", password: "wrong-guess" } });

  assert.equal((await guess()).status, 401);
  assert.equal((await guess()).status, 401);
  const blocked = await guess();
  assert.equal(blocked.status, 429);
  assert.match(blocked.body.message, /Too many attempts/);
});
