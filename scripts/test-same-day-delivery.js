/**
 * Same Day Delivery unit tests (no network).
 * Run: node scripts/test-same-day-delivery.js
 */
const assert = require('assert');
const {
  SHIPPING_SPEEDS,
  SAME_DAY_REASONS,
  normalizeShippingSpeed,
  normalizePincodeList,
  isPincodeAllowed,
  isWithinCutoff,
  describeShopWindow,
  emptySameDayOption,
  cloneSameDay,
  toSameDayPublic,
  assertCanEnableSameDay,
  normalizeSameDayAdminInput,
  buildShippingSpeedScopeMatch,
  isSameDayOrder,
  isSameDayProductCourier,
  isSameDayProbeCourier,
  excludeSameDayProductCouriers,
  filterToSameDayProbeCouriers,
  applySameDayTotalsOverride,
  priceSameDayCustomerFee,
  isRateWithinCustomerCap,
  buildHyperlocalServiceabilityParams,
  isUsableLatLng,
  customerPaidSameDayShippingInr
} = require('../services/sameDayDelivery.service');
const { hasUsableCoords } = require('../services/addressGeocode.service');

function testNormalizeSpeed() {
  assert.strictEqual(normalizeShippingSpeed('same_day'), SHIPPING_SPEEDS.SAME_DAY);
  assert.strictEqual(normalizeShippingSpeed('same-day'), SHIPPING_SPEEDS.SAME_DAY);
  assert.strictEqual(normalizeShippingSpeed('sameday'), SHIPPING_SPEEDS.SAME_DAY);
  assert.strictEqual(normalizeShippingSpeed('quick'), SHIPPING_SPEEDS.SAME_DAY);
  assert.strictEqual(normalizeShippingSpeed('standard'), SHIPPING_SPEEDS.STANDARD);
  assert.strictEqual(normalizeShippingSpeed(''), SHIPPING_SPEEDS.STANDARD);
  assert.strictEqual(normalizeShippingSpeed(null), SHIPPING_SPEEDS.STANDARD);
}

function testPincodeAllowlist() {
  const cfg = { pincodes: ['110001', '122001'] };
  assert.strictEqual(isPincodeAllowed('110001', cfg), true);
  assert.strictEqual(isPincodeAllowed('11000', cfg), false);
  assert.strictEqual(isPincodeAllowed('560001', cfg), false);
  assert.strictEqual(isPincodeAllowed('110001', { pincodes: [] }), true);
  assert.strictEqual(isPincodeAllowed('11000', { pincodes: [] }), false);
  assert.deepStrictEqual(normalizePincodeList('110001, 122001, 110001, abc'), ['110001', '122001']);
}

function testEnableGuard() {
  assert.strictEqual(assertCanEnableSameDay({ enabled: true, pincodes: [] }).ok, true);
  assert.strictEqual(assertCanEnableSameDay({ enabled: true, pincodes: ['110001'] }).ok, true);
  assert.strictEqual(assertCanEnableSameDay({ enabled: false, pincodes: [] }).ok, true);
  assert.strictEqual(
    assertCanEnableSameDay({ enabled: true, pincodes: ['110001'], openHour: 14, cutoffHour: 14 }).ok,
    false
  );
}

function testAdminInput() {
  const parsed = normalizeSameDayAdminInput({
    enabled: true,
    pincodes: '110001, 122001',
    cutoffHour: 14,
    warehouseLat: 28.4,
    warehouseLng: 77.1
  });
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.value.enabled, true);
  assert.deepStrictEqual(parsed.value.pincodes, ['110001', '122001']);
  const bad = normalizeSameDayAdminInput({ enabled: 'yes' });
  assert.strictEqual(bad.ok, false);
}

function testPublicShape() {
  const pub = toSameDayPublic({ enabled: true, pincodes: ['110001'], cutoffHour: 14 });
  assert.strictEqual(pub.pincodeCount, 1);
  assert.strictEqual(pub.pincodeRestricted, true);
  assert.strictEqual(pub.ready, true);
  const unrestricted = toSameDayPublic({ enabled: true, pincodes: [] });
  assert.strictEqual(unrestricted.ready, true);
  assert.strictEqual(unrestricted.pincodeRestricted, false);
  const off = toSameDayPublic(cloneSameDay(null));
  assert.strictEqual(off.enabled, false);
  assert.strictEqual(off.ready, false);
}

