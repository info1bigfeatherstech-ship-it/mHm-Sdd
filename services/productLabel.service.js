/**
 * Product marketing labels — shared helpers (slug, defaults, ProductTag sync).
 */

const slugify = require('slugify');
const ProductLabel = require('../models/ProductLabel');
const ProductTag = require('../models/ProductTag');
const cacheService = require('./cache.service');
const cacheConfig = require('../config/cache.config');
const logger = require('../utils/logger');

const LEGACY_DEFAULT_LABELS = [
  {
    name: "Today's Deal",
    slug: 'today-arrival',
    pagePath: '/today-arrival',
    description: 'Featured deal products',
    sortOrder: 10,
    isSystem: true,
    storefronts: ['ecomm', 'wholesale'],
  },
  {
    name: 'On Sale',
    slug: 'on-sale',
    pagePath: '/on-sale',
    description: 'Sale products',
    sortOrder: 20,
    isSystem: true,
    storefronts: ['ecomm', 'wholesale'],
  },
];

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LEN = 80;
const MAX_PATH_LEN = 200;

function normalizeSlug(raw) {
  const s = slugify(String(raw || '').trim(), { lower: true, strict: true });
  return s.slice(0, 80);
}

function normalizePagePath(raw, slug) {
  let path = String(raw || '').trim();
  if (!path) {
    path = `/TagProducts/${slug}`;
  }

  // Reject absolute URLs / protocol tricks before normalizing slashes
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.includes('://') || path.includes('\\')) {
    const err = new Error('pagePath must be a relative path starting with /');
    err.code = 'INVALID_PAGE_PATH';
    throw err;
  }

  if (!path.startsWith('/')) {
    path = `/${path}`;
  }
  // Collapse duplicate slashes; keep query-free relative path only
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > MAX_PATH_LEN) {
    path = path.slice(0, MAX_PATH_LEN);
  }
  return path;
}

