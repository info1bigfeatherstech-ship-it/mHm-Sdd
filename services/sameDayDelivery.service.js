/**
 * Same Day Delivery domain service (Shiprocket Quick / SR_QUICK).
 *
 * Same Day is a second checkout option — never a replacement for the store's
 * active standard provider unless the customer explicitly picks it.
 *
 * Probe NEVER throws into checkout.
 * Empty pincode list = no pin filter (Shiprocket live serviceability from
 * warehouse + customer address). A non-empty list is an optional extra restrict.
 */

const logger = require('../utils/logger');
const { SHIPPING_PROVIDERS } = require('../constants/shippingProviders');
const { getCourierNameFromRow, getCourierCompanyIdFromRow } = require('./courierPolicy.service');

const SHIPPING_SPEEDS = Object.freeze({
  STANDARD: 'standard',
  SAME_DAY: 'same_day'
});

const SAME_DAY_REASONS = Object.freeze({
  DISABLED_FOR_STOREFRONT: 'disabled_for_storefront',
  NO_PINCODES_CONFIGURED: 'no_pincodes_configured',
  PAST_CUTOFF: 'past_cutoff',
  BEFORE_OPEN: 'before_open',
  PINCODE_NOT_ALLOWED: 'pincode_not_allowed',
  NOT_SERVICEABLE: 'not_serviceable',
  NO_QUICK_COURIER: 'no_quick_courier',
  COORDS_REQUIRED: 'coords_required',
  PROBE_ERROR: 'probe_error',
  PICKUP_PIN_MISSING: 'pickup_pin_missing',
  NO_COURIER_WITHIN_CAP: 'no_courier_within_cap'
});

const SAME_DAY_ADMIN_ACTIONS = Object.freeze({
  HOLD: 'hold',
  BOOK_ANYWAY: 'book_anyway',
  REFUND_CANCEL: 'refund_cancel'
});

const DEFAULT_CUTOFF_HOUR = 14;
const DEFAULT_OPEN_HOUR = 9;
const DEFAULT_FEE_BUFFER = 1.2;
const DEFAULT_FLOOR_FEE = 0;
const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_CHECKOUT_SHIPPING_METHOD = 'SR_QUICK';
const FREIGHT_CAP_TOLERANCE = 0.05;

/**
 * Tight product-name match used to KEEP Quick out of STANDARD quotes.
 * Deliberately excludes generic brands (Shadowfax / Flash / Loadshare / Rush)
 * so surface products on those partners stay on the standard path.
 */
const SAME_DAY_PRODUCT_NAME_RE =
  /quick|hyperlocal|same[\s-]*day|\bsdd\b|borzo|dunzo|wefast/i;

/** Checkout Same Day: Quick / hyperlocal product names only — never Surface, never by ETD. */
const SAME_DAY_PROBE_NAME_RE = /hyperlocal|\bquick\b|same[\s-]*day|\bsdd\b|borzo|dunzo|wefast/i;
const SAME_DAY_PROBE_SURFACE_RE = /surface/i;

function roundMoney2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function normalizePin(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 6);
}

function normalizePincodeList(input) {
  const raw = Array.isArray(input) ? input.join(',') : String(input || '');
  const pins = raw
    .split(/[,;\s]+/)
    .map((p) => normalizePin(p))
    .filter((p) => p.length === 6);
  return [...new Set(pins)];
}

function clampCutoffHour(value, fallback = DEFAULT_CUTOFF_HOUR) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const hour = Math.trunc(n);
  if (hour < 0 || hour > 23) return fallback;
  return hour;
}

function clampOpenHour(value, fallback = DEFAULT_OPEN_HOUR) {
  return clampCutoffHour(value, fallback);
}

function clampFeeBuffer(value, fallback = DEFAULT_FEE_BUFFER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 1) return 1;
  if (n > 2) return 2;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function clampFloorFee(value, fallback = DEFAULT_FLOOR_FEE) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n > 9999) return 9999;
  return roundMoney2(n);
}

/**
 * Customer-facing Same Day fee: max(floor, live * buffer).
 * Live courier cost is NOT billed 1:1 — buffer covers small post-checkout surge.
 */
