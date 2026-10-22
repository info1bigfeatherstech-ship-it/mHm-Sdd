const User = require('../models/User');
const { setOrUnsetUniqueString } = require('../utils/optionalUniqueContact');
const { normalizeIndianMobile, isValidIndianMobile, hasUsableCustomerPhone } = require('../utils/indianMobile');
const {
  ACCOUNT_SCOPES,
  isPrivilegedAccount,
  isWholesalerAccount,
  buildCustomerContactLookup,
  buildStaffContactLookup
} = require('../utils/accountScope');

const PHONE_BODY_KEYS = ['phone', 'mobile', 'phoneNumber'];

function extractRequestedPhone(body) {
  if (!body || typeof body !== 'object') {
    return { provided: false, raw: '' };
  }
  let provided = false;
  for (const key of PHONE_BODY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    provided = true;
    const raw = body[key];
    if (String(raw || '').trim()) {
      return { provided: true, raw };
    }
  }
  return { provided, raw: '' };
}

function canSetFirstTimeCustomerPhone(user) {
  if (!user) return false;
  if (isPrivilegedAccount(user) || isWholesalerAccount(user)) return false;
  return true;
}

function resolveCustomerPhoneScope(user) {
  if (isWholesalerAccount(user)) return ACCOUNT_SCOPES.WHOLESALE;
  return ACCOUNT_SCOPES.ECOMM;
}

/**
 * Attach a phone to an ecomm customer who does not have one yet (Google gate).
 * Does not save — caller must save the mongoose doc.
 */
async function assignFirstTimeCustomerPhone(user, rawPhone) {
  if (!canSetFirstTimeCustomerPhone(user)) {
    return {
      ok: false,
      status: 409,
      code: 'PROFILE_CONTACT_CHANGE_REQUIRES_VERIFICATION',
      message: 'Email/phone update requires verification flow. Use dedicated contact-change endpoint.'
    };
  }

  const phone = normalizeIndianMobile(rawPhone);
  if (!isValidIndianMobile(phone)) {
    return {
      ok: false,
      status: 400,
      code: 'PHONE_INVALID',
      message: 'Please enter a valid 10-digit mobile number starting with 6, 7, 8, or 9'
    };
  }

  const currentPhone = hasUsableCustomerPhone(user.phone) ? normalizeIndianMobile(user.phone) : '';
  if (currentPhone) {
    if (currentPhone === phone) {
      return { ok: true, phone, unchanged: true };
    }
    return {
      ok: false,
      status: 409,
      code: 'PROFILE_CONTACT_CHANGE_REQUIRES_VERIFICATION',
      message: 'Email/phone update requires verification flow. Use dedicated contact-change endpoint.'
    };
  }

  const reserved = await User.findOne(buildStaffContactLookup({ phone })).select('_id');
  if (reserved) {
    return {
      ok: false,
      status: 409,
      code: 'IDENTITY_RESERVED_FOR_PRIVILEGED',
      message: 'This phone belongs to a staff account and cannot be used here.'
    };
  }

  const scope = resolveCustomerPhoneScope(user);
  const existing = await User.findOne(buildCustomerContactLookup({ phone }, scope)).select('_id');
  if (existing && !existing._id.equals(user._id)) {
    return {
      ok: false,
      status: 409,
      code: 'PHONE_ALREADY_REGISTERED',
      message: 'Phone number is already associated with another account'
    };
  }

  setOrUnsetUniqueString(user, 'phone', phone);
  user.isPhoneVerified = true;
  user.isProfileComplete = true;
  return { ok: true, phone, unchanged: false };
}

module.exports = {
  PHONE_BODY_KEYS,
  extractRequestedPhone,
  canSetFirstTimeCustomerPhone,
  resolveCustomerPhoneScope,
  assignFirstTimeCustomerPhone
};
