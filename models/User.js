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
        index: true
    },
    password: {
        type: String,
        required: [true, "Password is required"],
        minlength:6
    },
    profilePic: {
        type: String,  //cloudinary_url
        default:"",
    },
    bio: {
        type:String
    },
},{timestamps: true})

const User = mongoose.model("User", userSchema);

export default User;