function priceSameDayCustomerFee(liveRate, floorFee, buffer) {
  const live = Math.max(0, roundMoney2(liveRate));
  const floor = clampFloorFee(floorFee, 0);
  const buf = clampFeeBuffer(buffer, DEFAULT_FEE_BUFFER);
  return roundMoney2(Math.max(floor, live * buf));
}

function isRateWithinCustomerCap(rate, cap) {
  const r = Number(rate);
  const c = Number(cap);
  if (!Number.isFinite(r) || r < 0) return false;
  if (!Number.isFinite(c) || c < 0) return false;
  return r <= c + FREIGHT_CAP_TOLERANCE;
}

/**
 * GPS params for Shiprocket hyperlocal serviceability.
 * Returns null unless all four coords are usable — never send a partial flag.
 */
function buildHyperlocalServiceabilityParams({
  warehouseLat,
  warehouseLng,
  deliveryLat,
  deliveryLng
} = {}) {
  if (!isUsableLatLng(warehouseLat, warehouseLng) || !isUsableLatLng(deliveryLat, deliveryLng)) {
    return null;
  }
  const latFrom = parseOptionalCoord(warehouseLat);
  const longFrom = parseOptionalCoord(warehouseLng);
  const latTo = parseOptionalCoord(deliveryLat);
  const longTo = parseOptionalCoord(deliveryLng);
  return {
    is_new_hyperlocal: 1,
    lat_from: latFrom,
    long_from: longFrom,
    lat_to: latTo,
    long_to: longTo
  };
}

function parseOptionalCoord(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) > 180) return null;
  return n;
}

/**
 * Real GPS pair only. Rejects null/'' (Number(null)===0), and Null Island 0,0.
 */
function isUsableLatLng(lat, lng) {
  const la = parseOptionalCoord(lat);
  const ln = parseOptionalCoord(lng);
  if (la == null || ln == null) return false;
  if (Math.abs(la) > 90) return false;
  if (la === 0 && ln === 0) return false;
  return true;
}

