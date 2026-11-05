const { normalizeIndianMobile, isValidIndianMobile } = require('../../utils/indianMobile');

function trimStr(v) {
  return String(v ?? '').trim();
}

function normalizeEmail(v) {
  return trimStr(v).toLowerCase();
}

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(v));
}

function parseBool(v, defaultValue = false) {
  if (v === undefined || v === null || v === '') return defaultValue;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return defaultValue;
}

function parsePositiveMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Validate registration applicant fields (JSON or multipart body).
 * @returns {{ ok: true, data } | { ok: false, code: string, message: string, errors?: any[] }}
 */
function validateRegistrationApplicant(body = {}) {
  const errors = [];
  const fullName = trimStr(body.fullName || body.name);
  const email = normalizeEmail(body.email);
  const phone = normalizeIndianMobile(body.phone || body.mobileNumber || body.mobile);
  const permanentAddress = trimStr(body.permanentAddress);
  const haveShop = parseBool(body.haveShop, false);

  if (!fullName || fullName.length < 2) {
    errors.push({ field: 'fullName', message: 'fullName is required' });
  }
  if (!isValidEmail(email)) {
    errors.push({ field: 'email', message: 'Valid email is required' });
  }
  if (!isValidIndianMobile(phone)) {
    errors.push({ field: 'phone', message: 'Valid 10-digit Indian phone is required' });
  }
  if (!permanentAddress || permanentAddress.length < 5) {
    errors.push({ field: 'permanentAddress', message: 'permanentAddress is required' });
  }

  const businessAddress = trimStr(body.businessAddress) || null;
  if (haveShop && !businessAddress) {
    errors.push({ field: 'businessAddress', message: 'businessAddress is required when haveShop is true' });
  }

  const monthlyRaw = body.monthlyEstimatedPurchase;
  let monthlyEstimatedPurchase = null;
  if (monthlyRaw !== undefined && monthlyRaw !== null && String(monthlyRaw).trim() !== '') {
    const n = Number(monthlyRaw);
    if (!Number.isFinite(n) || n < 0) {
      errors.push({ field: 'monthlyEstimatedPurchase', message: 'monthlyEstimatedPurchase must be a non-negative number' });
    } else {
      monthlyEstimatedPurchase = n;
    }
  }

  if (errors.length) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      errors
    };
  }

  return {
    ok: true,
    data: {
      fullName,
      email,
      phone,
      businessName: trimStr(body.businessName) || null,
      whatsappNumber: normalizeIndianMobile(body.whatsappNumber || body.whatsapp) || phone,
      permanentAddress,
      haveShop,
      businessAddress,
      deliveryAddress: trimStr(body.deliveryAddress) || null,
      sellingPlaceFrom: trimStr(body.sellingPlaceFrom) || null,
      sellingZoneCity: trimStr(body.sellingZoneCity) || null,
      productCategory: trimStr(body.productCategory) || null,
      monthlyEstimatedPurchase
    }
  };
}

function validatePassword(password) {
  const p = String(password || '');
  if (p.length < 6) {
    return { ok: false, message: 'password must be at least 6 characters' };
  }
  return { ok: true, password: p };
}

function validateDropshipBase(value) {
  const n = parsePositiveMoney(value);
  if (n == null) {
    return { ok: false, message: 'dropshipBase must be a non-negative number' };
  }
  return { ok: true, dropshipBase: n };
}

function normalizePaymentMode(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function isCodPaymentMode(value) {
  const m = normalizePaymentMode(value);
  return m === 'cod' || m === 'cash_on_delivery' || m === 'cash-on-delivery';
}

module.exports = {
  trimStr,
  normalizeEmail,
  isValidEmail,
  parseBool,
  parsePositiveMoney,
  validateRegistrationApplicant,
  validatePassword,
  validateDropshipBase,
  normalizePaymentMode,
  isCodPaymentMode,
  normalizeIndianMobile,
  isValidIndianMobile
};
