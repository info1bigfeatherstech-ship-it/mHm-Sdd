/**
 * Indian mobile helpers for customer auth / profile completion.
 * Frontend sends 10-digit national numbers and sometimes +91 prefixed values.
 */

const INDIAN_MOBILE_RE = /^[6-9]\d{9}$/;

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Normalize to a 10-digit national number when possible.
 * Accepts 9876543210, +91 98765 43210, 919876543210, 09876543210.
 */
function normalizeIndianMobile(value) {
  const digits = digitsOnly(value);
  if (!digits) return '';
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(-10);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(-10);
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

function isValidIndianMobile(value) {
  return INDIAN_MOBILE_RE.test(normalizeIndianMobile(value));
}

function hasUsableCustomerPhone(value) {
  return isValidIndianMobile(value);
}

module.exports = {
  INDIAN_MOBILE_RE,
  digitsOnly,
  normalizeIndianMobile,
  isValidIndianMobile,
  hasUsableCustomerPhone
};
