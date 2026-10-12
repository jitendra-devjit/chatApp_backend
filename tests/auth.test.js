import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { FAKE_IMAGE_URL, PNG_DATA_URI, startTestServer } from "./helpers.js";

let ctx;
before(async () => {
  ctx = await startTestServer();
});
after(() => ctx.stop());

describe("signup", () => {
  test("creates an account and never returns the password", async () => {
    const res = await ctx.api("POST", "/api/auth/signup", {
      body: { fullName: "Asha Rao", email: "Asha@Example.com", password: "secret123", bio: "hi" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.userData.email, "asha@example.com");
    assert.equal(res.body.userData.password, undefined);
    assert.ok(!res.text.includes("$2")); // no bcrypt hash anywhere in the response

    const check = await ctx.api("GET", "/api/auth/check", { token: res.body.token });
    assert.equal(check.status, 200);
    assert.equal(check.body.user.fullName, "Asha Rao");
    assert.equal(check.body.user.password, undefined);
  });

  test("stores the password hashed", async () => {
    const user = await ctx.createUser();
    const stored = await ctx.User.findById(user.id).select("+password");
    assert.notEqual(stored.password, user.password);
    assert.match(stored.password, /^\$2[aby]\$/);
  });

  test("bio is optional", async () => {
    const res = await ctx.api("POST", "/api/auth/signup", {
      body: { fullName: "No Bio", email: "nobio@example.com", password: "secret123" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.userData.bio, "");
  });

  test("rejects a duplicate email, ignoring case", async () => {
    const user = await ctx.createUser();
    const res = await ctx.api("POST", "/api/auth/signup", {
      body: { fullName: "Copy Cat", email: user.email.toUpperCase(), password: "secret123" },
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.success, false);
  });

  const invalidBodies = {
    "missing name": { email: "a@example.com", password: "secret123" },
    "invalid email": { fullName: "Some One", email: "not-an-email", password: "secret123" },
    "short password": { fullName: "Some One", email: "b@example.com", password: "123" },
    "password over 72 bytes": { fullName: "Some One", email: "c@example.com", password: "x".repeat(73) },
    "name too long": { fullName: "x".repeat(51), email: "d@example.com", password: "secret123" },
    "bio too long": { fullName: "Some One", email: "e@example.com", password: "secret123", bio: "x".repeat(161) },
    "object as email (NoSQL injection)": { fullName: "Some One", email: { $ne: null }, password: "secret123" },
    "object as password": { fullName: "Some One", email: "f@example.com", password: { $ne: null } },
  };
  for (const [name, body] of Object.entries(invalidBodies)) {
    test(`rejects ${name}`, async () => {
      const res = await ctx.api("POST", "/api/auth/signup", { body });
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
    });
  }

  test("rejects an empty body and malformed JSON", async () => {
    const empty = await ctx.api("POST", "/api/auth/signup");
    assert.equal(empty.status, 400);
    const broken = await ctx.api("POST", "/api/auth/signup", { rawBody: "{not json" });
    assert.equal(broken.status, 400);
    assert.equal(broken.body.message, "Invalid JSON");
  });
});

describe("login", () => {
  test("logs in with correct credentials", async () => {
    const user = await ctx.createUser();
    const res = await ctx.api("POST", "/api/auth/login", {
      body: { email: user.email, password: user.password },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(res.body.userData._id, user.id);
    assert.equal(res.body.userData.password, undefined);
  });

  test("wrong password and unknown email give the same answer", async () => {
    const user = await ctx.createUser();
    const wrong = await ctx.api("POST", "/api/auth/login", {
      body: { email: user.email, password: "wrong-password" },
    });
    const unknown = await ctx.api("POST", "/api/auth/login", {
      body: { email: "nobody@example.com", password: "secret123" },
    });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.message, unknown.body.message);
  });

  test("rejects NoSQL injection in the login body", async () => {
    await ctx.createUser();
    const res = await ctx.api("POST", "/api/auth/login", {
      body: { email: { $ne: null }, password: { $ne: null } },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.token, undefined);
  });

  test("rejects a missing password", async () => {
    const user = await ctx.createUser();
    const res = await ctx.api("POST", "/api/auth/login", { body: { email: user.email } });
    assert.equal(res.status, 400);
  });
});

describe("protected routes", () => {
  test("reject a missing token", async () => {
    const res = await ctx.api("GET", "/api/auth/check");
    assert.equal(res.status, 401);
  });

  test("reject a garbage token", async () => {
    const res = await ctx.api("GET", "/api/auth/check", { token: "abc.def.ghi" });
    assert.equal(res.status, 401);
  });

  test("reject a token signed with another secret", async () => {
    const user = await ctx.createUser();
    const forged = jwt.sign({ id: user.id }, "attacker-secret");
    const res = await ctx.api("GET", "/api/auth/check", { token: forged });
    assert.equal(res.status, 401);
  });

  test("reject an unsigned (alg none) token", async () => {
    const user = await ctx.createUser();
    const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({ id: user.id })}.`;
    const res = await ctx.api("GET", "/api/auth/check", { token: unsigned });
    assert.equal(res.status, 401);
  });

  test("reject an expired token", async () => {
    const user = await ctx.createUser();
    const expired = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: -10 });
    const res = await ctx.api("GET", "/api/auth/check", { token: expired });
    assert.equal(res.status, 401);
  });

  test("reject the token of a deleted user", async () => {
    const user = await ctx.createUser();
    await ctx.User.findByIdAndDelete(user.id);
    const res = await ctx.api("GET", "/api/auth/check", { token: user.token });
    assert.equal(res.status, 401);
  });

  test("accept the legacy token header", async () => {
    const user = await ctx.createUser();
    const res = await ctx.api("GET", "/api/auth/check", { headers: { token: user.token } });
    assert.equal(res.status, 200);
  });
});

describe("update profile", () => {
  test("updates name and bio", async () => {
    const user = await ctx.createUser();
    const res = await ctx.api("PUT", "/api/auth/update-profile", {
      token: user.token,
      body: { fullName: "New Name", bio: "new bio" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.fullName, "New Name");
    assert.equal(res.body.user.bio, "new bio");
    assert.equal(res.body.user.password, undefined);
  });

  test("needs a token", async () => {
    const res = await ctx.api("PUT", "/api/auth/update-profile", { body: { fullName: "Hacker" } });
    assert.equal(res.status, 401);
  });

  test("cannot change email or password through this route", async () => {
    const user = await ctx.createUser();
    await ctx.api("PUT", "/api/auth/update-profile", {
      token: user.token,
      body: { fullName: "Same Person", email: "stolen@example.com", password: "hacked123" },
    });
    const stored = await ctx.User.findById(user.id);
    assert.equal(stored.email, user.email);
    const login = await ctx.api("POST", "/api/auth/login", {
      body: { email: user.email, password: user.password },
    });
    assert.equal(login.status, 200);
  });

  test("uploads a real image as an image only", async () => {
    const user = await ctx.createUser();
    ctx.uploads.length = 0;
    const res = await ctx.api("PUT", "/api/auth/update-profile", {
      token: user.token,
      body: { profilePic: PNG_DATA_URI },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.profilePic, FAKE_IMAGE_URL);
    assert.equal(res.body.user.fullName, user.fullName); // untouched
    assert.equal(ctx.uploads[0].resource_type, "image");
  });

  test("removes the profile picture", async () => {
    const user = await ctx.createUser();
    await ctx.api("PUT", "/api/auth/update-profile", { token: user.token, body: { profilePic: PNG_DATA_URI } });
    const res = await ctx.api("PUT", "/api/auth/update-profile", { token: user.token, body: { profilePic: "" } });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.profilePic, "");
  });

  const badImages = {
    "an html file": "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "an svg (can carry scripts)": "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "html renamed to png": "data:image/png;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "a remote url": "https://evil.example.com/tracker.png",
    "an object": { $ne: null },
  };
  for (const [name, profilePic] of Object.entries(badImages)) {
    test(`rejects ${name} as profile picture`, async () => {
      const user = await ctx.createUser();
      ctx.uploads.length = 0;
      const res = await ctx.api("PUT", "/api/auth/update-profile", { token: user.token, body: { profilePic } });
      assert.equal(res.status, 400);
      assert.equal(ctx.uploads.length, 0);
    });
  }

  test("rejects an image over 3 MB", async () => {
    const user = await ctx.createUser();
    const header = PNG_DATA_URI.slice("data:image/png;base64,".length, -2);
    const big = "data:image/png;base64," + header + "A".repeat(4.2 * 1024 * 1024);
    const res = await ctx.api("PUT", "/api/auth/update-profile", { token: user.token, body: { profilePic: big } });
    assert.equal(res.status, 413);
  });

  test("rejects a body over the JSON limit", async () => {
    const user = await ctx.createUser();
    const res = await ctx.api("PUT", "/api/auth/update-profile", {
      token: user.token,
      body: { bio: "x".repeat(6 * 1024 * 1024) },
    });
    assert.equal(res.status, 413);
  });
});

describe("http hardening", () => {
  test("sends security headers and hides express", async () => {
    const res = await ctx.api("GET", "/api/status");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-powered-by"), null);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.ok(res.headers.get("strict-transport-security"));
  });

  test("allows only the configured origin", async () => {
    const allowed = await ctx.api("GET", "/api/status", { headers: { Origin: "http://localhost:5173" } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");
    const evil = await ctx.api("GET", "/api/status", { headers: { Origin: "https://evil.example.com" } });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  });

  test("unknown routes return json 404", async () => {
    const res = await ctx.api("GET", "/api/nope");
    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
  });
});
