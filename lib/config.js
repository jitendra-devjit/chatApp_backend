export const isProduction = process.env.NODE_ENV === "production";

// a frontend running on this machine, on whatever port the dev server picked
const LOCAL_ORIGINS = [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

// CLIENT_URL can hold several comma separated origins
const configuredOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean)
  : [];

// In production only CLIENT_URL may call the API. While developing, local frontends may too
export const allowedOrigins = isProduction ? configuredOrigins : [...configuredOrigins, ...LOCAL_ORIGINS];

export const assertEnv = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not defined in .env");
  if (isProduction && secret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters in production");
  }
  if (isProduction && !process.env.CLIENT_URL) {
    throw new Error("CLIENT_URL is not defined in .env");
  }
};