function testCutoff() {
  const cfg = { openHour: 9, cutoffHour: 14, timezone: 'Asia/Kolkata' };
  assert.strictEqual(describeShopWindow(cfg, 2).ok, false);
  assert.strictEqual(describeShopWindow(cfg, 2).reason, SAME_DAY_REASONS.BEFORE_OPEN);
  assert.strictEqual(describeShopWindow(cfg, 9).ok, true);
  assert.strictEqual(describeShopWindow(cfg, 13).ok, true);
  assert.strictEqual(describeShopWindow(cfg, 14).ok, false);
  assert.strictEqual(describeShopWindow(cfg, 14).reason, SAME_DAY_REASONS.PAST_CUTOFF);
  assert.strictEqual(isWithinCutoff(cfg, 11), true);
  assert.strictEqual(isWithinCutoff(cfg, 2), false);
  const overnight = describeShopWindow({ openHour: 22, cutoffHour: 2 }, 23);
  assert.strictEqual(overnight.ok, true);
  assert.strictEqual(describeShopWindow({ openHour: 22, cutoffHour: 2 }, 3).ok, false);
}

function testEmptyOption() {
  const opt = emptySameDayOption(SAME_DAY_REASONS.PAST_CUTOFF, { cutoffHour: 14 });
  assert.strictEqual(opt.available, false);
  assert.strictEqual(opt.reason, SAME_DAY_REASONS.PAST_CUTOFF);
  assert.strictEqual(opt.cutoffHour, 14);
  assert.strictEqual(opt.deliveryCharges, null);
}

function testAdminScope() {
  const same = buildShippingSpeedScopeMatch('same_day');
  assert.deepStrictEqual(same, { shippingSpeed: 'same_day' });
  const all = buildShippingSpeedScopeMatch('all');
  assert.deepStrictEqual(all, {});
  const standard = buildShippingSpeedScopeMatch('standard');
  assert.ok(Array.isArray(standard.$or));
  assert.ok(isSameDayOrder({ shippingSpeed: 'same_day' }));
  assert.ok(!isSameDayOrder({ shippingSpeed: 'standard' }));
  assert.ok(!isSameDayOrder({}));
}

function testCourierFilters() {
  assert.strictEqual(isSameDayProductCourier({ courier_name: 'SR Quick' }), true);
  assert.strictEqual(isSameDayProductCourier({ courier_name: 'Borzo Hyperlocal' }), true);
  assert.strictEqual(isSameDayProductCourier({ courier_name: 'Shadowfax Surface' }), false);
  assert.strictEqual(isSameDayProductCourier({ courier_name: 'Delhivery Surface' }), false);

  assert.strictEqual(isSameDayProbeCourier({ courier_name: 'SR Quick' }), true);
  assert.strictEqual(isSameDayProbeCourier({ courier_name: 'Shiprocket Quick' }), true);
  assert.strictEqual(isSameDayProbeCourier({ courier_name: 'Shadowfax Hyperlocal' }), true);
  assert.strictEqual(isSameDayProbeCourier({ courier_name: 'Shadowfax Same Day' }), true);
  assert.strictEqual(isSameDayProbeCourier({ courier_name: 'Shadowfax Surface', estimated_delivery_days: 1 }), false);
  assert.strictEqual(isSameDayProbeCourier({ courier_name: 'Shadowfax Surface', estimated_delivery_days: 4 }), false);
  assert.strictEqual(isSameDayProbeCourier({ courier_name: 'Delhivery Surface', estimated_delivery_days: 4 }), false);
  assert.strictEqual(isSameDayProbeCourier({ courier_name: 'Delhivery Surface', etd_hours: 6 }), false);
  assert.strictEqual(isSameDayProbeCourier({ courier_name: 'Delhivery Surface', etd_hours: 1 }), false);

  const list = [
    { courier_company_id: 1, courier_name: 'SR Quick', rate: 70 },
    { courier_company_id: 2, courier_name: 'Delhivery Surface', rate: 90 }
  ];
  const standard = excludeSameDayProductCouriers(list);
  assert.strictEqual(standard.length, 1);
  assert.strictEqual(standard[0].courier_name, 'Delhivery Surface');
  const quick = filterToSameDayProbeCouriers(list);
  assert.strictEqual(quick.length, 1);
  assert.strictEqual(quick[0].courier_name, 'SR Quick');
}

