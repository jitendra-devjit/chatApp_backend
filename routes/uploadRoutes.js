import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { HttpError } from '../lib/httpError.js';
import { createUploadTicket, isLocalStorage, LOCAL_UPLOAD_DIR, saveLocalUpload } from '../lib/storage.js';
import { protectRoute } from '../middleware/auth.js';

const uploadRouter = express.Router();

// this server's own address, as the browser reached it
export const originOf = (req) => `${req.protocol}://${req.get('host')}`;

// Runs after protectRoute, so the limit is per user
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.UPLOAD_RATE_LIMIT) || 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user._id),
  message: { success: false, message: 'You are uploading too fast' },
});

// permission to upload one file of a kind (image, video, audio, file) straight to storage
uploadRouter.post('/ticket', protectRoute, uploadLimiter, (req, res) => {
  res.json({ success: true, ticket: createUploadTicket(req.body?.kind, originOf(req)) });
});

// only with STORAGE_DRIVER=local: the file itself is sent here, as the raw request body
uploadRouter.put(
  '/local/:kind',
  protectRoute,
  uploadLimiter,
  express.raw({ type: () => true, limit: '110mb' }),
  async (req, res) => {
    if (!isLocalStorage()) throw new HttpError(404, 'Route not found');
    const fileName = decodeURIComponent(String(req.get('x-file-name') || ''));
    res.json(await saveLocalUpload(req.params.kind, fileName, req.body));
  }
);

// only with STORAGE_DRIVER=local: the saved files, readable by the frontend on another port
export const localUploads = express.static(LOCAL_UPLOAD_DIR, {
  setHeaders: (res) => res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'),
});

export default uploadRouter;
