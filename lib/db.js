import mongoose from "mongoose";

const DEFAULT_DB_NAME = "chat-app";

// true when the connection string already names a database, like ...mongodb.net/adda
const hasDatabaseName = (uri) => /^mongodb(\+srv)?:\/\/[^/]+\/[^/?]+/.test(uri);

export const connectDB = async (uri = process.env.MONGODB_URI) => {
  if (!uri) throw new Error("MONGODB_URI is not defined in .env");

  mongoose.connection.on('connected', () => console.log('Database Connected'));
  mongoose.connection.on('error', (err) => console.error('DB error:', err.message));
  mongoose.connection.on('disconnected', () => console.log('Database disconnected'));

  await mongoose.connect(uri, hasDatabaseName(uri) ? {} : { dbName: DEFAULT_DB_NAME });
};
