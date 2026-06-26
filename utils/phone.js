/**
 * Normalize a phone number to E.164 (e.g. +254712345678).
 * Assumes Kenyan numbers if no country code is provided.
 * Returns null for empty input.
 */
function normalizePhoneE164(phone) {
  if (!phone) return null;
  const hasPlus = String(phone).trim().startsWith('+');
  let digits = String(phone).replace(/[^\d]/g, '');
  if (!digits) return null;

  if (hasPlus) {
    return '+' + digits;
  }
  // If starts with 0, replace with 254 (Kenya)
  if (digits.startsWith('0')) {
    digits = '254' + digits.slice(1);
  }
  // If a bare 9-digit local number, assume Kenya
  if (digits.length === 9) {
    digits = '254' + digits;
  }
  return '+' + digits;
}

module.exports = { normalizePhoneE164 };
