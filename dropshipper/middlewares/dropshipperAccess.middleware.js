const jwt = require('jsonwebtoken');
const redisManager = require('../../config/redis.config');
const tokenStore = require('../../config/tokenBlacklist');
const { verifyToken } = require('../../middlewares/auth.middleware');
const Dropshipper = require('../models/Dropshipper');
const { verifyDropshipperAccessToken } = require('../utils/dropshipperJwt');

const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

function parseBoolEnv(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function isAuthBypassEnabled() {
  return !IS_PRODUCTION && parseBoolEnv(process.env.DROPSHIPPER_AUTH_BYPASS);
}

function extractBearer(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
}

async function isTokenBlacklisted(token) {
  try {
    const redis = redisManager.getRedisClient();
    if (redis) {
      const flagged = await redis.get(`bl_${token}`);
      if (flagged) return true;
    } else if (tokenStore.has(token)) {
      return true;
    }
  } catch {
    if (tokenStore.has(token)) return true;
  }
  return false;
}

function authError(res, status, code, message) {
  return res.status(status).json({ success: false, code, message });
}

/**
 * Require a dropshipper access JWT (or staff bypass in non-production).
 * Loads Dropshipper onto req.dropshipper. Blocks pending_otp / suspended / rejected for panel use.
 * Does NOT require active subscription — use requireActiveDropshipperSubscription for catalog/orders.
 */
async function requireDropshipperAuth(req, res, next) {
  try {
    const token = extractBearer(req);

    if (!token) {
      if (isAuthBypassEnabled()) {
        return verifyToken(req, res, async () => {
          const role = String(req.user?.role || '').toLowerCase();
          const staffRoles = new Set([
            'admin',
            'superadmin',
            'product_manager',
            'order_manager',
            'marketing_manager',
            'inventory_manager'
          ]);
          if (!staffRoles.has(role) && String(req.userType || '').toLowerCase() !== 'admin') {
            return authError(res, 401, 'DROPSHIPPER_AUTH_REQUIRED', 'Dropshipper authentication required');
          }
          req.dropshipperBypass = true;
          req.dropshipper = null;
          req.dropshipperId = null;
          req.dropshipperAccessToken = null;
          return next();
        });
      }
      return authError(res, 401, 'MISSING_AUTH_HEADER', 'Dropshipper authentication required');
    }

    // Prefer dedicated dropshipper JWT. Staff tokens must NOT authorize panel without bypass.
    let decoded;
    try {
      decoded = verifyDropshipperAccessToken(token);
    } catch (err) {
      if (isAuthBypassEnabled()) {
        // Allow staff JWT only when bypass is on
        try {
          const staffDecoded = jwt.verify(token, process.env.JWT_SECRET);
          if (staffDecoded?.type === 'access' && staffDecoded?.id) {
            return verifyToken(req, res, async () => {
              const role = String(req.user?.role || '').toLowerCase();
              const staffRoles = new Set([
                'admin',
                'superadmin',
                'product_manager',
                'order_manager',
                'marketing_manager',
                'inventory_manager'
              ]);
              if (!staffRoles.has(role) && String(req.userType || '').toLowerCase() !== 'admin') {
                return authError(res, 401, 'INVALID_DROPSHIPPER_TOKEN', 'Invalid dropshipper token');
              }
              req.dropshipperBypass = true;
              req.dropshipper = null;
              req.dropshipperId = null;
              req.dropshipperAccessToken = token;
              return next();
            });
          }
        } catch {
          /* fall through */
        }
      }
      if (err.name === 'TokenExpiredError') {
        return authError(res, 401, 'TOKEN_EXPIRED', 'Token has expired');
      }
      return authError(res, 401, 'INVALID_DROPSHIPPER_TOKEN', 'Invalid dropshipper token');
    }

    if (await isTokenBlacklisted(token)) {
      return authError(res, 401, 'TOKEN_BLACKLISTED', 'Token is blacklisted');
    }

    const dropshipper = await Dropshipper.findById(decoded.id);
    if (!dropshipper) {
      return authError(res, 401, 'DROPSHIPPER_NOT_FOUND', 'Dropshipper account not found');
    }

    const status = String(dropshipper.status || '').toLowerCase();
    if (status === 'suspended') {
      return authError(res, 403, 'ACCOUNT_SUSPENDED', 'Dropshipper account is suspended');
    }
    if (status === 'rejected') {
      return authError(res, 403, 'ACCOUNT_REJECTED', 'Dropshipper account was rejected');
    }
    if (status === 'pending_otp') {
      return authError(res, 403, 'ACCOUNT_PENDING_OTP', 'Complete OTP activation before accessing the panel');
    }

    req.dropshipper = dropshipper;
    req.dropshipperId = String(dropshipper._id);
    req.dropshipperAccessToken = token;
    req.dropshipperBypass = false;
    return next();
  } catch (error) {
    return authError(res, 500, 'DROPSHIPPER_AUTH_FAILED', error.message || 'Authentication failed');
  }
}

/**
 * Catalog / orders gate: status active AND subscription.endsAt > now.
 * Bypass staff may proceed for local testing only.
 */
async function requireActiveDropshipperSubscription(req, res, next) {
  try {
    if (req.dropshipperBypass === true && isAuthBypassEnabled()) {
      return next();
    }
    const ds = req.dropshipper;
    if (!ds) {
      return authError(res, 401, 'DROPSHIPPER_AUTH_REQUIRED', 'Dropshipper authentication required');
    }
    if (String(ds.status) !== 'active') {
      if (String(ds.status) === 'expired') {
        return authError(res, 403, 'SUBSCRIPTION_EXPIRED', 'Subscription expired — renew to continue');
      }
      return authError(res, 403, 'ACCOUNT_NOT_ACTIVE', 'Dropshipper account is not active');
    }
    if (!ds.hasActiveSubscription()) {
      if (ds.status === 'active') {
        ds.status = 'expired';
        await ds.save().catch(() => {});
      }
      return authError(res, 403, 'SUBSCRIPTION_EXPIRED', 'Subscription expired — renew to continue');
    }
    return next();
  } catch (error) {
    return authError(res, 500, 'DROPSHIPPER_SUBSCRIPTION_CHECK_FAILED', error.message || 'Subscription check failed');
  }
}

/** Optional: attach dropshipper if valid token present; never errors on missing token. */
async function optionalDropshipperAuth(req, res, next) {
  const token = extractBearer(req);
  if (!token) return next();
  try {
    const decoded = verifyDropshipperAccessToken(token);
    if (await isTokenBlacklisted(token)) return next();
    const dropshipper = await Dropshipper.findById(decoded.id);
    if (dropshipper) {
      req.dropshipper = dropshipper;
      req.dropshipperId = String(dropshipper._id);
      req.dropshipperAccessToken = token;
    }
  } catch {
    /* ignore */
  }
  return next();
}

module.exports = {
  requireDropshipperAuth,
  requireActiveDropshipperSubscription,
  optionalDropshipperAuth,
  isAuthBypassEnabled,
  isTokenBlacklisted,
  extractBearer
};
