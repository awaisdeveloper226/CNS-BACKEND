// utils/emailService.js

const axios = require("axios");

const sendOTPEmail = async (toEmail, otp, userName) => {
  try {
    const response = await axios.post(
      "https://api.courier.com/messages",
      {
        to: {
          email: toEmail,
        },
        content: {
          title: "Your CNS Password Reset Code",
          body: `Hi ${userName || "there"}, your password reset code is ${otp}. It expires in 10 minutes. If you did not request this, ignore this email.`,
        },
      },
      {
        headers: {
          "Authorization": `Bearer ${process.env.COURIER_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Email sent:", response.data.requestId);
    return true;
  } catch (error) {
    console.error("❌ Email failed:", error.response?.data || error.message);
    console.error("Status:", error.response?.status);
    console.error("Headers:", error.response?.headers);
    throw error;
  }
};

module.exports = { sendOTPEmail };