function normalizeStorefronts(raw) {
  const allowed = new Set(['ecomm', 'wholesale']);
  const list = Array.isArray(raw) ? raw : ['ecomm', 'wholesale'];
  const out = [];
  for (const v of list) {
    const key = String(v || '').toLowerCase().trim();
    if (!allowed.has(key)) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out.length ? out : ['ecomm', 'wholesale'];
}

function assertValidSlug(slug) {
  if (!slug || !SLUG_PATTERN.test(slug)) {
    const err = new Error(
      'Invalid slug. Use lowercase letters, numbers, and hyphens only (e.g. rakhis-sale).'
    );
    err.code = 'INVALID_SLUG';
    throw err;
  }
}

function assertValidName(name) {
  const n = String(name || '').trim();
  if (!n) {
    const err = new Error('Label name is required');
    err.code = 'INVALID_NAME';
    throw err;
  }
  if (n.length > MAX_NAME_LEN) {
    const err = new Error(`Label name must be at most ${MAX_NAME_LEN} characters`);
    err.code = 'INVALID_NAME';
    throw err;
  }
  return n;
}

async function invalidateProductCaches() {
  try {
    await cacheService.forget(`${cacheConfig.prefixes.PRODUCT}:*`);
    await cacheService.forget(`${cacheConfig.prefixes.SEARCH}:*`);
  } catch (err) {
    logger.warn('[productLabel] cache invalidation failed', { message: err?.message });
  }
}

/**
 * Merge duplicate ProductTag rows for the same product before unique index sync.
 * Safe no-op when data is already clean.
 */
async function dedupeProductTags() {
  const dupes = await ProductTag.aggregate([
    { $group: { _id: '$product', ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  let merged = 0;
  for (const row of dupes) {
    const docs = await ProductTag.find({ _id: { $in: row.ids } }).sort({ updatedAt: -1 });
    if (docs.length < 2) continue;
    const keeper = docs[0];
    const allTags = Array.from(
      new Set(docs.flatMap((d) => (Array.isArray(d.tags) ? d.tags : [])))
    );
    keeper.tags = allTags;
    await keeper.save();
    await ProductTag.deleteMany({ _id: { $in: docs.slice(1).map((d) => d._id) } });
    merged += 1;
  }
  if (merged > 0) {
    logger.info(`[productLabel] Merged ${merged} duplicate ProductTag product group(s)`);
  }
  return { merged };
}

/**
 * Idempotent seed for legacy on-sale / today-arrival so existing admin + storefront keep working.
 * Does not recreate labels an admin has deleted.
 */
async function ensureDefaultProductLabels() {
  await dedupeProductTags();
  try {
    await ProductTag.syncIndexes();
  } catch (err) {
    logger.warn('[productLabel] ProductTag.syncIndexes failed', { message: err?.message });
  }
  try {
    await ProductLabel.syncIndexes();
  } catch (err) {
    logger.warn('[productLabel] ProductLabel.syncIndexes failed', { message: err?.message });
  }

  let created = 0;
  for (const def of LEGACY_DEFAULT_LABELS) {
    const existing = await ProductLabel.findOne({ slug: def.slug }).select('_id').lean();
    if (existing) continue;
    await ProductLabel.create({
      ...def,
      isActive: true,
      showInNav: true,
    });
    created += 1;
  }
  if (created > 0) {
    logger.info(`[productLabel] Seeded ${created} default marketing label(s)`);
  }
  return { created };
}

async function findLabelByIdOrSlug(idOrSlug) {
  const raw = String(idOrSlug || '').trim();
  if (!raw) return null;
  if (/^[a-f0-9]{24}$/i.test(raw)) {
    const byId = await ProductLabel.findById(raw);
    if (byId) return byId;
  }
  return ProductLabel.findOne({ slug: normalizeSlug(raw) });
}

async function getActiveLabelSlugs() {
  const docs = await ProductLabel.find({ isActive: true }).select('slug').lean();
  return docs.map((d) => d.slug);
}

/**
 * Validate flagType for product assignment.
 * @param {string} flagType
 * @param {{ requireActive?: boolean }} [opts]
 */
async function assertAssignableLabelSlug(flagType, opts = {}) {
  const requireActive = opts.requireActive !== false;
  const slug = normalizeSlug(flagType);
  assertValidSlug(slug);
  const query = { slug };
  if (requireActive) query.isActive = true;
  const label = await ProductLabel.findOne(query).lean();
  if (!label) {
    const err = new Error(
      requireActive
        ? `Unknown or inactive label "${slug}". Create it under Product Labels first.`
        : `Unknown label "${slug}".`
    );
    err.code = 'INVALID_FLAG_TYPE';
    throw err;
  }
  return label;
}

/**
 * Rename slug across all ProductTag documents.
 */
async function migrateProductTagSlug(oldSlug, newSlug) {
  if (oldSlug === newSlug) return { matched: 0 };
  const addResult = await ProductTag.updateMany(
    { tags: oldSlug },
    { $addToSet: { tags: newSlug } }
  );
  const pullResult = await ProductTag.updateMany(
    { tags: oldSlug },
    { $pull: { tags: oldSlug } }
  );
  return {
    matched: addResult.modifiedCount || 0,
    pulled: pullResult.modifiedCount || 0,
  };
}

async function removeSlugFromAllProducts(slug) {
  const pullResult = await ProductTag.updateMany({ tags: slug }, { $pull: { tags: slug } });
  const cleanup = await ProductTag.deleteMany({ tags: { $size: 0 } });
  return {
    productsUpdated: pullResult.modifiedCount || 0,
    emptyDocsRemoved: cleanup.deletedCount || 0,
  };
}

async function countProductsForSlug(slug) {
  return ProductTag.countDocuments({ tags: slug });
}

async function attachProductCounts(labels) {
  if (!Array.isArray(labels) || labels.length === 0) return labels || [];
  const slugs = labels.map((l) => l.slug).filter(Boolean);
  if (!slugs.length) {
    return labels.map((l) => ({ ...l, productCount: 0 }));
  }
  const counts = await ProductTag.aggregate([
    { $match: { tags: { $in: slugs } } },
    { $unwind: '$tags' },
    { $match: { tags: { $in: slugs } } },
    { $group: { _id: '$tags', count: { $sum: 1 } } },
  ]);
  const map = new Map(counts.map((c) => [c._id, c.count]));
  return labels.map((l) => ({
    ...l,
    productCount: map.get(l.slug) || 0,
  }));
}

module.exports = {
  LEGACY_DEFAULT_LABELS,
  normalizeSlug,
  normalizePagePath,
  normalizeStorefronts,
  assertValidSlug,
  assertValidName,
  invalidateProductCaches,
  dedupeProductTags,
  ensureDefaultProductLabels,
  findLabelByIdOrSlug,
  getActiveLabelSlugs,
  assertAssignableLabelSlug,
  migrateProductTagSlug,
  removeSlugFromAllProducts,
  countProductsForSlug,
  attachProductCounts,
};
