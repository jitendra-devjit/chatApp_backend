import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server-core";
import { io as ioClient } from "socket.io-client";

process.env.JWT_SECRET = "test-secret-that-is-long-enough-for-tests";
process.env.CLIENT_URL = "http://localhost:5173";
process.env.AUTH_RATE_LIMIT ??= "1000";
process.env.MESSAGE_RATE_LIMIT ??= "1000";

// smallest valid PNG (1x1 pixel)
export const PNG_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const FAKE_IMAGE_URL = "https://res.cloudinary.com/test/image/upload/fake.png";

// Starts the real app against an in-memory MongoDB on a random port
export const startTestServer = async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { dbName: "chat-app-test" });

  const { server } = await import("../app.js");
  const { io } = await import("../lib/socket.js");
  const { default: cloudinary } = await import("../lib/cloudinary.js");
  const { default: User } = await import("../models/User.js");
  const { default: Message } = await import("../models/Message.js");
  await Promise.all([User.init(), Message.init()]); // builds the unique email index

  // no real uploads in tests
  const uploads = [];
  cloudinary.uploader.upload = async (data, options) => {
    uploads.push(options);
    return { secure_url: FAKE_IMAGE_URL };
  };

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  const api = async (method, path, { token, body, headers = {}, rawBody } = {}) => {
    const res = await fetch(url + path, {
      method,
      headers: {
        ...(body !== undefined || rawBody !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // plain text response
    }
    return { status: res.status, body: json, text, headers: res.headers };
  };

  let counter = 0;
  const createUser = async (overrides = {}) => {
    counter += 1;
    const credentials = {
      fullName: `User ${counter}`,
      email: `user${counter}@example.com`,
      password: "secret123",
      bio: "hello",
      ...overrides,
    };
    const res = await api("POST", "/api/auth/signup", { body: credentials });
    if (res.status !== 201) throw new Error(`signup failed: ${res.text}`);
    return { ...credentials, id: res.body.userData._id, token: res.body.token };
  };

  const sockets = [];
  // resolves with a connected socket, rejects with the connect error
  const connectSocket = (auth) =>
    new Promise((resolve, reject) => {
      const socket = ioClient(url, { auth, transports: ["websocket"], reconnection: false });
      sockets.push(socket);
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", reject);
    });

  const stop = async () => {
    sockets.forEach((socket) => socket.close());
    await io.close(); // also closes the http server
    await mongoose.disconnect();
    await mongo.stop();
  };

  return { url, api, createUser, connectSocket, uploads, stop, User, Message };
};

// waits for one socket event, fails if it does not arrive in time
export const waitForEvent = (socket, event, { timeout = 2000, filter = () => true } = {}) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`"${event}" not received within ${timeout}ms`));
    }, timeout);
    const handler = (payload) => {
      if (!filter(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
