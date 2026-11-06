/**
 * Standard checkout shipping mode (no network).
 * Run: node scripts/test-checkout-shipping-mode.js
 */
const assert = require('assert');
const {
  cloneStandardDelivery,
  toStandardDeliveryPublic,
  normalizeStandardDeliveryAdminInput,
  isStandardDeliveryEnabled,
  messageForDeliveryUnavailable,
  resolveCheckoutShippingChoice,
  normalizeShippingSpeed,
  DELIVERY_UNAVAILABLE_CODE,
  SHIPPING_SPEEDS
} = require('../services/checkoutShippingMode.service');

function testDefaults() {
  assert.strictEqual(cloneStandardDelivery(null).enabled, true);
  assert.strictEqual(cloneStandardDelivery({}).enabled, true);
  assert.strictEqual(cloneStandardDelivery({ enabled: false }).enabled, false);
  assert.strictEqual(isStandardDeliveryEnabled(null), true);
  assert.strictEqual(isStandardDeliveryEnabled({ standardDelivery: {} }), true);
  assert.strictEqual(isStandardDeliveryEnabled({ standardDelivery: { enabled: false } }), false);
  assert.strictEqual(toStandardDeliveryPublic({ enabled: true }).ready, true);
}

function testAdminInput() {
  const ok = normalizeStandardDeliveryAdminInput({ enabled: false });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.value.enabled, false);
  assert.strictEqual(normalizeStandardDeliveryAdminInput({ enabled: 'no' }).ok, false);
  assert.strictEqual(normalizeStandardDeliveryAdminInput(null).ok, false);
  assert.strictEqual(normalizeStandardDeliveryAdminInput({}).ok, false);
}

function testMatrix() {
  const standardOn = resolveCheckoutShippingChoice({
    standardEnabled: true,
    requestedSpeed: 'standard'
  });
  assert.strictEqual(standardOn.ok, true);
  assert.strictEqual(standardOn.shippingSpeed, SHIPPING_SPEEDS.STANDARD);

  // same_day client request is ignored → still standard when enabled
  const ignoreSameDay = resolveCheckoutShippingChoice({
    standardEnabled: true,
    requestedSpeed: 'same_day'
  });
  assert.strictEqual(ignoreSameDay.ok, true);
  assert.strictEqual(ignoreSameDay.shippingSpeed, SHIPPING_SPEEDS.STANDARD);

  const blocked = resolveCheckoutShippingChoice({
    standardEnabled: false,
    requestedSpeed: 'standard'
  });
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.shippingSpeed, null);
  assert.strictEqual(blocked.code, DELIVERY_UNAVAILABLE_CODE);

  const bothOff = resolveCheckoutShippingChoice({
    standardEnabled: false,
    requestedSpeed: 'same_day'
  });
  assert.strictEqual(bothOff.ok, false);
  assert.strictEqual(bothOff.code, DELIVERY_UNAVAILABLE_CODE);
}

function testNormalize() {
  assert.strictEqual(normalizeShippingSpeed('same_day'), SHIPPING_SPEEDS.STANDARD);
  assert.strictEqual(normalizeShippingSpeed('standard'), SHIPPING_SPEEDS.STANDARD);
  assert.strictEqual(normalizeShippingSpeed(null), SHIPPING_SPEEDS.STANDARD);
}

function testMessages() {
  assert.ok(messageForDeliveryUnavailable('unknown').includes('not available'));
}

function run() {
  testDefaults();
  testAdminInput();
  testMatrix();
  testNormalize();
  testMessages();
  console.log('test-checkout-shipping-mode: all passed');
}

run();
