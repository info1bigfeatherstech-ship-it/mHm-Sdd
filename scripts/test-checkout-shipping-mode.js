/**
 * Standard vs Same Day checkout mode (no network).
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
  DELIVERY_UNAVAILABLE_CODE
} = require('../services/checkoutShippingMode.service');
const { SAME_DAY_REASONS, SHIPPING_SPEEDS } = require('../services/sameDayDelivery.service');

function availableSameDay() {
  return { available: true, deliveryCharges: 99, reason: null };
}

function unavailableSameDay(reason) {
  return { available: false, deliveryCharges: null, reason };
}

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
  const bothOnSameDay = resolveCheckoutShippingChoice({
    standardEnabled: true,
    sameDayOption: availableSameDay(),
    requestedSpeed: 'same_day'
  });
  assert.strictEqual(bothOnSameDay.ok, true);
  assert.strictEqual(bothOnSameDay.shippingSpeed, SHIPPING_SPEEDS.SAME_DAY);

  const bothOnStandard = resolveCheckoutShippingChoice({
    standardEnabled: true,
    sameDayOption: availableSameDay(),
    requestedSpeed: 'standard'
  });
  assert.strictEqual(bothOnStandard.ok, true);
  assert.strictEqual(bothOnStandard.shippingSpeed, SHIPPING_SPEEDS.STANDARD);

  const fallback = resolveCheckoutShippingChoice({
    standardEnabled: true,
    sameDayOption: unavailableSameDay(SAME_DAY_REASONS.PINCODE_NOT_ALLOWED),
    requestedSpeed: 'same_day'
  });
  assert.strictEqual(fallback.ok, true);
  assert.strictEqual(fallback.shippingSpeed, SHIPPING_SPEEDS.STANDARD);

  const onlySameDay = resolveCheckoutShippingChoice({
    standardEnabled: false,
    sameDayOption: availableSameDay(),
    requestedSpeed: 'standard'
  });
  assert.strictEqual(onlySameDay.ok, true);
  assert.strictEqual(onlySameDay.shippingSpeed, SHIPPING_SPEEDS.SAME_DAY);
  assert.strictEqual(onlySameDay.autoSelected, true);

  const blocked = resolveCheckoutShippingChoice({
    standardEnabled: false,
    sameDayOption: unavailableSameDay(SAME_DAY_REASONS.PINCODE_NOT_ALLOWED),
    requestedSpeed: 'standard'
  });
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.shippingSpeed, null);
  assert.strictEqual(blocked.code, DELIVERY_UNAVAILABLE_CODE);
  assert.ok(String(blocked.message).toLowerCase().includes('pincode'));

  const bothOff = resolveCheckoutShippingChoice({
    standardEnabled: false,
    sameDayOption: unavailableSameDay(SAME_DAY_REASONS.DISABLED_FOR_STOREFRONT),
    requestedSpeed: 'same_day'
  });
  assert.strictEqual(bothOff.ok, false);
  assert.strictEqual(bothOff.code, DELIVERY_UNAVAILABLE_CODE);
}

function testMessages() {
  assert.ok(messageForDeliveryUnavailable(SAME_DAY_REASONS.PAST_CUTOFF).includes('cutoff'));
  assert.ok(messageForDeliveryUnavailable('unknown').includes('not available'));
}

function run() {
  testDefaults();
  testAdminInput();
  testMatrix();
  testMessages();
  console.log('test-checkout-shipping-mode: all passed');
}

run();
