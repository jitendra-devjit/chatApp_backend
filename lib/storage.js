import crypto from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import cloudinary from "./cloudinary.js";
import { HttpError } from "./httpError.js";

// Files of a message (photos, videos, voice notes, documents) do not travel through this server.
// The browser asks for a ticket, uploads straight to Cloudinary with it, and then hands the
// upload receipt to the message route, which checks that the receipt is real.
//
// STORAGE_DRIVER=local keeps files on this machine instead. It exists for the demo and the tests,
// where there is no Cloudinary account.

const MB = 1024 * 1024;

// what can be attached to a message. Audio is stored by Cloudinary as resource type "video"
export const UPLOAD_KINDS = {
  image: { resourceType: "image", formats: ["png", "jpg", "jpeg", "webp", "gif"], maxBytes: 10 * MB },
  video: { resourceType: "video", formats: ["mp4", "webm", "mov"], maxBytes: 100 * MB },
  audio: { resourceType: "video", formats: ["webm", "ogg", "mp3", "m4a", "mp4", "wav", "aac"], maxBytes: 10 * MB },
  file: { resourceType: "raw", formats: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "zip"], maxBytes: 10 * MB },
};

export const isLocalStorage = () => process.env.STORAGE_DRIVER === "local";
export const LOCAL_UPLOAD_DIR = path.join(os.tmpdir(), "adda-uploads");

const requireKind = (kind) => {
  if (typeof kind !== "string" || !Object.hasOwn(UPLOAD_KINDS, kind)) throw new HttpError(400, "Unknown kind of file");
  return UPLOAD_KINDS[kind];
};

const extensionOf = (name) => (typeof name === "string" && name.includes(".") ? name.split(".").pop().toLowerCase() : "");

const safeEqual = (a, b) => {
  const [left, right] = [Buffer.from(String(a)), Buffer.from(String(b))];
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const signLocal = (publicId) => crypto.createHmac("sha256", process.env.JWT_SECRET).update(publicId).digest("hex");

const cloudinaryAccount = () => {
  const { cloud_name, api_key, api_secret } = cloudinary.config();
  if (!cloud_name || !api_key || !api_secret) throw new HttpError(503, "File uploads are not set up on this server");
  return { cloud_name, api_key, api_secret };
};

// Where and how the browser may upload one file of this kind. `origin` is this server's own address
export const createUploadTicket = (kind, origin) => {
  const { resourceType, formats, maxBytes } = requireKind(kind);

  if (isLocalStorage()) {
    return { driver: "local", url: `${origin}/api/uploads/local/${kind}`, fields: {}, formats, maxBytes };
  }

  const { cloud_name, api_key, api_secret } = cloudinaryAccount();
  // everything in here is signed, so the browser cannot change the folder or the allowed formats
  const params = { timestamp: Math.round(Date.now() / 1000), folder: `chat-app/${kind}` };
  if (resourceType !== "raw") params.allowed_formats = formats.join(",");

  return {
    driver: "cloudinary",
    url: `https://api.cloudinary.com/v1_1/${cloud_name}/${resourceType}/upload`,
    fields: { ...params, api_key, signature: cloudinary.utils.api_sign_request(params, api_secret) },
    formats,
    maxBytes,
  };
};

// Saves a file sent to the local driver and answers like Cloudinary does after an upload
export const saveLocalUpload = async (kind, fileName, body) => {
  const { resourceType, formats, maxBytes } = requireKind(kind);
  if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, "The file is empty");
  if (body.length > maxBytes) throw new HttpError(413, "The file is too large");
  const format = extensionOf(fileName);
  if (!formats.includes(format)) throw new HttpError(400, "This type of file is not allowed");

  const stored = `${crypto.randomUUID()}.${format}`;
  await fs.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(LOCAL_UPLOAD_DIR, stored), body);

  const public_id = `local/${kind}/${stored}`;
  return { public_id, version: 1, signature: signLocal(public_id), resource_type: resourceType, format, bytes: body.length };
};

const positiveNumber = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

// Checks the receipt the browser got from its upload. Only a file that really went to our
// storage, into the folder of this kind, passes. Returns where the file is and what it is
export const verifyUpload = async (kind, upload, origin) => {
  const { resourceType, formats, maxBytes } = requireKind(kind);
  const invalid = new HttpError(400, "This upload is not valid");
  if (!upload || typeof upload !== "object") throw invalid;
  const { public_id: publicId, version, signature } = upload;
  if (typeof publicId !== "string" || publicId.length > 300 || typeof signature !== "string") throw invalid;

  let url;
  let format;
  if (isLocalStorage()) {
    if (!publicId.startsWith(`local/${kind}/`) || !safeEqual(signature, signLocal(publicId))) throw invalid;
    format = extensionOf(publicId);
    url = `${origin}/uploads/${path.basename(publicId)}`;
  } else {
    const { api_secret } = cloudinaryAccount();
    if (typeof version !== "number" && typeof version !== "string") throw invalid;
    const expected = cloudinary.utils.api_sign_request({ public_id: publicId, version }, api_secret);
    if (!publicId.startsWith(`chat-app/${kind}/`) || !safeEqual(signature, expected)) throw invalid;
    // a document keeps its extension in the id, pictures and videos report their format
    format = resourceType === "raw" ? extensionOf(publicId) : String(upload.format || "").toLowerCase();
    url = cloudinary.url(publicId, {
      resource_type: resourceType,
      secure: true,
      urlAnalytics: false, // no tracking suffix on the link
      version,
      ...(resourceType === "raw" ? {} : { format }),
    });
  }

  const asset = { url, publicId, resourceType };
  const size = positiveNumber(upload.bytes);
  if (!formats.includes(format) || (size && size > maxBytes)) {
    await deleteUpload(asset);
    throw new HttpError(400, formats.includes(format) ? "The file is too large" : "This type of file is not allowed");
  }

  return {
    ...asset,
    size,
    width: positiveNumber(upload.width),
    height: positiveNumber(upload.height),
    duration: positiveNumber(upload.duration),
  };
};

// Removes an uploaded file that is no longer used. Never throws, like deleteImage
export const deleteUpload = async ({ publicId, resourceType }) => {
  if (typeof publicId !== "string") return;
  try {
    if (publicId.startsWith("local/")) {
      await fs.rm(path.join(LOCAL_UPLOAD_DIR, path.basename(publicId)), { force: true });
    } else {
      await cloudinary.uploader.destroy(publicId, { resource_type: resourceType || "image" });
    }
  } catch (error) {
    console.error("Could not delete file:", error.message);
  }
};
