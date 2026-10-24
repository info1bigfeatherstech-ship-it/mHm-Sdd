/**
 * Address geocode helpers — no network.
 * Run: node scripts/test-address-geocode.js
 */
const assert = require('assert');
const {
  buildGeocodeText,
  buildStructuredGeocodeParams,
  parseForwardGeocodePayload,
  hasUsableCoords,
  hashGeocodeKey,
  resetGeocodeRuntime
} = require('../services/addressGeocode.service');

function testParsePayload() {
  const ok = parseForwardGeocodePayload([
    { lat: '19.2183307', lon: '73.0867074', display_name: 'Dombivli, Maharashtra' }
  ]);
  assert.strictEqual(ok.lat, 19.2183307);
  assert.strictEqual(ok.lng, 73.0867074);
  assert.strictEqual(parseForwardGeocodePayload([]), null);
  assert.strictEqual(parseForwardGeocodePayload({ error: 'Unable to geocode' }), null);
  assert.strictEqual(parseForwardGeocodePayload(null), null);
  assert.strictEqual(parseForwardGeocodePayload([{ lat: '0', lon: '0' }]), null);
  assert.ok(hasUsableCoords({ lat: 19.21, lng: 73.1 }));
  assert.strictEqual(hasUsableCoords({ lat: null, lng: null }), false);
}

function testQueryBuilders() {
  const addr = {
    houseNumber: 'A303',
    building: 'Ballaleshwar residency',
    addressLine1: 'near sarovar bar, Dombivali East',
    area: 'Dombivali',
    city: 'Thane',
    state: 'Maharashtra',
    postalCode: '421201'
  };
  const text = buildGeocodeText(addr);
  assert.ok(text.includes('421201'));
  assert.ok(text.includes('India'));
  assert.ok(!text.includes('undefined'));
  const structured = buildStructuredGeocodeParams(addr);
  assert.ok(structured.street.includes('A303'));
  assert.strictEqual(structured.postalcode, '421201');
  assert.strictEqual(structured.country, 'India');
  assert.ok(hashGeocodeKey(text).length > 8);
}

function testRuntimeReset() {
  resetGeocodeRuntime();
  assert.strictEqual(typeof resetGeocodeRuntime, 'function');
}

function run() {
  testParsePayload();
  testQueryBuilders();
  testRuntimeReset();
  console.log('test-address-geocode: all passed');
}

run();
