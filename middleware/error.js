import { HttpError } from "../lib/httpError.js";

export const notFound = (req, res) => {
  res.status(404).json({ success: false, message: "Route not found" });
};

// Express needs all four arguments to treat this as the error handler
export const errorHandler = (err, req, res, next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ success: false, message: err.message });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ success: false, message: "File is too large" });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "Invalid JSON" });
  }
  if (err.name === "ValidationError") {
    const first = Object.values(err.errors)[0];
    return res.status(400).json({ success: false, message: first?.message || "Invalid data" });
  }

  // Unknown errors are logged, the client never sees internals
  console.error(err);
  res.status(500).json({ success: false, message: "Something went wrong" });
};
