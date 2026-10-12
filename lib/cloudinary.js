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

// "https://res.cloudinary.com/<cloud>/image/upload/v1700/chat-app/messages/abc.png" -> "chat-app/messages/abc"
export const getPublicId = (url) => {
    if (typeof url !== "string") return null;
    const match = /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z0-9]+)?$/i.exec(url);
    return match ? match[1] : null;
};

// Removes an uploaded image that is no longer used. Never throws: a file left behind
// is not worth failing the request for
export const deleteImage = async (url) => {
    const publicId = getPublicId(url);
    if (!publicId) return;
    try {
        await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
    } catch (error) {
        console.error("Could not delete image:", error.message);
    }
};

export default cloudinary;
