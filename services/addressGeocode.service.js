/**
 * Same Day delivery geocode — LocationIQ forward search.
 * Soft-fail: address save and checkout must succeed without coords.
 *
 * Official search API:
 *   GET https://us1.locationiq.com/v1/search?key=TOKEN&q=...&format=json
 *   https://docs.locationiq.com/docs/search-forward-geocoding
 *
 * Does not rewrite Address schema. Persists location.lat / location.lng only.
 */

const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger');
const {
  getConfigForStorefront,
  isPincodeAllowed,
  normalizePin,
  isUsableLatLng
} = require('./sameDayDelivery.service');

const DEFAULT_LOCATIONIQ_SEARCH_URL = 'https://us1.locationiq.com/v1/search';
const DEFAULT_MIN_INTERVAL_MS = 600;
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const memoryCache = new Map();
let chain = Promise.resolve();
let lastCallAt = 0;
let missingKeyWarned = false;

function trimStr(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function getLocationIqKey() {
  return String(process.env.LOCATIONIQ_API_KEY || process.env.LOCATIONIQ_ACCESS_TOKEN || '').trim();
}

function locationIqSearchUrl() {
  const raw = String(process.env.LOCATIONIQ_BASE_URL || DEFAULT_LOCATIONIQ_SEARCH_URL).trim();
  return raw || DEFAULT_LOCATIONIQ_SEARCH_URL;
}

function locationIqStructuredUrl() {
  return locationIqSearchUrl().replace(/\/search\/?$/i, '/search/structured');
}

function minIntervalMs() {
  const n = Number(process.env.LOCATIONIQ_MIN_INTERVAL_MS);
  if (Number.isFinite(n) && n >= 500) return n;
  return DEFAULT_MIN_INTERVAL_MS;
}

function cacheTtlMs() {
  const n = Number(process.env.LOCATIONIQ_CACHE_TTL_MS || process.env.NOMINATIM_CACHE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CACHE_TTL_MS;
}

function buildGeocodeText(address) {
  const parts = [
    address?.houseNumber,
    address?.building,
    address?.floor,
    address?.addressLine1,
    address?.addressLine2,
    address?.area,
    address?.landmark,
    address?.city,
    address?.state,
    address?.postalCode,
    address?.country || 'India'
  ]
    .map((p) => trimStr(p))
    .filter(Boolean);
  return parts.join(', ');
}

function buildStructuredGeocodeParams(address) {
  const street = [address?.houseNumber, address?.building, address?.addressLine1]
    .map((p) => trimStr(p))
    .filter(Boolean)
    .join(', ');
  const city = trimStr(address?.city);
  const state = trimStr(address?.state);
  const postalcode = normalizePin(address?.postalCode);
  const params = {};
  if (street) params.street = street;
  if (city) params.city = city;
  if (state) params.state = state;
  if (postalcode.length === 6) params.postalcode = postalcode;
  params.country = trimStr(address?.country) || 'India';
  return params;
}

function hashGeocodeKey(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 40);
}

function hasUsableCoords(location) {
  return isUsableLatLng(location?.lat, location?.lng);
}

function parseForwardGeocodePayload(data) {
  if (!data) return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;
  if (row.error) return null;
  const lat = row.lat ?? row.latitude;
  const lng = row.lon ?? row.lng ?? row.longitude;
  if (!isUsableLatLng(lat, lng)) return null;
  return { lat: Number(lat), lng: Number(lng) };
}

function cacheGet(key) {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt && hit.expiresAt < Date.now()) {
    memoryCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  memoryCache.set(key, { value, expiresAt: Date.now() + cacheTtlMs() });
}

function resetGeocodeRuntime() {
  memoryCache.clear();
  chain = Promise.resolve();
  lastCallAt = 0;
  missingKeyWarned = false;
}

async function waitRateLimit() {
  const wait = Math.max(0, lastCallAt + minIntervalMs() - Date.now());
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastCallAt = Date.now();
}

function logGeocodeFailure(err, stage) {
  const status = err?.response?.status;
  const bodyError = err?.response?.data?.error;
  logger.warn('[sameDay geocode] LocationIQ failed', {
    stage,
    status: status || null,
    message: bodyError || err?.message || String(err)
  });
}

async function locationIqGet(url, extraParams) {
  const key = getLocationIqKey();
  if (!key) return null;
  await waitRateLimit();
  const { data } = await axios.get(url, {
    params: {
      key,
      format: 'json',
      limit: 1,
      countrycodes: 'in',
      normalizeaddress: 1,
      ...extraParams
    },
    timeout: 8000,
    headers: { Accept: 'application/json' },
    validateStatus: (status) => status >= 200 && status < 300
  });
  return parseForwardGeocodePayload(data);
}

async function locationIqSearch(address) {
  const key = getLocationIqKey();
  if (!key) {
    if (!missingKeyWarned) {
      missingKeyWarned = true;
      logger.warn('[sameDay geocode] LOCATIONIQ_API_KEY missing — skip (address still saves)');
    }
    return null;
  }

  const text = buildGeocodeText(address);
  if (!text) return null;

  try {
    const freeForm = await locationIqGet(locationIqSearchUrl(), { q: text });
    if (hasUsableCoords(freeForm)) return freeForm;
  } catch (err) {
    const status = Number(err?.response?.status);
    if (status === 401 || status === 403) {
      logGeocodeFailure(err, 'search-auth');
      return null;
    }
    if (status === 429) {
      logGeocodeFailure(err, 'search-rate-limit');
      return null;
    }
    if (status !== 404) {
      logGeocodeFailure(err, 'search');
    }
  }

  const structured = buildStructuredGeocodeParams(address);
  if (!structured.street && !structured.postalcode) return null;

  try {
    return await locationIqGet(locationIqStructuredUrl(), structured);
  } catch (err) {
    const status = Number(err?.response?.status);
    if (status !== 404) {
      logGeocodeFailure(err, 'structured');
    }
    return null;
  }
}

function enqueueGeocode(address) {
  const run = chain.then(() => locationIqSearch(address)).catch((err) => {
    logger.warn('[sameDay geocode] queue failed', { message: err?.message || String(err) });
    return null;
  });
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Soft geocode. Never throws. Returns location object or null.
 */
async function geocodeAddressIfNeeded(address, storefront) {
  try {
    const pin = normalizePin(address?.postalCode);
    const cfg = await getConfigForStorefront(storefront || address?.storefront || 'ecomm');
    if (!cfg.enabled || !isPincodeAllowed(pin, cfg)) {
      return hasUsableCoords(address?.location) ? address.location : null;
    }

    const text = buildGeocodeText(address);
    const geocodeKey = hashGeocodeKey(text);
    if (hasUsableCoords(address?.location) && address.location.geocodeKey === geocodeKey) {
      return address.location;
    }

    const cached = cacheGet(geocodeKey);
    if (hasUsableCoords(cached)) {
      return { lat: cached.lat, lng: cached.lng, geocodeKey, geocodedAt: new Date() };
    }

    const coords = await enqueueGeocode(address);
    if (!hasUsableCoords(coords)) {
      return hasUsableCoords(address?.location) ? address.location : null;
    }

    const location = {
      lat: Number(coords.lat),
      lng: Number(coords.lng),
      geocodeKey,
      geocodedAt: new Date()
    };
    cacheSet(geocodeKey, { lat: location.lat, lng: location.lng });
    return location;
  } catch (err) {
    logger.warn('[sameDay geocode] soft-fail', { message: err?.message || String(err) });
    return hasUsableCoords(address?.location) ? address.location : null;
  }
}

/**
 * Persist coords onto an Address mongoose doc when geocode succeeds.
 * Save/update callers should still succeed if this fails.
 */
async function persistLocationIfFound(addressDoc, storefront) {
  try {
    const location = await geocodeAddressIfNeeded(addressDoc, storefront);
    if (!hasUsableCoords(location)) return addressDoc;
    addressDoc.location = {
      lat: Number(location.lat),
      lng: Number(location.lng),
      geocodeKey: location.geocodeKey || null,
      geocodedAt: location.geocodedAt || new Date()
    };
    try {
      await addressDoc.save();
    } catch (saveErr) {
      logger.warn('[sameDay geocode] persist skipped', { message: saveErr?.message || String(saveErr) });
    }
    return addressDoc;
  } catch (err) {
    logger.warn('[sameDay geocode] persist wrapper failed', { message: err?.message || String(err) });
    return addressDoc;
  }
}

/**
 * Checkout helper: reuse stored lat/lng, otherwise try a one-shot geocode.
 */
async function withSameDayDeliveryCoords(address, storefront) {
  try {
    if (hasUsableCoords(address?.location)) {
      return {
        lat: Number(address.location.lat),
        lng: Number(address.location.lng)
      };
    }
    const location = await geocodeAddressIfNeeded(address, storefront);
    if (hasUsableCoords(location)) {
      return { lat: Number(location.lat), lng: Number(location.lng) };
    }
    return { lat: null, lng: null };
  } catch (err) {
    logger.warn('[sameDay geocode] checkout coords failed', { message: err?.message || String(err) });
    return { lat: null, lng: null };
  }
}

module.exports = {
  buildGeocodeText,
  buildStructuredGeocodeParams,
  hashGeocodeKey,
  hasUsableCoords,
  isUsableLatLng,
  parseForwardGeocodePayload,
  getLocationIqKey,
  geocodeAddressIfNeeded,
  persistLocationIfFound,
  withSameDayDeliveryCoords,
  resetGeocodeRuntime
};
