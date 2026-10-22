/**
 * Catalog attribute master + shared attribute/variant helpers.
 */

const slugify = require('slugify');
const CatalogAttribute = require('../models/CatalogAttribute');
const logger = require('../utils/logger');

const CODE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_VARIANT_AXES = 3;
const MAX_VALUES_PER_ATTR = 40;
const MAX_GENERATED_VARIANTS = 100;

const DEFAULT_ATTRIBUTES = [
  {
    name: 'Color',
    code: 'color',
    kind: 'variant',
    values: ['Black', 'White', 'Red', 'Blue', 'Green', 'Grey'],
    group: 'Variant Options',
    sortOrder: 10,
    isSystem: true,
  },
  {
    name: 'Size',
    code: 'size',
    kind: 'variant',
    values: ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
    group: 'Variant Options',
    sortOrder: 20,
    isSystem: true,
  },
  {
    name: 'Pack',
    code: 'pack',
    kind: 'variant',
    values: ['1 Pack', '2 Pack', '4 Pack', '6 Pack'],
    group: 'Variant Options',
    sortOrder: 30,
    isSystem: true,
  },
  {
    name: 'Material',
    code: 'material',
    kind: 'spec',
    values: ['Plastic', 'Metal', 'Cotton', 'Polyester', 'Wood', 'Glass'],
    group: 'Product Specs',
    sortOrder: 110,
    isSystem: true,
  },
  {
    name: 'Warranty',
    code: 'warranty',
    kind: 'spec',
    values: ['No Warranty', '6 Months', '1 Year', '2 Years'],
    group: 'Product Specs',
    sortOrder: 120,
    isSystem: true,
  },
];

function normalizeCode(raw, fallbackName = '') {
  const fromRaw = slugify(String(raw || '').trim(), { lower: true, strict: true });
  if (fromRaw) return fromRaw.slice(0, 60);
  return slugify(String(fallbackName || '').trim(), { lower: true, strict: true }).slice(0, 60);
}

function assertValidCode(code) {
  if (!code || !CODE_PATTERN.test(code)) {
    const err = new Error(
      'Invalid attribute code. Use lowercase letters, numbers, and hyphens (e.g. color, pack-size).'
    );
    err.code = 'INVALID_ATTR_CODE';
    throw err;
  }
}

function normalizeValues(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    const s = String(v || '').trim().slice(0, 80);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_VALUES_PER_ATTR) break;
  }
  return out;
}

/**
 * Accepts:
 * - [{ key, value }]
 * - { color: 'Red', size: 'M' }
 * - 'Key:Value | Key:Value'
 * Returns clean [{ key, value }]
 */
function normalizeAttributePairs(input) {
  if (input == null || input === '') return [];

  let raw = input;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        raw = JSON.parse(trimmed);
      } else {
        return trimmed
          .split('|')
          .map((part) => {
            const idx = part.indexOf(':');
            if (idx <= 0) return null;
            const key = part.slice(0, idx).trim();
            const value = part.slice(idx + 1).trim();
            if (!key || !value) return null;
            return { key, value };
          })
          .filter(Boolean);
      }
    } catch {
      const err = new Error('Invalid attributes format');
      err.code = 'INVALID_ATTRIBUTES';
      throw err;
    }
  }

  if (Array.isArray(raw)) {
    return raw
      .map((a) => {
        if (!a || typeof a !== 'object') return null;
        const key = String(a.key || a.name || a.code || '').trim();
        const value = String(a.value ?? '').trim();
        if (!key || !value) return null;
        return { key, value };
      })
      .filter(Boolean);
  }

  if (typeof raw === 'object') {
    return Object.entries(raw)
      .map(([key, value]) => {
        const k = String(key || '').trim();
        const v = String(value ?? '').trim();
        if (!k || !v || v === 'none') return null;
        return { key: k, value: v };
      })
      .filter(Boolean);
  }

  return [];
}

/**
 * Cartesian product of option axes.
 * axes: [{ key: 'Color', values: ['Red','Blue'] }, ...]
 * → [[{key,value}, ...], ...]
 */
function cartesianVariantAttributes(axes) {
  if (!Array.isArray(axes) || axes.length === 0) return [[]];
  if (axes.length > MAX_VARIANT_AXES) {
    const err = new Error(`At most ${MAX_VARIANT_AXES} variant options can be combined`);
    err.code = 'TOO_MANY_VARIANT_AXES';
    throw err;
  }

  let combos = [[]];
  for (const axis of axes) {
    const key = String(axis.key || axis.name || '').trim();
    const values = normalizeValues(axis.values);
    if (!key || !values.length) {
      const err = new Error(`Variant option "${key || 'unknown'}" needs at least one value`);
      err.code = 'EMPTY_VARIANT_AXIS';
      throw err;
    }
    const next = [];
    for (const prefix of combos) {
      for (const value of values) {
        next.push([...prefix, { key, value }]);
      }
    }
    combos = next;
    if (combos.length > MAX_GENERATED_VARIANTS) {
      const err = new Error(
        `Too many variant combinations (${combos.length}). Max allowed is ${MAX_GENERATED_VARIANTS}. Reduce option values.`
      );
      err.code = 'TOO_MANY_VARIANTS';
      throw err;
    }
  }
  return combos;
}

function attributeSignature(attrs) {
  const pairs = normalizeAttributePairs(attrs);
  return pairs
    .map((a) => `${String(a.key).toLowerCase()}:${String(a.value).toLowerCase()}`)
    .sort()
    .join('|');
}

async function ensureDefaultCatalogAttributes() {
  let created = 0;
  for (const def of DEFAULT_ATTRIBUTES) {
    const existing = await CatalogAttribute.findOne({ code: def.code }).select('_id').lean();
    if (existing) continue;
    await CatalogAttribute.create({
      ...def,
      inputType: 'select',
      isActive: true,
    });
    created += 1;
  }
  if (created > 0) {
    logger.info(`[catalogAttribute] Seeded ${created} default attribute(s)`);
  }
  try {
    await CatalogAttribute.syncIndexes();
  } catch (err) {
    logger.warn('[catalogAttribute] syncIndexes failed', { message: err?.message });
  }
  return { created };
}

module.exports = {
  DEFAULT_ATTRIBUTES,
  MAX_VARIANT_AXES,
  MAX_GENERATED_VARIANTS,
  MAX_VALUES_PER_ATTR,
  normalizeCode,
  assertValidCode,
  normalizeValues,
  normalizeAttributePairs,
  cartesianVariantAttributes,
  attributeSignature,
  ensureDefaultCatalogAttributes,
};
