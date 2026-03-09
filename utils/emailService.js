// backend/utils/emailService.js

const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // use STARTTLS
  family: 4, // force IPv4 (prevents ENETUNREACH issues)
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // Gmail 16 character App Password
  },
  tls: {
    rejectUnauthorized: false,
  },
  connectionTimeout: 10000, // 10 seconds
  greetingTimeout: 10000,
  socketTimeout: 10000,
});

const sendOTPEmail = async (toEmail, otp, userName) => {
  try {
    const info = await transporter.sendMail({
      from: `"CNS App" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: "Your CNS Password Reset Code",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 420px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #2563eb; margin-bottom: 8px;">Password Reset</h2>

          <p style="color: #374151;">Hi ${userName || "there"},</p>

          <p style="color: #374151;">
            Your password reset code is:
          </p>

          <div style="
            font-size: 40px;
            font-weight: bold;
            letter-spacing: 10px;
            color: #2563eb;
            text-align: center;
            padding: 24px;
            background: #eff6ff;
            border-radius: 12px;
            margin: 20px 0;
          ">
            ${otp}
          </div>

          <p style="color: #6b7280; font-size: 14px;">
            This code expires in <strong>10 minutes</strong>.
          </p>

          <p style="color: #6b7280; font-size: 14px;">
            If you didn't request this, you can safely ignore this email.
          </p>
        </div>
      `,
    });

    console.log("✅ Email sent:", info.messageId);
    return true;

  } catch (error) {
    console.error("❌ Email send failed:", error);
    throw error;
  }
};

module.exports = { sendOTPEmail };
