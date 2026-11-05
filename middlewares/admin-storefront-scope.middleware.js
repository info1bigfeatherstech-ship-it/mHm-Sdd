/**
 * Enforces storefront scope for admin operational APIs.
 * Backward compatible: missing scope on user doc => ecomm only.
 *
 * Dropship: included in VALID. Staff with ecomm in allowedStorefronts are
 * runtime-granted dropship access. Requested storefront from header is
 * preserved (dropship is NOT collapsed to ecomm).
 */

const { STOREFRONT_HEADER_ALIASES } = require('../constants/storefrontHeaders');
const { buildOrderMatchForStorefront } = require('../utils/adminOrderScope');
const { resolveStorefront } = require('../config/storefront.config');

const VALID_STOREFRONTS = new Set(['ecomm', 'wholesale', 'dropship']);

function normalizeAllowedStorefronts(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return ['ecomm'];
  const deduped = [];
  for (const v of raw) {
    const key = String(v || '').toLowerCase().trim();
    if (!VALID_STOREFRONTS.has(key)) continue;
    if (!deduped.includes(key)) deduped.push(key);
  }
  // Runtime grant: ecomm staff may operate the dropship admin panel.
  if (deduped.includes('ecomm') && !deduped.includes('dropship')) {
    deduped.push('dropship');
  }
  return deduped.length ? deduped : ['ecomm'];
}

function resolveRequestedStorefront(req, hasExplicitHeader, allowedStorefronts) {
  if (hasExplicitHeader) {
    // Prefer already-resolved req.storefront (includes dropship via storefront.config).
    const fromReq = String(req.storefront || '').toLowerCase().trim();
    if (VALID_STOREFRONTS.has(fromReq)) return fromReq;
    const resolved = String(resolveStorefront(req) || '').toLowerCase().trim();
    if (VALID_STOREFRONTS.has(resolved)) return resolved;
    return 'ecomm';
  }
  return allowedStorefronts.length === 1 ? allowedStorefronts[0] : 'ecomm';
}

function _enforceAdminStorefrontScope(req, res, next, options = {}) {
  const allowedStorefronts = normalizeAllowedStorefronts(req.user?.allowedStorefronts);
  const requireExplicitHeader = options.requireExplicitHeader === true;
  const hasExplicitHeader = STOREFRONT_HEADER_ALIASES.some((h) => {
    const val = req.get(h);
    return val != null && String(val).trim() !== '';
  });
  if (requireExplicitHeader && !hasExplicitHeader) {
    return res.status(400).json({
      success: false,
      code: 'MISSING_STOREFRONT_HEADER',
      message: 'x-storefront header is required for this admin operation.'
    });
  }

  const requestedStorefront = resolveRequestedStorefront(req, hasExplicitHeader, allowedStorefronts);

  if (!allowedStorefronts.includes(requestedStorefront)) {
    return res.status(403).json({
      success: false,
      code: 'STOREFRONT_SCOPE_FORBIDDEN',
      message: `Access denied for storefront "${requestedStorefront}".`
    });
  }

  req.adminScope = {
    storefront: requestedStorefront,
    explicitStorefront: hasExplicitHeader ? requestedStorefront : null,
    allowedStorefronts,
    /** Orders: scoped by storefront via buildOrderMatchForStorefront. */
    orderMatch: buildOrderMatchForStorefront(requestedStorefront),
    userMatch:
      requestedStorefront === 'wholesale'
        ? {
            $or: [{ accountScope: 'wholesale' }, { userType: 'wholesaler' }, { role: 'wholesaler' }]
          }
        : requestedStorefront === 'dropship'
          ? {
              // Dropship partners live on Dropshipper model — user match unused for DS orders.
              role: 'dropshipper'
            }
          : {
              $and: [
                {
                  $or: [
                    { accountScope: 'ecomm' },
                    { accountScope: { $exists: false } },
                    { accountScope: null }
                  ]
                },
                { userType: { $nin: ['wholesaler', 'admin'] } },
                {
                  role: {
                    $nin: [
                      'wholesaler',
                      'admin',
                      'product_manager',
                      'order_manager',
                      'marketing_manager',
                      'inventory_manager'
                    ]
                  }
                }
              ]
            }
  };

  return next();
}

function requireAdminStorefrontScope(req, res, next) {
  return _enforceAdminStorefrontScope(req, res, next);
}

function requireStrictAdminStorefrontScope(req, res, next) {
  return _enforceAdminStorefrontScope(req, res, next, { requireExplicitHeader: true });
}

module.exports = {
  requireAdminStorefrontScope,
  requireStrictAdminStorefrontScope,
  normalizeAllowedStorefronts
};
