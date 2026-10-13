import express from 'express';
import { protectRoute } from '../middleware/auth.js';
import { getIceServers, hasTurnServer } from '../lib/calls.js';

const callRouter = express.Router();

// the STUN and TURN servers a browser needs to set up a call.
// `relay` says whether a TURN server is among them, without one many phone networks cannot connect
callRouter.get("/ice", protectRoute, async (req, res) => {
    const iceServers = await getIceServers();
    res.set("Cache-Control", "no-store");
    res.json({ success: true, iceServers, relay: hasTurnServer(iceServers) });
});

export default callRouter;
