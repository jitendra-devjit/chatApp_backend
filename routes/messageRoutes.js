import express from 'express';
import { protectRoute } from '../middleware/auth.js';
import { getMessages, getUserForSidebar, markMessageAsSeen, sendMessage } from '../controllers/messageController.js';

const messageRouter = express.Router();

messageRouter.get("/users",protectRoute, getUserForSidebar)
messageRouter.put("/mark/:id",protectRoute, markMessageAsSeen);
messageRouter.get("/:id", protectRoute, getMessages);
messageRouter.post("/send/:id", protectRoute, sendMessage)

export default messageRouter;