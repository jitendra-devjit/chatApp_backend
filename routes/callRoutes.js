import express from 'express';
import { protectRoute } from '../middleware/auth.js';
import { getIceServers } from '../lib/calls.js';

const callRouter = express.Router();

// the STUN and TURN servers a browser needs to set up a call
callRouter.get("/ice", protectRoute, (req, res) => {
    res.json({ success: true, iceServers: getIceServers() });
});

export default callRouter;