function testFeeAndCap() {
  assert.strictEqual(priceSameDayCustomerFee(89, 99, 1.2), 106.8);
  assert.strictEqual(priceSameDayCustomerFee(50, 99, 1.2), 99);
  assert.strictEqual(priceSameDayCustomerFee(100, 0, 1), 100);
  assert.strictEqual(isRateWithinCustomerCap(99, 99), true);
  assert.strictEqual(isRateWithinCustomerCap(99.04, 99), true);
  assert.strictEqual(isRateWithinCustomerCap(140, 99), false);
  const paid = customerPaidSameDayShippingInr({
    shippingSpeed: 'same_day',
    deliveryCharges: 99,
    shippingSnapshot: { customerShippingInr: 99, freightInr: 89 }
  });
  assert.strictEqual(paid, 99);
}

function testHyperlocalParams() {
  const ok = buildHyperlocalServiceabilityParams({
    warehouseLat: 28.524,
    warehouseLng: 77.279,
    deliveryLat: 28.541,
    deliveryLng: 77.259
  });
  assert.ok(ok);
  assert.strictEqual(ok.is_new_hyperlocal, 1);
  const missing = buildHyperlocalServiceabilityParams({
    warehouseLat: 28.524,
    warehouseLng: 77.279,
    deliveryLat: null,
    deliveryLng: 77.259
  });
  assert.strictEqual(missing, null);
  const nullIsland = buildHyperlocalServiceabilityParams({
    warehouseLat: 19.22,
    warehouseLng: 73.16,
    deliveryLat: null,
    deliveryLng: null
  });
  assert.strictEqual(nullIsland, null);
  const zeros = buildHyperlocalServiceabilityParams({
    warehouseLat: 19.22,
    warehouseLng: 73.16,
    deliveryLat: 0,
    deliveryLng: 0
  });
  assert.strictEqual(zeros, null);
  assert.strictEqual(isUsableLatLng(null, null), false);
  assert.strictEqual(isUsableLatLng(0, 0), false);
  assert.strictEqual(isUsableLatLng(19.218, 73.087), true);
}

function testHasUsableCoords() {
  assert.strictEqual(hasUsableCoords({ lat: null, lng: null }), false);
  assert.strictEqual(hasUsableCoords({ lat: 0, lng: 0 }), false);
  assert.strictEqual(hasUsableCoords({ lat: '', lng: '' }), false);
  assert.strictEqual(hasUsableCoords({ lat: 19.22, lng: 73.16 }), true);
  assert.strictEqual(hasUsableCoords(null), false);
}

function testTotalsOverride() {
  const last = {
    subtotal: 500,
    tax: 50,
    discount: 0,
    deliveryCharges: 80,
    totalAmount: 630,
    deliveryMeta: { shippingProvider: 'shipmozo', courierName: 'Surface' }
  };
  const next = applySameDayTotalsOverride(last, {
    available: true,
    deliveryCharges: 99,
    etaLabel: 'Within 6 hours',
    courierName: 'SR Quick',
    courierCompanyId: 44,
    checkoutShippingMethod: 'SR_QUICK'
  });
  assert.strictEqual(next.deliveryCharges, 99);
  assert.strictEqual(next.totalAmount, 649);
  assert.strictEqual(next.shippingSpeed, SHIPPING_SPEEDS.SAME_DAY);
  assert.strictEqual(next.deliveryMeta.shippingProvider, 'shiprocket');
  assert.strictEqual(next.deliveryMeta.checkoutShippingMethod, 'SR_QUICK');
}

function run() {
  testNormalizeSpeed();
  testPincodeAllowlist();
  testEnableGuard();
  testAdminInput();
  testPublicShape();
  testCutoff();
  testEmptyOption();
  testAdminScope();
  testCourierFilters();
  testFeeAndCap();
  testHyperlocalParams();
  testHasUsableCoords();
  testTotalsOverride();
  console.log('test-same-day-delivery: all passed');
}

run();
