const nodemailer = require('nodemailer');

let transporterPromise = null;

const getTransporter = async () => {
  if (process.env.SMTP_USER) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  // Use Ethereal test account when SMTP not configured
  if (!transporterPromise) {
    transporterPromise = nodemailer.createTestAccount().then(account => {
      console.log('📧 Using Ethereal test email:', account.user);
      return nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: { user: account.user, pass: account.pass },
      });
    });
  }
  return transporterPromise;
};

const sendWelcomeEmail = async (email, firstName, tempPassword, schoolName) => {
  try {
    const transporter = await getTransporter();

    const mailOptions = {
      from: process.env.SMTP_FROM || '"School Transport" <noreply@schooltransport.app>',
      to: email,
      subject: `Welcome to ${schoolName} - School Transport App`,
      html: `
        <h2>Welcome, ${firstName}!</h2>
        <p>You have been added to the <strong>${schoolName}</strong> school transport system.</p>
        <p>Here are your login credentials:</p>
        <table style="border-collapse:collapse;margin:16px 0;">
          <tr><td style="padding:8px;font-weight:bold;">Email:</td><td style="padding:8px;">${email}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Password:</td><td style="padding:8px;font-family:monospace;background:#f3f4f6;border-radius:4px;">${tempPassword}</td></tr>
        </table>
        <p>Please log in and change your password as soon as possible.</p>
        <p style="color:#6b7280;font-size:12px;">— School Transport Team</p>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`📧 Preview email at: ${previewUrl}`);
    }
    console.log(`✅ Welcome email sent to ${email} (${info.messageId})`);
    return { sent: true, messageId: info.messageId, previewUrl: previewUrl || null };
  } catch (err) {
    console.error('❌ Email send failed:', err.message);
    return { sent: false, error: err.message };
  }
};

const sendPasswordResetEmail = async (email, firstName, newPassword, schoolName) => {
  try {
    const transporter = await getTransporter();

    const mailOptions = {
      from: process.env.SMTP_FROM || '"School Transport" <noreply@schooltransport.app>',
      to: email,
      subject: `Password Reset - ${schoolName} School Transport App`,
      html: `
        <h2>Password Reset</h2>
        <p>Hi ${firstName},</p>
        <p>Your password for the <strong>${schoolName}</strong> school transport system has been reset by an administrator.</p>
        <p>Here are your new login credentials:</p>
        <table style="border-collapse:collapse;margin:16px 0;">
          <tr><td style="padding:8px;font-weight:bold;">Email:</td><td style="padding:8px;">${email}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">New Password:</td><td style="padding:8px;font-family:monospace;background:#f3f4f6;border-radius:4px;">${newPassword}</td></tr>
        </table>
        <p>Please log in and change your password as soon as possible.</p>
        <p style="color:#6b7280;font-size:12px;">— School Transport Team</p>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    const previewUrl = nodemailer.getTestMessageUrl(info);
    if (previewUrl) {
      console.log(`📧 Preview email at: ${previewUrl}`);
    }
    console.log(`✅ Password reset email sent to ${email} (${info.messageId})`);
    return { sent: true, messageId: info.messageId, previewUrl: previewUrl || null };
  } catch (err) {
    console.error('❌ Password reset email failed:', err.message);
    return { sent: false, error: err.message };
  }
};

module.exports = { sendWelcomeEmail, sendPasswordResetEmail };
