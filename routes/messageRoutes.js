import express from 'express';
import { protectRoute } from '../middleware/auth.js';
import { messageLimiter } from '../middleware/rateLimit.js';
import { deleteMessage, editMessage, getMessages, getUserForSidebar, markMessageAsSeen, reactToMessage, sendMessage } from '../controllers/messageController.js';

const messageRouter = express.Router();

messageRouter.get("/users",protectRoute, getUserForSidebar)
messageRouter.put("/mark/:id",protectRoute, markMessageAsSeen);
messageRouter.get("/:id", protectRoute, getMessages);
messageRouter.post("/send/:id", protectRoute, messageLimiter, sendMessage)
messageRouter.put("/:id/reaction", protectRoute, messageLimiter, reactToMessage)
messageRouter.put("/:id", protectRoute, messageLimiter, editMessage)
messageRouter.delete("/:id", protectRoute, deleteMessage)

export default messageRouter;