function envFlagTrue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function configFromEnv() {
  return {
    enabled: envFlagTrue(process.env.SAME_DAY_DELIVERY_ENABLED),
    pincodes: normalizePincodeList(process.env.SAME_DAY_PINCODES),
    openHour: clampOpenHour(process.env.SAME_DAY_OPEN_HOUR, DEFAULT_OPEN_HOUR),
    cutoffHour: clampCutoffHour(process.env.SAME_DAY_CUTOFF_HOUR, DEFAULT_CUTOFF_HOUR),
    floorFeeInr: clampFloorFee(process.env.SAME_DAY_FLOOR_FEE, DEFAULT_FLOOR_FEE),
    feeBuffer: clampFeeBuffer(process.env.SAME_DAY_FEE_BUFFER, DEFAULT_FEE_BUFFER),
    warehouseLat: parseOptionalCoord(process.env.SAME_DAY_WAREHOUSE_LAT),
    warehouseLng: parseOptionalCoord(process.env.SAME_DAY_WAREHOUSE_LNG),
    timezone: String(process.env.SAME_DAY_TIMEZONE || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE,
    checkoutShippingMethod:
      String(process.env.SAME_DAY_CHECKOUT_SHIPPING_METHOD || DEFAULT_CHECKOUT_SHIPPING_METHOD).trim() ||
      DEFAULT_CHECKOUT_SHIPPING_METHOD,
    storefrontAllowlist: String(process.env.SAME_DAY_STOREFRONTS || '')
      .split(/[,;\s]+/)
      .map((s) => String(s || '').toLowerCase().trim())
      .filter(Boolean)
  };
}

function cloneSameDay(src) {
  return {
    enabled: src?.enabled === true,
    pincodes: normalizePincodeList(src?.pincodes),
    openHour: clampOpenHour(src?.openHour, DEFAULT_OPEN_HOUR),
    cutoffHour: clampCutoffHour(src?.cutoffHour, DEFAULT_CUTOFF_HOUR),
    floorFeeInr: clampFloorFee(src?.floorFeeInr, DEFAULT_FLOOR_FEE),
    feeBuffer: clampFeeBuffer(src?.feeBuffer, DEFAULT_FEE_BUFFER),
    warehouseLat: parseOptionalCoord(src?.warehouseLat),
    warehouseLng: parseOptionalCoord(src?.warehouseLng)
  };
}

function toSameDayPublic(src) {
  const cloned = cloneSameDay(src);
  return {
    ...cloned,
    pincodeCount: cloned.pincodes.length,
    pincodeRestricted: cloned.pincodes.length > 0,
    ready: cloned.enabled === true
  };
}

function normalizeSameDayAdminInput(raw) {
  if (raw == null) {
    return { ok: false, errors: ['sameDay must be an object'] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['sameDay must be an object'] };
  }

  const errors = [];
  const next = {};

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') {
      errors.push('sameDay.enabled must be a boolean');
    } else {
      next.enabled = raw.enabled;
    }
  }

  if (raw.pincodes !== undefined) {
    next.pincodes = normalizePincodeList(raw.pincodes);
  }

  if (raw.openHour !== undefined && raw.openHour !== null && raw.openHour !== '') {
    const hour = Number(raw.openHour);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
      errors.push('sameDay.openHour must be a number between 0 and 23');
    } else {
      next.openHour = Math.trunc(hour);
    }
  }

  if (raw.cutoffHour !== undefined && raw.cutoffHour !== null && raw.cutoffHour !== '') {
    const hour = Number(raw.cutoffHour);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
      errors.push('sameDay.cutoffHour must be a number between 0 and 23');
    } else {
      next.cutoffHour = Math.trunc(hour);
    }
  }

  if (raw.floorFeeInr !== undefined && raw.floorFeeInr !== null && raw.floorFeeInr !== '') {
    const fee = Number(raw.floorFeeInr);
    if (!Number.isFinite(fee) || fee < 0 || fee > 9999) {
      errors.push('sameDay.floorFeeInr must be a number between 0 and 9999');
    } else {
      next.floorFeeInr = roundMoney2(fee);
    }
  }

  if (raw.feeBuffer !== undefined && raw.feeBuffer !== null && raw.feeBuffer !== '') {
    const buf = Number(raw.feeBuffer);
    if (!Number.isFinite(buf) || buf < 1 || buf > 2) {
      errors.push('sameDay.feeBuffer must be a number between 1.0 and 2.0 (e.g. 1.2 = +20%)');
    } else {
      next.feeBuffer = clampFeeBuffer(buf, DEFAULT_FEE_BUFFER);
    }
  }

  if (raw.warehouseLat !== undefined) {
    if (raw.warehouseLat === null || raw.warehouseLat === '') {
      next.warehouseLat = null;
    } else {
      const lat = Number(raw.warehouseLat);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        errors.push('sameDay.warehouseLat must be a number between -90 and 90');
      } else {
        next.warehouseLat = lat;
      }
    }
  }

  if (raw.warehouseLng !== undefined) {
    if (raw.warehouseLng === null || raw.warehouseLng === '') {
      next.warehouseLng = null;
    } else {
      const lng = Number(raw.warehouseLng);
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        errors.push('sameDay.warehouseLng must be a number between -180 and 180');
      } else {
        next.warehouseLng = lng;
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: next };
}

function assertCanEnableSameDay(merged) {
  const enabled = merged?.enabled === true;
  if (enabled) {
    const openHour = clampOpenHour(merged?.openHour, DEFAULT_OPEN_HOUR);
    const cutoffHour = clampCutoffHour(merged?.cutoffHour, DEFAULT_CUTOFF_HOUR);
    if (openHour === cutoffHour) {
      return {
        ok: false,
        errors: ['sameDay.openHour and sameDay.cutoffHour cannot be the same (shop window would be empty)']
      };
    }
  }
  return { ok: true };
}

function normalizeShippingSpeed(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (raw === 'same_day' || raw === 'sameday' || raw === 'quick' || raw === 'sr_quick') {
    return SHIPPING_SPEEDS.SAME_DAY;
  }
  return SHIPPING_SPEEDS.STANDARD;
}

