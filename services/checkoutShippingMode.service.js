/**
 * Checkout shipping mode — standard delivery only.
 * Same-day / Shiprocket Quick has been removed; any same_day client request is ignored.
 */

const DELIVERY_UNAVAILABLE_CODE = 'DELIVERY_NOT_AVAILABLE';

const SHIPPING_SPEEDS = Object.freeze({
  STANDARD: 'standard'
});

/**
 * Always resolves to standard. Ignores same_day / legacy aliases from clients.
 */
function normalizeShippingSpeed(_raw) {
  return SHIPPING_SPEEDS.STANDARD;
}

function cloneStandardDelivery(src) {
  return {
    enabled: src?.enabled !== false
  };
}

function toStandardDeliveryPublic(src) {
  const cloned = cloneStandardDelivery(src);
  return {
    enabled: cloned.enabled,
    ready: cloned.enabled === true
  };
}

function normalizeStandardDeliveryAdminInput(raw) {
  if (raw == null) {
    return { ok: false, errors: ['standardDelivery must be an object'] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['standardDelivery must be an object'] };
  }

  const errors = [];
  const next = {};

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      errors.push('standardDelivery.enabled must be a boolean');
    } else {
      next.enabled = raw.enabled;
    }
  }

  if (errors.length) {
    return { ok: false, errors };
  }
  if (next.enabled === undefined) {
    return { ok: false, errors: ['standardDelivery.enabled is required'] };
  }
  return { ok: true, value: next };
}

function isStandardDeliveryEnabled(src) {
  if (src == null) return true;
  if (typeof src === 'boolean') return src !== false;
  if (src.standardDelivery != null && typeof src.standardDelivery === 'object') {
    return src.standardDelivery.enabled !== false;
  }
  if (typeof src.enabled === 'boolean' && !Array.isArray(src.pincodes)) {
    return src.enabled !== false;
  }
  return true;
}

function messageForDeliveryUnavailable(_reason) {
  return 'Delivery is not available for this address.';
}

/**
 * Decide which speed checkout may use. Never throws.
 * Same-day requests are ignored — only standard is offered.
 *
 * @returns {{
 *   ok: boolean,
 *   shippingSpeed: 'standard'|null,
 *   autoSelected: boolean,
 *   code?: string,
 *   reason?: string,
 *   message?: string
 * }}
 */
function resolveCheckoutShippingChoice({ standardEnabled } = {}) {
  const stdOn = standardEnabled !== false;

  if (!stdOn) {
    return {
      ok: false,
      shippingSpeed: null,
      autoSelected: false,
      code: DELIVERY_UNAVAILABLE_CODE,
      reason: 'delivery_not_available',
      message: messageForDeliveryUnavailable('delivery_not_available')
    };
  }

  return {
    ok: true,
    shippingSpeed: SHIPPING_SPEEDS.STANDARD,
    autoSelected: false
  };
}

module.exports = {
  DELIVERY_UNAVAILABLE_CODE,
  SHIPPING_SPEEDS,
  normalizeShippingSpeed,
  cloneStandardDelivery,
  toStandardDeliveryPublic,
  normalizeStandardDeliveryAdminInput,
  isStandardDeliveryEnabled,
  messageForDeliveryUnavailable,
  resolveCheckoutShippingChoice
};
