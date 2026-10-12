import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true,
    },
    fullName: {
        type: String,
        required: true,
        trim: true,
        maxlength: 50,
        index: true
    },
    password: {
        type: String,
        required: [true, "Password is required"],
        minlength:6,
        select: false, // never returned by a query unless asked with .select("+password")
    },
    profilePic: {
        type: String,  //cloudinary_url
        default:"",
    },
    // when the user last went offline
    lastSeen: {
        type: Date,
    },
    // chats (people or groups) this user pinned, muted or archived
    pinnedChats: [{ type: mongoose.Schema.Types.ObjectId }],
    mutedChats: [{ type: mongoose.Schema.Types.ObjectId }],
    archivedChats: [{ type: mongoose.Schema.Types.ObjectId }],
    bio: {
        type:String,
        trim: true,
        maxlength: 160,
        default: "",
    },
},{
    timestamps: true,
    toJSON: {
        transform: (doc, ret) => {
            delete ret.password;
            delete ret.__v;
            return ret;
        },
    },
})

const User = mongoose.model("User", userSchema);

export default User;