function isSameDayOrder(order) {
  return normalizeShippingSpeed(order?.shippingSpeed || order?.shippingSnapshot?.shippingSpeed) ===
    SHIPPING_SPEEDS.SAME_DAY;
}

function isPincodeAllowed(pin, cfg) {
  const normalized = normalizePin(pin);
  if (normalized.length !== 6) return false;
  const set = new Set(normalizePincodeList(cfg?.pincodes));
  // Empty list = unrestricted. Shiprocket serviceability is the gate.
  if (set.size === 0) return true;
  return set.has(normalized);
}

function resolveLocalHour(timezone) {
  try {
    const tz = String(timezone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
    const hourStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      hour12: false
    }).format(new Date());
    let hour = parseInt(String(hourStr).replace(/\D/g, ''), 10);
    if (!Number.isFinite(hour)) return null;
    if (hour === 24) hour = 0;
    if (hour < 0 || hour > 23) return null;
    return hour;
  } catch (err) {
    logger.warn('[sameDay] could not resolve local hour', { message: err?.message || String(err) });
    return null;
  }
}

/**
 * Shop window in local timezone.
 * Same-calendar window (9–14): hour >= open && hour < cutoff.
 * Overnight (22–8): hour >= open || hour < cutoff.
 */
function describeShopWindow(cfg, hourOverride) {
  const openHour = clampOpenHour(cfg?.openHour, DEFAULT_OPEN_HOUR);
  const cutoffHour = clampCutoffHour(cfg?.cutoffHour, DEFAULT_CUTOFF_HOUR);
  let hour = hourOverride;
  if (hour == null || !Number.isFinite(Number(hour))) {
    hour = resolveLocalHour(cfg?.timezone);
  } else {
    hour = Math.trunc(Number(hour));
    if (hour === 24) hour = 0;
    if (hour < 0 || hour > 23) hour = null;
  }
  if (hour == null) {
    return { ok: false, reason: SAME_DAY_REASONS.PROBE_ERROR, hour: null, openHour, cutoffHour };
  }
  if (openHour === cutoffHour) {
    return { ok: false, reason: SAME_DAY_REASONS.PAST_CUTOFF, hour, openHour, cutoffHour };
  }
  const inside =
    openHour < cutoffHour
      ? hour >= openHour && hour < cutoffHour
      : hour >= openHour || hour < cutoffHour;
  if (inside) {
    return { ok: true, reason: null, hour, openHour, cutoffHour };
  }
  if (openHour < cutoffHour) {
    return {
      ok: false,
      reason: hour < openHour ? SAME_DAY_REASONS.BEFORE_OPEN : SAME_DAY_REASONS.PAST_CUTOFF,
      hour,
      openHour,
      cutoffHour
    };
  }
  return { ok: false, reason: SAME_DAY_REASONS.PAST_CUTOFF, hour, openHour, cutoffHour };
}

function isWithinShopWindow(cfg, hourOverride) {
  return describeShopWindow(cfg, hourOverride).ok === true;
}

function isWithinCutoff(cfg, hourOverride) {
  return isWithinShopWindow(cfg, hourOverride);
}

function emptySameDayOption(reason, cfg = {}) {
  return {
    available: false,
    deliveryCharges: null,
    etaLabel: null,
    openHour: clampOpenHour(cfg?.openHour, DEFAULT_OPEN_HOUR),
    cutoffHour: clampCutoffHour(cfg?.cutoffHour, DEFAULT_CUTOFF_HOUR),
    courierName: null,
    courierCompanyId: null,
    checkoutShippingMethod: null,
    freightInr: null,
    customerShippingInr: null,
    codFeeInr: null,
    mock: false,
    reason: reason || SAME_DAY_REASONS.PROBE_ERROR
  };
}

