// utils/emailService.js
const { Resend } = require('resend');
// Initialize Resend with your API key
const resend = new Resend(process.env.RESEND_API_KEY);

const sendOTPEmail = async (toEmail, otp, userName) => {
  try {
    const { data, error } = await resend.emails.send({
      from: 'CNS Support <support@cnsroute.com>',
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

// @desc  Sends a subscription invoice email after a successful Stripe payment
// @param toEmail       recipient
// @param invoice       {
//   businessName, businessABN,        ← your company, empty string if not set yet
//   customerBusinessName,             ← from your User record (Stripe has no such field)
//   invoiceNumber, date,               ← straight from Stripe's invoice object
//   planName, gst, total, currency,    ← straight from Stripe's invoice object
//   status                              ← always 'Paid' for this event
// }
const sendInvoiceEmail = async (toEmail, invoice) => {
  try {
    const {
      businessName = '',
      businessABN = '',
      customerBusinessName = '',
      invoiceNumber = '',
      date = '',
      planName = '',
      gst = null,
      total = '0.00',
      currency = '',
      status = 'Paid',
    } = invoice;

    const { data, error } = await resend.emails.send({
      from: 'CNS Billing <support@cnsroute.com>',
      to: [toEmail],
      subject: `Invoice #${invoiceNumber} — ${businessName || 'CNS'}`,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Invoice</title>
          </head>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background-color: #f8f9fa; border-radius: 10px; padding: 30px; margin-top: 20px;">
              <h2 style="color: #2c3e50; margin-bottom: 4px;">${businessName || 'CNS'}</h2>
              ${businessABN ? `<p style="font-size: 13px; color: #6c757d; margin: 0 0 16px 0;">ABN: ${businessABN}</p>` : ''}
              <hr style="border: none; border-top: 1px solid #dee2e6; margin: 16px 0;">

              <div style="background-color: #ffffff; border-radius: 5px; padding: 20px; border: 1px solid #dee2e6;">
                <table style="width: 100%; font-size: 14px; border-collapse: collapse;">
                  <tr>
                    <td style="padding: 6px 0; color: #6c757d;">Bill to</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600;">${customerBusinessName || '-'}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #6c757d;">Invoice #</td>
                    <td style="padding: 6px 0; text-align: right;">${invoiceNumber || '-'}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #6c757d;">Date</td>
                    <td style="padding: 6px 0; text-align: right;">${date}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #6c757d;">Subscription</td>
                    <td style="padding: 6px 0; text-align: right;">${planName}</td>
                  </tr>
                  ${gst ? `
                  <tr>
                    <td style="padding: 6px 0; color: #6c757d;">GST</td>
                    <td style="padding: 6px 0; text-align: right;">${currency} ${gst}</td>
                  </tr>` : ''}
                  <tr style="border-top: 1px solid #dee2e6;">
                    <td style="padding: 10px 0 6px 0; font-weight: bold;">Total</td>
                    <td style="padding: 10px 0 6px 0; text-align: right; font-weight: bold; font-size: 18px; color: #007bff;">${currency} ${total}</td>
                  </tr>
                  <tr>
                    <td style="padding: 6px 0; color: #6c757d;">Status</td>
                    <td style="padding: 6px 0; text-align: right; font-weight: 600; color: #16a34a;">${status}</td>
                  </tr>
                </table>
              </div>

              <p style="font-size: 14px; color: #6c757d; margin-top: 20px;">Thank you for your business.</p>
              <hr style="border: none; border-top: 1px solid #dee2e6; margin: 20px 0;">
              <p style="font-size: 12px; color: #999; text-align: center;">This is an automated message, please do not reply to this email.</p>
            </div>
          </body>
        </html>
      `,
      text: `${businessName || 'CNS'}${businessABN ? ` (ABN: ${businessABN})` : ''}\n\nBill to: ${customerBusinessName || '-'}\nInvoice #: ${invoiceNumber || '-'}\nDate: ${date}\nSubscription: ${planName}${gst ? `\nGST: ${currency} ${gst}` : ''}\nTotal: ${currency} ${total}\nStatus: ${status}\n\nThank you for your business.`
    });

    if (error) {
      console.error('❌ Invoice email failed:', error);
      throw new Error(error.message);
    }
    console.log('✅ Invoice email sent successfully:', data.id);
    return {
      success: true,
      messageId: data.id,
      email: toEmail
    };
  } catch (error) {
    console.error('❌ Invoice email service error:', {
      message: error.message,
      email: toEmail,
      timestamp: new Date().toISOString()
    });

    throw new Error(`Failed to send invoice email: ${error.message}`);
  }
};

module.exports = { sendOTPEmail, sendInvoiceEmail };
