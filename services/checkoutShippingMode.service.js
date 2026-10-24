/**
 * Checkout shipping mode: Standard vs Same Day.
 *
 * Standard is ON by default (legacy docs without the field stay ON).
 * When Standard is OFF, checkout may only confirm Same Day — never a silent
 * fallback to a standard courier.
 */

const { SHIPPING_SPEEDS, SAME_DAY_REASONS, normalizeShippingSpeed } = require('./sameDayDelivery.service');

const DELIVERY_UNAVAILABLE_CODE = 'DELIVERY_NOT_AVAILABLE';

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

function messageForDeliveryUnavailable(reason) {
  switch (String(reason || '').trim()) {
    case SAME_DAY_REASONS.PINCODE_NOT_ALLOWED:
      return 'Same day delivery is not available for this pincode.';
    case SAME_DAY_REASONS.BEFORE_OPEN:
      return 'Same day delivery is not available yet. Please try during shop hours.';
    case SAME_DAY_REASONS.PAST_CUTOFF:
      return 'Same day delivery cutoff has passed for today.';
    case SAME_DAY_REASONS.DISABLED_FOR_STOREFRONT:
    case SAME_DAY_REASONS.NO_PINCODES_CONFIGURED:
      return 'Same day delivery is not available, and standard delivery is turned off.';
    case SAME_DAY_REASONS.NOT_SERVICEABLE:
    case SAME_DAY_REASONS.NO_QUICK_COURIER:
    case SAME_DAY_REASONS.COORDS_REQUIRED:
    case SAME_DAY_REASONS.PICKUP_PIN_MISSING:
      return 'Same day delivery is not available for this address right now.';
    case SAME_DAY_REASONS.PROBE_ERROR:
      return 'Could not verify same day delivery for this address. Please try again.';
    default:
      return 'Delivery is not available for this address.';
  }
}

/**
 * Decide which speed checkout may use. Never throws.
 *
 * @returns {{
 *   ok: boolean,
 *   shippingSpeed: 'standard'|'same_day'|null,
 *   autoSelected: boolean,
 *   code?: string,
 *   reason?: string,
 *   message?: string
 * }}
 */
function resolveCheckoutShippingChoice({
  standardEnabled,
  sameDayOption,
  requestedSpeed
} = {}) {
  const stdOn = standardEnabled !== false;
  const sameDayOk = sameDayOption != null && sameDayOption.available === true;
  const requested = normalizeShippingSpeed(requestedSpeed);

  if (requested === SHIPPING_SPEEDS.SAME_DAY && sameDayOk) {
    return {
      ok: true,
      shippingSpeed: SHIPPING_SPEEDS.SAME_DAY,
      autoSelected: false
    };
  }

  if (!stdOn) {
    if (sameDayOk) {
      return {
        ok: true,
        shippingSpeed: SHIPPING_SPEEDS.SAME_DAY,
        autoSelected: requested !== SHIPPING_SPEEDS.SAME_DAY
      };
    }
    const reason = sameDayOption?.reason || 'delivery_not_available';
    return {
      ok: false,
      shippingSpeed: null,
      autoSelected: false,
      code: DELIVERY_UNAVAILABLE_CODE,
      reason,
      message: messageForDeliveryUnavailable(reason)
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
  cloneStandardDelivery,
  toStandardDeliveryPublic,
  normalizeStandardDeliveryAdminInput,
  isStandardDeliveryEnabled,
  messageForDeliveryUnavailable,
  resolveCheckoutShippingChoice
};
