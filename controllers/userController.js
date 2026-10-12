import { uploadImage } from "../lib/cloudinary.js";
import { HttpError } from "../lib/httpError.js";
import { generateToken } from "../lib/utils.js";
import { requireEmail, requireImageDataUri, requirePassword, requireString } from "../lib/validate.js";
import User from "../models/User.js";
import bcrypt from "bcryptjs";

// Compared against when the email does not exist, so both cases take the same time
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

//Signup a new user
export const signup = async(req,res)=>{
    const body = req.body || {};
    const fullName = requireString(body.fullName, "Full name", { min: 2, max: 50 });
    const email = requireEmail(body.email);
    const password = requirePassword(body.password);
    const bio = body.bio == null ? "" : requireString(body.bio, "Bio", { min: 0, max: 160 });

    const user = await User.exists({email});
    if(user){
        throw new HttpError(409, "Account already exists");
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    let newUser;
    try{
        newUser = await User.create({
            fullName, email, password:hashedPassword, bio
        })
    } catch (error){
        // two signups with the same email at the same moment
        if(error.code === 11000) throw new HttpError(409, "Account already exists");
        throw error;
    }

    const token = generateToken(newUser._id)

    res.status(201).json({success: true, userData: newUser, token, message:"Account created successfully"})
}

// controller to login a user

export const login = async(req,res)=>{
    const body = req.body || {};
    const email = requireEmail(body.email);
    if(typeof body.password !== "string" || !body.password){
        throw new HttpError(400, "Password is required");
    }

    const userData = await User.findOne({email}).select("+password");

    const isPasswordCorrect = await bcrypt.compare(body.password, userData?.password || DUMMY_HASH);

    if(!userData || !isPasswordCorrect){
        throw new HttpError(401, "Invalid email or password");
    }
    const token = generateToken(userData._id)

    res.json({success: true, userData, token, message:"Login successfully"})
}

// Controller to check if user is authenticated

export const checkAuth = (req, res) => {
    res.json({success: true, user: req.user});
}

// Controller to update user profile details

export const updateProfile = async (req, res) => {
    const { profilePic, bio, fullName } = req.body || {};
    const updates = {};

    if (fullName !== undefined) updates.fullName = requireString(fullName, "Full name", { min: 2, max: 50 });
    if (bio !== undefined) updates.bio = requireString(bio, "Bio", { min: 0, max: 160 });
    if (profilePic) {
      updates.profilePic = await uploadImage(requireImageDataUri(profilePic), "avatars");
    }

    const updatedUser = await User.findByIdAndUpdate(req.user._id, updates, {
      new: true,
      runValidators: true,
    });

    res.json({ success: true, user: updatedUser });
};
