/**
 * Lightweight self-check for product-label helpers (no DB required for pure utils).
 * Run: node scripts/test-product-label-helpers.js
 */

const assert = require('assert');
const {
  normalizeSlug,
  normalizePagePath,
  normalizeStorefronts,
  assertValidSlug,
  assertValidName,
  LEGACY_DEFAULT_LABELS,
} = require('../services/productLabel.service');

assert.strictEqual(normalizeSlug("Rakhi's Sale"), 'rakhis-sale');
assert.strictEqual(normalizeSlug('On Sale'), 'on-sale');
assert.strictEqual(normalizeSlug('today_arrival'), 'todayarrival'); // slugify strict strips _
assert.strictEqual(normalizeSlug('today-arrival'), 'today-arrival');

assert.strictEqual(normalizePagePath('', 'rakhis-sale'), '/TagProducts/rakhis-sale');
assert.strictEqual(normalizePagePath('shop/sale', 'x'), '/shop/sale');
assert.strictEqual(normalizePagePath('/on-sale', 'on-sale'), '/on-sale');

assert.throws(() => normalizePagePath('https://evil.com/x', 'x'), /relative path/);
assert.throws(() => assertValidSlug('Bad Slug'), /Invalid slug/);
assert.throws(() => assertValidName(''), /required/);
assert.strictEqual(assertValidName('  Rakhi Sale  '), 'Rakhi Sale');

assert.deepStrictEqual(normalizeStorefronts(['ecomm']), ['ecomm']);
assert.deepStrictEqual(normalizeStorefronts(['wholesale', 'ecomm', 'ecomm']), [
  'wholesale',
  'ecomm',
]);
assert.deepStrictEqual(normalizeStorefronts(['nope']), ['ecomm', 'wholesale']);

assert.ok(LEGACY_DEFAULT_LABELS.some((l) => l.slug === 'on-sale'));
assert.ok(LEGACY_DEFAULT_LABELS.some((l) => l.slug === 'today-arrival'));

console.log('test-product-label-helpers: OK');
