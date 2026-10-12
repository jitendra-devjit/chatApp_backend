// without CLIENT_URL only a frontend on this machine may call the API, on any port
const LOCAL_ORIGINS = [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

// CLIENT_URL can hold several comma separated origins
export const allowedOrigins = process.env.CLIENT_URL
  ? process.env.CLIENT_URL.split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean)
  : LOCAL_ORIGINS;

export const isProduction = process.env.NODE_ENV === "production";

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
