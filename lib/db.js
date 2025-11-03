import mongoose from "mongoose";

export const connectDB = async () => {
  try {
    mongoose.connection.on('connected', () => console.log('Database Connected'));
    mongoose.connection.on('error', (err) => console.error('DB error:', err));
    mongoose.connection.on('disconnected', () => console.log('Database disconnected'));

    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not defined in .env");

    await mongoose.connect(`${process.env.MONGODB_URI}/chat-app`);
  } catch (error) {
    console.error("DB connection failed:", error);
    process.exit(1);
  }
};
