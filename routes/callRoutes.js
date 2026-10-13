import express from 'express';
import { protectRoute } from '../middleware/auth.js';
import { getCallUsage, getIceServers, hasTurnServer } from '../lib/calls.js';

const callRouter = express.Router();

// the STUN and TURN servers a browser needs to set up a call.
// `relay` says whether a TURN server is among them, without one many phone networks cannot connect
callRouter.get("/ice", protectRoute, async (req, res) => {
    const iceServers = await getIceServers();
    res.set("Cache-Control", "no-store");
    res.json({ success: true, iceServers, relay: hasTurnServer(iceServers) });
});

// how many hours of calls this month, against the limit that keeps the relay free of charge
callRouter.get("/usage", protectRoute, async (req, res) => {
    const { hours, limit, exceeded } = await getCallUsage();
    res.json({ success: true, hours: Math.round(hours * 10) / 10, limit, exceeded });
});

export default callRouter;
