import {v2 as cloudinary} from 'cloudinary'

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Uploads a validated image data URI and returns its https url
export const uploadImage = async (dataUri, folder) => {
    const upload = await cloudinary.uploader.upload(dataUri, {
        resource_type: "image",
        folder: `chat-app/${folder}`,
    });
    return upload.secure_url;
};

export default cloudinary;
