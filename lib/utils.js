import jwt from "jsonwebtoken";

export const generateToken = (userId) => {
    const token = jwt.sign(
        { id: userId },
        process.env.JWT_SECRET,
        { expiresIn: "7d", algorithm: "HS256" }
    );
    return token;
};

// Returns the user id inside a valid token, throws otherwise
export const verifyToken = (token) => {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    return decoded.id;
};
