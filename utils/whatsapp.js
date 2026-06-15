const axios = require('axios');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v18.0';

/**
 * Send a WhatsApp message using Meta's Cloud API
 * Requires WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN env vars
 */
async function sendWhatsAppMessage(to, message) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    console.warn('⚠️ WhatsApp not configured (missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN)');
    return { sent: false, error: 'WhatsApp not configured' };
  }

  try {
    const response = await axios.post(
      `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: formatPhoneForWhatsApp(to),
        type: 'text',
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`✅ WhatsApp message sent to ${to} (id: ${response.data.messages?.[0]?.id})`);
    return { sent: true, messageId: response.data.messages?.[0]?.id };
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    console.error(`❌ WhatsApp send failed to ${to}:`, errorMsg);
    return { sent: false, error: errorMsg };
  }
}

/**
 * Send welcome credentials to a parent via WhatsApp
 */
async function sendWelcomeWhatsApp(phone, firstName, username, password, schoolName) {
  const message = [
    `Hello ${firstName}! 👋`,
    '',
    `You have been registered on the *${schoolName}* school transport app (Carribu).`,
    '',
    `Here are your login credentials:`,
    `📱 *Username:* ${username}`,
    `🔑 *Password:* ${password}`,
    '',
    `Please login and change your password as soon as possible.`,
    '',
    `— ${schoolName} Transport Team`,
  ].join('\n');

  return sendWhatsAppMessage(phone, message);
}

/**
 * Format phone number for WhatsApp API (requires country code, no + prefix)
 * Assumes Kenyan numbers if no country code provided
 */
function formatPhoneForWhatsApp(phone) {
  if (!phone) return phone;
  phone = phone.replace(/[^\d]/g, '');
  // If starts with 0, replace with 254 (Kenya)
  if (phone.startsWith('0')) {
    phone = '254' + phone.slice(1);
  }
  // If doesn't start with country code, assume Kenya
  if (phone.length === 9) {
    phone = '254' + phone;
  }
  return phone;
}

module.exports = { sendWhatsAppMessage, sendWelcomeWhatsApp, formatPhoneForWhatsApp };
