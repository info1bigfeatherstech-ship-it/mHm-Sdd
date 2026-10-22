const User = require('../models/User');
const { hasUsableCustomerPhone } = require('../utils/indianMobile');
const { isPrivilegedAccount, isWholesalerAccount } = require('../utils/accountScope');

/**
 * Authenticated ecomm customers without a phone cannot use account-bound APIs
 * until they complete the Google phone gate. Public catalog stays open.
 */
const PHONE_GATE_PREFIXES = Object.freeze([
  '/api/cart',
  '/api/wishlist',
  '/api/addresses',
  '/api/orders',
  '/api/checkout',
  '/api/coupons',
  '/api/push',
  '/api/notifications',
  '/api/delivery',
  '/api/oos-inquiries'
]);

function stripTrailingSlash(url) {
  if (!url || url === '/') return url || '/';
  return url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url;
}

function normalizeRequestPath(reqOrPath) {
  if (typeof reqOrPath === 'string') {
    return stripTrailingSlash(reqOrPath.split('?')[0] || '/');
  }
  const raw = String(reqOrPath?.originalUrl || reqOrPath?.url || reqOrPath?.path || '').split('?')[0];
  return stripTrailingSlash(raw || '/');
}

function isPhoneGatePath(reqOrPath) {
  const url = normalizeRequestPath(reqOrPath);
  return PHONE_GATE_PREFIXES.some((prefix) => url === prefix || url.startsWith(`${prefix}/`));
}

const requireCompletePhone = async (req, res, next) => {
  try {
    if (!isPhoneGatePath(req)) return next();
    if (!req.userId) return next();

    const user = await User.findById(req.userId).select('phone userType role accountScope');
    if (!user) return next();
    if (isPrivilegedAccount(user) || isWholesalerAccount(user)) return next();
    if (hasUsableCustomerPhone(user.phone)) return next();

    return res.status(403).json({
      success: false,
      code: 'PHONE_REQUIRED',
      message: 'Please add your mobile number to continue'
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  PHONE_GATE_PREFIXES,
  normalizeRequestPath,
  isPhoneGatePath,
  requireCompletePhone
};
