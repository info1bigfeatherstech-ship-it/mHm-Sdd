/**
 * Dropship catalog listing helpers.
 * Listing = channelVisibility.dropship === 'active'
 *   AND dropship === true
 *   AND valid dropshipBase > 0
 */

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getDropshipBase(variant) {
  return toNumber(variant?.price?.dropshipBase);
}

function isListedDropshipVariant(variant) {
  if (!variant || variant.isActive === false) return false;
  if (variant.dropship !== true) return false;
  const visibility = String(variant.channelVisibility?.dropship || '').toLowerCase();
  if (visibility !== 'active') return false;
  const base = getDropshipBase(variant);
  return base != null && base > 0;
}

function productHasListedDropshipVariant(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  return variants.some(isListedDropshipVariant);
}

/**
 * Mongo match for products that have at least one listed dropship variant.
 * Combined with product-level channelStatus.dropship when set.
 */
function buildListedDropshipProductMatch({ q, categoryId, inStockOnly } = {}) {
  const and = [
    { status: { $ne: 'archived' } },
    {
      $or: [
        { 'channelStatus.dropship': 'active' },
        { 'channelStatus.dropship': { $exists: false } },
        { 'channelStatus.dropship': null }
      ]
    },
    {
      variants: {
        $elemMatch: {
          dropship: true,
          isActive: { $ne: false },
          'channelVisibility.dropship': 'active',
          'price.dropshipBase': { $gt: 0 }
        }
      }
    }
  ];

  if (categoryId) {
    and.push({ category: categoryId });
  }

  if (q && String(q).trim()) {
    const term = String(q).trim();
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    and.push({
      $or: [
        { name: re },
        { title: re },
        { slug: re },
        { 'variants.sku': re },
        { 'variants.productCode': re }
      ]
    });
  }

  if (inStockOnly === true || inStockOnly === 'true' || inStockOnly === '1') {
    and.push({
      variants: {
        $elemMatch: {
          dropship: true,
          isActive: { $ne: false },
          'channelVisibility.dropship': 'active',
          'price.dropshipBase': { $gt: 0 },
          $or: [
            { 'inventory.trackInventory': false },
            { 'inventory.quantity': { $gt: 0 } }
          ]
        }
      }
    });
  }

  return { $and: and };
}

function syncProductChannelStatusDropship(product) {
  if (!product) return;
  const anyListed = productHasListedDropshipVariant(product);
  product.channelStatus = product.channelStatus || {};
  if (anyListed) {
    product.channelStatus.dropship = 'active';
  } else if (product.channelStatus.dropship === 'active') {
    product.channelStatus.dropship = 'draft';
  }
  if (typeof product.markModified === 'function') {
    product.markModified('channelStatus');
  }
}

function enableDropshipVariant(variant, dropshipBase) {
  if (!variant) return;
  variant.dropship = true;
  variant.channelVisibility = variant.channelVisibility || {};
  variant.channelVisibility.dropship = 'active';
  if (dropshipBase != null) {
    const n = toNumber(dropshipBase);
    if (n != null && n >= 0) {
      variant.price = variant.price || {};
      variant.price.dropshipBase = n;
    }
  }
}

function disableDropshipVariant(variant, { clearPrice = false } = {}) {
  if (!variant) return;
  variant.dropship = false;
  variant.channelVisibility = variant.channelVisibility || {};
  variant.channelVisibility.dropship = 'draft';
  if (clearPrice) {
    variant.price = variant.price || {};
    variant.price.dropshipBase = null;
  }
}

module.exports = {
  getDropshipBase,
  isListedDropshipVariant,
  productHasListedDropshipVariant,
  buildListedDropshipProductMatch,
  syncProductChannelStatusDropship,
  enableDropshipVariant,
  disableDropshipVariant
};
