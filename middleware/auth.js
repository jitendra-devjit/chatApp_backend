import User from "../models/User.js";
import { verifyToken } from "../lib/utils.js";

// Token comes as "Authorization: Bearer <token>" (the old "token" header still works)
const readToken = (req) => {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7);
  return typeof req.headers.token === "string" ? req.headers.token : null;
};

export const protectRoute = async (req, res, next) => {
  const token = readToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: "Token missing" });
  }

  let userId;
  try {
    userId = verifyToken(token);
  } catch {
    return res.status(401).json({ success: false, message: "Invalid token" });
  }

  const user = await User.findById(userId);
  if (!user) {
    return res.status(401).json({ success: false, message: "User not found" });
  }

  req.user = user;
  next();
};
