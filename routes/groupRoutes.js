import express from 'express';
import { protectRoute } from '../middleware/auth.js';
import { messageLimiter } from '../middleware/rateLimit.js';
import {
  addGroupMembers, createGroup, getGroupMessages, getGroups, markGroupRead, removeGroupMember,
  searchGroupMessages, sendGroupMessage, setGroupMemberRole, updateGroup,
} from '../controllers/groupController.js';

const groupRouter = express.Router();

groupRouter.use(protectRoute);

groupRouter.get("/", getGroups)
groupRouter.post("/", messageLimiter, createGroup)
groupRouter.put("/:id", updateGroup)
groupRouter.get("/:id/messages", getGroupMessages)
groupRouter.post("/:id/messages", messageLimiter, sendGroupMessage)
groupRouter.get("/:id/search", searchGroupMessages)
groupRouter.put("/:id/read", markGroupRead)
groupRouter.post("/:id/members", addGroupMembers)
groupRouter.delete("/:id/members/:userId", removeGroupMember)
groupRouter.put("/:id/members/:userId", setGroupMemberRole)

export default groupRouter;