function toPublicSameDayOption(option) {
  if (!option || typeof option !== 'object') {
    return emptySameDayOption(SAME_DAY_REASONS.PROBE_ERROR);
  }
  const openHour = clampOpenHour(option.openHour, DEFAULT_OPEN_HOUR);
  const cutoffHour = clampCutoffHour(option.cutoffHour, DEFAULT_CUTOFF_HOUR);
  if (option.available === true) {
    return {
      available: true,
      deliveryCharges: roundMoney2(option.deliveryCharges),
      etaLabel: option.etaLabel || 'Same day',
      openHour,
      cutoffHour,
      courierName: null,
      reason: null
    };
  }
  return {
    available: false,
    deliveryCharges: null,
    etaLabel: null,
    openHour,
    cutoffHour,
    courierName: null,
    reason: option.reason || SAME_DAY_REASONS.PROBE_ERROR
  };
}

async function getConfigForStorefront(storefront) {
  const envCfg = configFromEnv();
  const sf = String(storefront || 'ecomm').toLowerCase().trim() || 'ecomm';

  let docSameDay = null;
  try {
    const shippingProviderSettingsService = require('./shippingProviderSettings.service');
    const runtime = await shippingProviderSettingsService.getRuntimeConfig(sf);
    docSameDay = runtime?.sameDay || null;
  } catch (err) {
    logger.warn('[sameDay] settings load failed — using env fallback', {
      storefront: sf,
      message: err?.message || String(err)
    });
  }

  const hasDocEnabled = docSameDay && Object.prototype.hasOwnProperty.call(docSameDay, 'enabled');
  const hasDocPinsField = Array.isArray(docSameDay?.pincodes);

  let enabled = hasDocEnabled ? docSameDay.enabled === true : envCfg.enabled;
  if (!hasDocEnabled && envCfg.storefrontAllowlist.length && !envCfg.storefrontAllowlist.includes(sf)) {
    enabled = false;
  }

  return {
    storefront: sf,
    enabled,
    pincodes: hasDocPinsField ? normalizePincodeList(docSameDay.pincodes) : envCfg.pincodes,
    openHour:
      docSameDay?.openHour != null
        ? clampOpenHour(docSameDay.openHour, envCfg.openHour)
        : envCfg.openHour,
    cutoffHour: docSameDay?.cutoffHour != null
      ? clampCutoffHour(docSameDay.cutoffHour, envCfg.cutoffHour)
      : envCfg.cutoffHour,
    floorFeeInr:
      docSameDay?.floorFeeInr != null
        ? clampFloorFee(docSameDay.floorFeeInr, envCfg.floorFeeInr)
        : envCfg.floorFeeInr,
    feeBuffer:
      docSameDay?.feeBuffer != null
        ? clampFeeBuffer(docSameDay.feeBuffer, envCfg.feeBuffer)
        : envCfg.feeBuffer,
    warehouseLat:
      parseOptionalCoord(docSameDay?.warehouseLat) != null
        ? parseOptionalCoord(docSameDay.warehouseLat)
        : envCfg.warehouseLat,
    warehouseLng:
      parseOptionalCoord(docSameDay?.warehouseLng) != null
        ? parseOptionalCoord(docSameDay.warehouseLng)
        : envCfg.warehouseLng,
    timezone: envCfg.timezone,
    checkoutShippingMethod: envCfg.checkoutShippingMethod
  };
}

function isSameDayProductCourier(courier) {
  const name = getCourierNameFromRow(courier) || String(courier?.name || '').trim();
  if (!name) return false;
  return SAME_DAY_PRODUCT_NAME_RE.test(name);
}

function isSameDayProbeCourier(courier) {
  const name = getCourierNameFromRow(courier) || String(courier?.name || '').trim();
  if (!name) return false;
  if (SAME_DAY_PROBE_SURFACE_RE.test(name)) return false;
  return SAME_DAY_PROBE_NAME_RE.test(name);
}

function excludeSameDayProductCouriers(couriers) {
  if (!Array.isArray(couriers)) return [];
  return couriers.filter((c) => !isSameDayProductCourier(c));
}

function filterToSameDayProbeCouriers(couriers) {
  if (!Array.isArray(couriers)) return [];
  return couriers.filter((c) => isSameDayProbeCourier(c));
}

