import express from "express";
import http from "http";
import { Server } from "socket.io";
import User from "../models/User.js";
import { allowedOrigins } from "./config.js";
import { verifyToken } from "./utils.js";

export const app = express();
export const server = http.createServer(app);

export const io = new Server(server, {
  cors: { origin: allowedOrigins },
});

// userId -> number of open sockets (a user can have several tabs or devices)
const onlineUsers = new Map();

const userRoom = (userId) => `user:${userId}`;

export const getOnlineUserIds = () => [...onlineUsers.keys()];

// Send an event to every socket the user has open
export const emitToUser = (userId, event, payload) => {
  io.to(userRoom(userId)).emit(event, payload);
};

// The user id comes from the verified JWT, never from what the client claims
io.use(async (socket, next) => {
  try {
    const userId = verifyToken(socket.handshake.auth?.token);
    const user = await User.exists({ _id: userId });
    if (!user) return next(new Error("Unauthorized"));
    socket.data.userId = String(userId);
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  const { userId } = socket.data;

  socket.join(userRoom(userId));
  onlineUsers.set(userId, (onlineUsers.get(userId) || 0) + 1);
  io.emit("getOnlineUsers", getOnlineUserIds());

  socket.on("disconnect", () => {
    const remaining = (onlineUsers.get(userId) || 1) - 1;
    if (remaining > 0) onlineUsers.set(userId, remaining);
    else onlineUsers.delete(userId);
    io.emit("getOnlineUsers", getOnlineUserIds());
  });
});
