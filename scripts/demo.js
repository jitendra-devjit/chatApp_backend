// Runs the whole backend without any setup: in-memory MongoDB, a few demo
// users with a conversation, and image "uploads" kept in the database.
// Data is gone when the process stops. Start with: npm run demo
import "dotenv/config";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server-core";

process.env.JWT_SECRET ||= "demo-secret-only-for-local-use-do-not-deploy";
process.env.STORAGE_DRIVER = "local"; // files sent in the demo stay in a temp folder on this machine

const DEMO_PASSWORD = "demo1234";
const DEMO_USERS = [
  { fullName: "Jitendra Devatwal", email: "jitendra@demo.dev", bio: "Building things. DSA in the morning, MERN at night." },
  { fullName: "Aarav Mehta", email: "aarav@demo.dev", bio: "Design engineer. Coffee first." },
  { fullName: "Sara Khan", email: "sara@demo.dev", bio: "Backend at heart, on call this week." },
  { fullName: "Kabir Singh", email: "kabir@demo.dev", bio: "Weekend trekker, weekday debugger." },
  { fullName: "Meera Iyer", email: "meera@demo.dev", bio: "Product, podcasts and filter coffee." },
  { fullName: "Rohan Verma", email: "rohan@demo.dev", bio: "Probably at the gym." },
];

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60 * 1000);

const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri(), { dbName: "chat-app-demo" });

const { server } = await import("../app.js");
const { default: cloudinary } = await import("../lib/cloudinary.js");
const { default: User } = await import("../models/User.js");
const { default: Message } = await import("../models/Message.js");
const { default: Group } = await import("../models/Group.js");

// demo data is thrown away, so pictures stay in the database instead of going to Cloudinary
cloudinary.uploader.upload = async (dataUri) => ({ secure_url: dataUri });
cloudinary.uploader.destroy = async () => ({ result: "ok" });

const password = await bcrypt.hash(DEMO_PASSWORD, 10);
const [me, aarav, sara, kabir, meera] = await User.create(DEMO_USERS.map((user) => ({ ...user, password })));

const chat = (from, to, text, minutes, seen = true) => ({
  senderId: from._id,
  receiverId: to._id,
  text,
  seen,
  createdAt: minutesAgo(minutes),
  updatedAt: minutesAgo(minutes),
});

await Message.insertMany(
  [
    chat(aarav, me, "Did you get a chance to look at the new landing page?", 60 * 26),
    chat(me, aarav, "Yes, went through it last night. The hero section is much cleaner now.", 60 * 26 - 3),
    chat(me, aarav, "Only thing, the pricing cards feel a bit cramped on mobile.", 60 * 26 - 4),
    chat(aarav, me, "Fair. I'll give them more room and send a new build.", 60 * 25),
    chat(aarav, me, "Pushed. Can you check on your phone?", 95),
    chat(me, aarav, "Looks great now. Spacing is perfect 👌", 90),
    chat(me, aarav, "Shipping it today?", 89),
    chat(aarav, me, "That's the plan. Deploying after lunch.", 12, false),
    chat(aarav, me, "Also, are you joining the standup tomorrow?", 11, false),
    chat(sara, me, "The API is back up, it was a bad index on the messages collection.", 60 * 5),
    chat(me, sara, "Nice catch, thanks for jumping on it.", 60 * 5 - 4),
    chat(me, kabir, "Trek this Saturday still on?", 60 * 30),
    chat(kabir, me, "100%. Leaving at 5 am, don't be late this time 😄", 60 * 29),
    chat(meera, me, "Sending the notes from today's call in a bit.", 60 * 50),
  ],
  { timestamps: false }
);

// a group with a short conversation, so group chats can be tried right away
const groupStart = minutesAgo(60 * 48);
const launchTeam = await Group.create({
  name: "Launch team",
  description: "Everything about the December launch.",
  createdBy: me._id,
  members: [me, aarav, sara, kabir].map((user, index) => ({
    user: user._id,
    role: index === 0 ? "admin" : "member",
    joinedAt: groupStart,
    lastReadAt: minutesAgo(60 * 5),
  })),
});
const inGroup = (from, text, minutes, extra = {}) => ({
  groupId: launchTeam._id,
  senderId: from._id,
  text,
  createdAt: minutesAgo(minutes),
  updatedAt: minutesAgo(minutes),
  ...extra,
});
await Message.insertMany(
  [
    inGroup(me, "Jitendra created the group", 60 * 48 - 1, { system: true }),
    inGroup(me, "Welcome everyone. Launch is on the 12th, let's keep all updates here.", 60 * 47),
    inGroup(aarav, "Design is done, handing over the final screens today.", 60 * 8),
    inGroup(sara, "API is ready for load testing 🚀", 60 * 7),
    inGroup(kabir, "I'll run the tests tonight and share the numbers.", 60 * 6),
  ],
  { timestamps: false }
);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`\nDemo server running on http://localhost:${PORT} (data is in memory only)`);
  console.log(`Login with any of these, password "${DEMO_PASSWORD}":`);
  DEMO_USERS.forEach((user) => console.log(`  ${user.email}`));
});

const shutdown = async () => {
  await mongoose.disconnect();
  await mongo.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
