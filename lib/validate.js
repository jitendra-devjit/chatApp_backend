import mongoose from "mongoose";
import { HttpError } from "./httpError.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const IMAGE_DATA_URI_REGEX = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_MESSAGE_LENGTH = 2000;

// Request bodies are JSON, so a field can be an object like {"$ne": null}.
// Everything that reaches a query goes through these checks first.
export const requireString = (value, field, { min = 1, max }) => {
  if (typeof value !== "string") throw new HttpError(400, `${field} is required`);
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new HttpError(400, min > 1 ? `${field} must be at least ${min} characters` : `${field} is required`);
  }
  if (trimmed.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
  return trimmed;
};

export const requireEmail = (value) => {
  const email = requireString(value, "Email", { max: 254 }).toLowerCase();
  if (!EMAIL_REGEX.test(email)) throw new HttpError(400, "Enter a valid email address");
  return email;
};

// Passwords are not trimmed. bcrypt only reads the first 72 bytes.
export const requirePassword = (value) => {
  if (typeof value !== "string" || value.length < 6) {
    throw new HttpError(400, "Password must be at least 6 characters");
  }
  if (Buffer.byteLength(value) > 72) throw new HttpError(400, "Password is too long");
  return value;
};

export const requireObjectId = (value, field = "id") => {
  if (typeof value !== "string" || !mongoose.isValidObjectId(value)) {
    throw new HttpError(400, `Invalid ${field}`);
  }
  return value;
};

const hasImageSignature = (bytes, type) => {
  const startsWith = (signature) => signature.every((byte, i) => bytes[i] === byte);
  switch (type) {
    case "png":
      return startsWith([0x89, 0x50, 0x4e, 0x47]);
    case "jpeg":
    case "jpg":
      return startsWith([0xff, 0xd8, 0xff]);
    case "gif":
      return startsWith([0x47, 0x49, 0x46, 0x38]);
    case "webp":
      return startsWith([0x52, 0x49, 0x46, 0x46]) && bytes.subarray(8, 12).toString("latin1") === "WEBP";
    default:
      return false;
  }
};

// Accepts only a base64 image data URI whose bytes really are that image type
export const requireImageDataUri = (value) => {
  if (typeof value !== "string") throw new HttpError(400, "Invalid image");
  const match = IMAGE_DATA_URI_REGEX.exec(value);
  if (!match) throw new HttpError(400, "Only PNG, JPG, WEBP or GIF images are allowed");

  const [, type, base64] = match;
  if ((base64.length * 3) / 4 > MAX_IMAGE_BYTES) throw new HttpError(413, "Image must be smaller than 3 MB");

  const header = Buffer.from(base64.slice(0, 24), "base64");
  if (!hasImageSignature(header, type)) throw new HttpError(400, "File is not a valid image");
  return value;
};
