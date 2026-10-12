import { rateLimit } from "express-rate-limit";

const limitMessage = (message) => ({ success: false, message });

// Slows down password guessing and signup spam
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT) || 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: limitMessage("Too many attempts, try again in a few minutes"),
});

// Runs after protectRoute, so the limit is per user and not per IP
export const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.MESSAGE_RATE_LIMIT) || 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user._id),
  message: limitMessage("You are sending messages too fast"),
});
