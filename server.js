import "dotenv/config";
import { assertEnv } from "./lib/config.js";
import { connectDB } from "./lib/db.js";

try {
  assertEnv();
  await connectDB();
} catch (err) {
  console.error("Startup failed:", err.message);
  process.exit(1);
}

// loaded after dotenv so the app reads the final environment
const { server } = await import("./app.js");

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log("Server is running on PORT:", PORT));
