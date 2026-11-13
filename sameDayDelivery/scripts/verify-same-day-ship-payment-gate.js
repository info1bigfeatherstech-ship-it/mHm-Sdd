'use strict';

/**
 * Quick unit checks for same-day ship payment gate (no DB).
 * Run: node sameDayDelivery/scripts/verify-same-day-ship-payment-gate.js
 */

const assert = require('assert');
const { evaluateSameDayShipPayment } = require('../utils/sameDayShipPaymentGate');
const { buildSameDayPendingMatch } = require('../constants/sameDayDeliveryOrderQuery');

function check(label, order, expectedOk) {
  const r = evaluateSameDayShipPayment(order);
  assert.strictEqual(r.ok, expectedOk, `${label}: expected ok=${expectedOk}, got ${JSON.stringify(r)}`);
}

check('paid full', { paymentStatus: 'paid', totalAmount: 100, amountPaidInr: 100, items: [{}] }, true);
check(
  'partially_refunded remaining paid',
  { paymentStatus: 'partially_refunded', totalAmount: 80, amountPaidInr: 80, items: [{}] },
  true
);
check('partially_paid blocked', { paymentStatus: 'partially_paid', totalAmount: 100, amountPaidInr: 50, items: [{}] }, false);
check('pending blocked', { paymentStatus: 'pending', totalAmount: 100, amountPaidInr: 0, items: [{}] }, false);
check('empty items', { paymentStatus: 'paid', totalAmount: 100, amountPaidInr: 100, items: [] }, false);
check('underpaid', { paymentStatus: 'paid', totalAmount: 100, amountPaidInr: 90, items: [{}] }, false);

const pending = buildSameDayPendingMatch();
assert.deepStrictEqual(pending.paymentStatus.$in, ['paid', 'partially_refunded']);
assert.ok(!pending.paymentStatus.$in.includes('partially_paid'));

console.log('same-day ship payment gate: ok');
