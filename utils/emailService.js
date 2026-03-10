// utils/emailService.js
const { Courier } = require('@trycourier/courier');

const courier = new Courier({
  authorizationToken: process.env.COURIER_API_KEY
});

const sendOTPEmail = async (toEmail, otp, userName) => {
  try {
    const { requestId } = await courier.send({
      message: {
        to: { email: toEmail },
        content: {
          title: 'Your CNS Password Reset Code',
          body: `Hi ${userName || 'there'}, your password reset code is: ${otp}. Expires in 10 minutes. If you didn't request this, ignore this email.`,
        },
        routing: {
          method: 'single',
          channels: ['email'],
        },
      },
    });
    console.log('✅ Email sent:', requestId);
    return true;
  } catch (error) {
    console.error('❌ Email failed:', error);
    throw error;
  }
};

module.exports = { sendOTPEmail };
