import express from 'express';
import { protectRoute } from '../middleware/auth.js';
import { messageLimiter } from '../middleware/rateLimit.js';
import { deleteMessage, editMessage, forwardMessage, getFileLink, getMessages, getUserForSidebar, markMessageAsSeen, reactToMessage, searchMessages, sendMessage } from '../controllers/messageController.js';

const messageRouter = express.Router();

messageRouter.get("/users",protectRoute, getUserForSidebar)
messageRouter.put("/mark/:id",protectRoute, markMessageAsSeen);
messageRouter.get("/search/:id", protectRoute, searchMessages);
messageRouter.get("/:id", protectRoute, getMessages);
messageRouter.post("/send/:id", protectRoute, messageLimiter, sendMessage)
messageRouter.post("/:id/forward", protectRoute, messageLimiter, forwardMessage)
messageRouter.get("/:id/files/:index/link", protectRoute, getFileLink)
messageRouter.put("/:id/reaction", protectRoute, messageLimiter, reactToMessage)
messageRouter.put("/:id", protectRoute, messageLimiter, editMessage)
messageRouter.delete("/:id", protectRoute, deleteMessage)

export default messageRouter;
