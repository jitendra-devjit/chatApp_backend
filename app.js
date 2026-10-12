import express from 'express';
import cors from "cors";
import helmet from "helmet";
import { allowedOrigins } from "./lib/config.js";
import { app, server } from "./lib/socket.js";
import { errorHandler, notFound } from "./middleware/error.js";
import userRouter from "./routes/userRoutes.js";
import messageRouter from "./routes/messageRoutes.js";
import groupRouter from "./routes/groupRoutes.js";
import uploadRouter, { localUploads } from "./routes/uploadRoutes.js";
import { isLocalStorage } from "./lib/storage.js";

// behind one proxy on Render/Railway/Vercel, needed so rate limits see the real IP
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet());
app.use(cors({ origin: allowedOrigins }));
// images travel as base64 inside JSON: a 3 MB image is about 4 MB of text
app.use(express.json({ limit: "5mb" }));

app.get("/api/status", (req, res) => res.send("Server is live"));
app.use("/api/auth", userRouter);
app.use("/api/messages", messageRouter);
app.use("/api/groups", groupRouter);
app.use("/api/uploads", uploadRouter);
if (isLocalStorage()) app.use("/uploads", localUploads);

app.use(notFound);
app.use(errorHandler);

export { app, server };
