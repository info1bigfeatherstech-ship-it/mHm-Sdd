const { getDropshipBase, isListedDropshipVariant } = require('./dropshipCatalog');

/**
 * Serialize catalog payloads for the dropshipper panel.
 * Never leak wholesaleBase / wholesaleSale as payable prices.
 */

function pickImageUrls(images) {
  if (!Array.isArray(images)) return [];
  return images
    .map((img) => {
      if (!img) return null;
      if (typeof img === 'string') return img;
      return img.url || img.secure_url || null;
    })
    .filter(Boolean);
}

function serializeDropshipVariant(variant, product = null) {
  if (!variant) return null;
  const dropshipBase = getDropshipBase(variant);
  const listed = isListedDropshipVariant(variant);
  const qty = Number(variant.inventory?.quantity);
  const track = variant.inventory?.trackInventory !== false;

  return {
    _id: variant._id,
    productCode: variant.productCode || null,
    sku: variant.sku || null,
    attributes: variant.attributes || [],
    title: variant.title || product?.title || product?.name || null,
    description: variant.description || null,
    images: pickImageUrls(variant.images),
    dropship: variant.dropship === true,
    listed,
    dropshipPrice: listed && dropshipBase != null ? dropshipBase : null,
    dropshipBase: listed && dropshipBase != null ? dropshipBase : null,
    /** Payable unit price for dropship checkout */
    price: listed && dropshipBase != null ? dropshipBase : null,
    inventory: {
      quantity: Number.isFinite(qty) ? qty : 0,
      trackInventory: track,
      inStock: track ? qty > 0 : true
    },
    isActive: variant.isActive !== false,
    shipping: variant.shipping || null
  };
}

function serializeDropshipProduct(product, { listedOnly = true } = {}) {
  if (!product) return null;
  const allVariants = Array.isArray(product.variants) ? product.variants : [];
  const variants = (listedOnly ? allVariants.filter(isListedDropshipVariant) : allVariants).map((v) =>
    serializeDropshipVariant(v, product)
  );

  const prices = variants.map((v) => v?.dropshipPrice).filter((p) => p != null && p > 0);
  const category =
    product.category && typeof product.category === 'object'
      ? {
          _id: product.category._id,
          name: product.category.name || product.category.title || null,
          slug: product.category.slug || null
        }
      : product.category || null;

  return {
    _id: product._id,
    slug: product.slug,
    name: product.name || product.title || null,
    title: product.title || product.name || null,
    description: product.description || null,
    images: pickImageUrls(product.images),
    category,
    hsnCode: product.hsnCode || null,
    gstRate: product.gstRate ?? null,
    isFragile: product.isFragile === true,
    channelStatus: {
      dropship: product.channelStatus?.dropship || null
    },
    variants,
    minDropshipPrice: prices.length ? Math.min(...prices) : null,
    maxDropshipPrice: prices.length ? Math.max(...prices) : null,
    inStock: variants.some((v) => v?.inventory?.inStock),
    createdAt: product.createdAt,
    updatedAt: product.updatedAt
  };
}

function serializeAdminDropshipVariant(variant) {
  if (!variant) return null;
  const dropshipBase = getDropshipBase(variant);
  return {
    _id: variant._id,
    productCode: variant.productCode || null,
    sku: variant.sku || null,
    attributes: variant.attributes || [],
    title: variant.title || null,
    dropship: variant.dropship === true,
    dropshipBase,
    channelVisibility: {
      dropship: variant.channelVisibility?.dropship || null
    },
    listed: isListedDropshipVariant(variant),
    inventory: {
      quantity: Number(variant.inventory?.quantity) || 0,
      trackInventory: variant.inventory?.trackInventory !== false
    },
    isActive: variant.isActive !== false,
    /** Ecomm reference only — not payable on dropship */
    ecommBase: variant.price?.base ?? null,
    ecommSale: variant.price?.sale ?? null
  };
}

function serializeAdminDropshipProduct(product) {
  if (!product) return null;
  const variants = (Array.isArray(product.variants) ? product.variants : []).map(serializeAdminDropshipVariant);
  return {
    _id: product._id,
    slug: product.slug,
    name: product.name || product.title || null,
    title: product.title || product.name || null,
    category:
      product.category && typeof product.category === 'object'
        ? {
            _id: product.category._id,
            name: product.category.name || null,
            slug: product.category.slug || null
          }
        : product.category || null,
    status: product.status,
    channelStatus: {
      dropship: product.channelStatus?.dropship || null
    },
    images: pickImageUrls(product.images),
    variants,
    listedVariantCount: variants.filter((v) => v.listed).length,
    updatedAt: product.updatedAt
  };
}

module.exports = {
  serializeDropshipVariant,
  serializeDropshipProduct,
  serializeAdminDropshipVariant,
  serializeAdminDropshipProduct,
  pickImageUrls
};
