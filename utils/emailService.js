// utils/emailService.js
const { Resend } = require('resend');

// Initialize Resend with your API key
const resend = new Resend(process.env.RESEND_API_KEY);

const sendOTPEmail = async (toEmail, otp, userName) => {
  try {
    const { data, error } = await resend.emails.send({
      from: 'CNS <onboarding@resend.dev>', // Use this for testing, replace with your domain later
      to: [toEmail],
      subject: 'Your CNS Password Reset Code',
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Password Reset Code</title>
          </head>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background-color: #f8f9fa; border-radius: 10px; padding: 30px; margin-top: 20px;">
              <h2 style="color: #2c3e50; margin-bottom: 20px;">Password Reset Request</h2>
              <p style="font-size: 16px;">Hi <strong>${userName || 'there'}</strong>,</p>
              <p style="font-size: 16px;">You requested to reset your password for your CNS account.</p>
              <div style="background-color: #ffffff; border-radius: 5px; padding: 20px; margin: 20px 0; text-align: center; border: 1px solid #dee2e6;">
                <p style="font-size: 14px; color: #6c757d; margin-bottom: 10px;">Your verification code is:</p>
                <p style="font-size: 36px; font-weight: bold; color: #007bff; letter-spacing: 5px; margin: 10px 0;">${otp}</p>
                <p style="font-size: 14px; color: #dc3545; margin-top: 10px;">⏰ Expires in 10 minutes</p>
              </div>
              <p style="font-size: 14px; color: #6c757d;">If you did not request this password reset, please ignore this email or contact support if you have concerns.</p>
              <hr style="border: none; border-top: 1px solid #dee2e6; margin: 20px 0;">
              <p style="font-size: 12px; color: #999; text-align: center;">This is an automated message, please do not reply to this email.</p>
            </div>
          </body>
        </html>
      `,
      text: `Hi ${userName || 'there'},\n\nYour password reset code is: ${otp}\n\nThis code expires in 10 minutes.\n\nIf you did not request this password reset, please ignore this email.`
    });

    if (error) {
      console.error('❌ Email failed:', error);
      throw new Error(error.message);
    }

    console.log('✅ Email sent successfully:', data.id);
    return {
      success: true,
      messageId: data.id,
      email: toEmail
    };
  } catch (error) {
    console.error('❌ Email service error:', {
      message: error.message,
      email: toEmail,
      timestamp: new Date().toISOString()
    });
    
    // Throw a formatted error for the calling function
    throw new Error(`Failed to send OTP email: ${error.message}`);
  }
};

module.exports = { sendOTPEmail };