function toDeliveryMetaOverride(option) {
  const charges = roundMoney2(option?.deliveryCharges);
  return {
    estimatedDays: option?.etaLabel || '0-1',
    courierName: option?.courierName || null,
    courierCompanyId:
      option?.courierCompanyId != null && Number.isFinite(Number(option.courierCompanyId))
        ? Number(option.courierCompanyId)
        : null,
    shipmozoCourierId: null,
    shippingProvider: SHIPPING_PROVIDERS.SHIPROCKET,
    provider: SHIPPING_PROVIDERS.SHIPROCKET,
    pickupsAutomaticallyScheduled: null,
    isDeliverable: true,
    codAvailable: option?.codAvailable !== false,
    mock: Boolean(option?.mock),
    freightInr:
      option?.freightInr != null && Number.isFinite(Number(option.freightInr))
        ? roundMoney2(option.freightInr)
        : charges,
    codFeeInr:
      option?.codFeeInr != null && Number.isFinite(Number(option.codFeeInr))
        ? roundMoney2(option.codFeeInr)
        : 0,
    shippingSpeed: SHIPPING_SPEEDS.SAME_DAY,
    checkoutShippingMethod: option?.checkoutShippingMethod || DEFAULT_CHECKOUT_SHIPPING_METHOD,
    etaLabel: option?.etaLabel || 'Same day',
    customerShippingInr: charges
  };
}

function applySameDayTotalsOverride(standardTotals, option) {
  const charges = roundMoney2(option.deliveryCharges);
  const deliveryMeta = {
    ...(standardTotals?.deliveryMeta || {}),
    ...toDeliveryMetaOverride(option)
  };
  const subtotal = roundMoney2(standardTotals?.subtotal);
  const tax = roundMoney2(standardTotals?.tax);
  const discount = roundMoney2(standardTotals?.discount);
  return {
    ...standardTotals,
    deliveryCharges: charges,
    deliveryMeta,
    totalAmount: roundMoney2(subtotal + charges + tax - discount),
    shippingSpeed: SHIPPING_SPEEDS.SAME_DAY,
    sameDayOption: option
  };
}

function buildShippingSpeedScopeMatch(scope) {
  const raw = String(scope || 'standard').trim().toLowerCase();
  if (raw === 'all') return {};
  if (raw === SHIPPING_SPEEDS.SAME_DAY || raw === 'sameday' || raw === 'same-day') {
    return { shippingSpeed: SHIPPING_SPEEDS.SAME_DAY };
  }
  return {
    $or: [
      { shippingSpeed: { $exists: false } },
      { shippingSpeed: null },
      { shippingSpeed: SHIPPING_SPEEDS.STANDARD }
    ]
  };
}

