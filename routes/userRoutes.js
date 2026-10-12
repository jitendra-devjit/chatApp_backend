import express from 'express';
import { checkAuth, login, signup, updateProfile } from '../controllers/userController.js';
import { protectRoute } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';

const userRouter = express.Router();

userRouter.post("/signup", authLimiter, signup)
userRouter.post("/login", authLimiter, login)
userRouter.put("/update-profile",protectRoute, updateProfile);
userRouter.get("/check",protectRoute, checkAuth)

export default userRouter;