async function probeSameDayOption({
  deliveryPincode,
  storefront,
  weightKg,
  lengthCm,
  widthCm,
  heightCm,
  codAmount,
  deliveryLat,
  deliveryLng
} = {}) {
  let cfg = {
    enabled: false,
    pincodes: [],
    openHour: DEFAULT_OPEN_HOUR,
    cutoffHour: DEFAULT_CUTOFF_HOUR,
    floorFeeInr: DEFAULT_FLOOR_FEE,
    feeBuffer: DEFAULT_FEE_BUFFER,
    timezone: DEFAULT_TIMEZONE,
    checkoutShippingMethod: DEFAULT_CHECKOUT_SHIPPING_METHOD
  };

  try {
    cfg = await getConfigForStorefront(storefront);
  } catch (err) {
    logger.warn('[sameDay] getConfigForStorefront failed', { message: err?.message || String(err) });
    return emptySameDayOption(SAME_DAY_REASONS.PROBE_ERROR, cfg);
  }

  try {
    if (!cfg.enabled) {
      return emptySameDayOption(SAME_DAY_REASONS.DISABLED_FOR_STOREFRONT, cfg);
    }
    const windowStatus = describeShopWindow(cfg);
    if (!windowStatus.ok) {
      return emptySameDayOption(windowStatus.reason || SAME_DAY_REASONS.PAST_CUTOFF, cfg);
    }
    if (!isPincodeAllowed(deliveryPincode, cfg)) {
      return emptySameDayOption(SAME_DAY_REASONS.PINCODE_NOT_ALLOWED, cfg);
    }

    const ShiprocketService = require('../utils/shiprocket');
    const result = await ShiprocketService.checkSameDayServiceability(deliveryPincode, {
      weightKg,
      lengthCm,
      widthCm,
      heightCm,
      codAmount,
      warehouseLat: cfg.warehouseLat,
      warehouseLng: cfg.warehouseLng,
      deliveryLat,
      deliveryLng,
      checkoutShippingMethod: cfg.checkoutShippingMethod
    });

    if (!result || result.available !== true) {
      return {
        ...emptySameDayOption(result?.reason || SAME_DAY_REASONS.NOT_SERVICEABLE, cfg),
        mock: Boolean(result?.mock)
      };
    }

    const liveRate =
      result.freightInr != null && Number.isFinite(Number(result.freightInr))
        ? roundMoney2(result.freightInr)
        : roundMoney2(result.deliveryCharges);
    const customerFee = priceSameDayCustomerFee(liveRate, cfg.floorFeeInr, cfg.feeBuffer);

    return {
      available: true,
      deliveryCharges: customerFee,
      etaLabel: result.etaLabel || 'Same day',
      openHour: cfg.openHour,
      cutoffHour: cfg.cutoffHour,
      courierName: result.courierName || null,
      courierCompanyId: result.courierCompanyId || null,
      checkoutShippingMethod: result.checkoutShippingMethod || cfg.checkoutShippingMethod,
      freightInr: liveRate,
      customerShippingInr: customerFee,
      codFeeInr: result.codFeeInr != null ? roundMoney2(result.codFeeInr) : 0,
      codAvailable: result.codAvailable !== false,
      mock: Boolean(result.mock),
      reason: null
    };
  } catch (err) {
    logger.warn('[sameDay] probe failed (soft)', {
      storefront,
      deliveryPincode: normalizePin(deliveryPincode),
      message: err?.message || String(err)
    });
    return emptySameDayOption(SAME_DAY_REASONS.PROBE_ERROR, cfg);
  }
}

function customerPaidSameDayShippingInr(order) {
  const snap = order?.shippingSnapshot || {};
  const n = Number(
    snap.customerShippingInr != null
      ? snap.customerShippingInr
      : order?.deliveryCharges != null
        ? order.deliveryCharges
        : snap.deliveryCharges
  );
  return Number.isFinite(n) && n >= 0 ? roundMoney2(n) : null;
}

module.exports = {
  SHIPPING_SPEEDS,
  SAME_DAY_REASONS,
  SAME_DAY_ADMIN_ACTIONS,
  DEFAULT_CUTOFF_HOUR,
  DEFAULT_OPEN_HOUR,
  DEFAULT_FEE_BUFFER,
  DEFAULT_FLOOR_FEE,
  DEFAULT_CHECKOUT_SHIPPING_METHOD,
  FREIGHT_CAP_TOLERANCE,
  normalizePin,
  normalizePincodeList,
  cloneSameDay,
  toSameDayPublic,
  normalizeSameDayAdminInput,
  assertCanEnableSameDay,
  normalizeShippingSpeed,
  isSameDayOrder,
  getConfigForStorefront,
  isPincodeAllowed,
  isWithinCutoff,
  isWithinShopWindow,
  describeShopWindow,
  emptySameDayOption,
  toPublicSameDayOption,
  probeSameDayOption,
  toDeliveryMetaOverride,
  applySameDayTotalsOverride,
  buildShippingSpeedScopeMatch,
  isSameDayProductCourier,
  isSameDayProbeCourier,
  excludeSameDayProductCouriers,
  filterToSameDayProbeCouriers,
  getCourierCompanyIdFromRow,
  priceSameDayCustomerFee,
  isRateWithinCustomerCap,
  buildHyperlocalServiceabilityParams,
  isUsableLatLng,
  parseOptionalCoord,
  customerPaidSameDayShippingInr,
  clampOpenHour,
  clampFeeBuffer,
  clampFloorFee
};
