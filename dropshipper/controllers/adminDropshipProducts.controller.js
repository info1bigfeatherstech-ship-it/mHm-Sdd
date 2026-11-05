const Product = require('../../models/Product');
const {
  enableDropshipVariant,
  disableDropshipVariant,
  syncProductChannelStatusDropship,
  getDropshipBase
} = require('../utils/dropshipCatalog');
const { serializeAdminDropshipProduct } = require('../utils/dropshipperCatalogSerialize');
const { validateDropshipBase, parseBool } = require('../utils/dropshipperValidators');

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, ...extra });
}

function ok(res, payload = {}) {
  return res.status(200).json({ success: true, ...payload });
}

function findVariant(product, productCode) {
  const code = String(productCode || '')
    .trim()
    .toUpperCase();
  if (!code || !product?.variants) return null;
  return (
    product.variants.find((v) => String(v.productCode || '').trim().toUpperCase() === code) || null
  );
}

async function loadProductBySlug(slug) {
  return Product.findOne({ slug: String(slug || '').trim() });
}

/** GET /products */
exports.listProducts = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const listedOnly = parseBool(req.query.listedOnly, false);
    const q = String(req.query.q || req.query.search || '').trim();

    const filter = { status: { $ne: 'archived' } };
    if (listedOnly) {
      filter.variants = {
        $elemMatch: {
          dropship: true,
          'channelVisibility.dropship': 'active',
          'price.dropshipBase': { $gt: 0 }
        }
      };
    }
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { name: re },
        { title: re },
        { slug: re },
        { 'variants.sku': re },
        { 'variants.productCode': re }
      ];
    }

    const [total, rows] = await Promise.all([
      Product.countDocuments(filter),
      Product.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('category', 'name slug title')
        .lean()
    ]);

    const products = rows.map(serializeAdminDropshipProduct);
    return ok(res, {
      data: {
        products,
        items: products,
        total,
        page,
        limit
      }
    });
  } catch (error) {
    return fail(res, 500, 'ADMIN_DROPSHIP_PRODUCTS_FAILED', error.message || 'Failed to list products');
  }
};

/** GET /products/:slug */
exports.getProduct = async (req, res) => {
  try {
    const product = await Product.findOne({ slug: String(req.params.slug || '').trim() })
      .populate('category', 'name slug title')
      .lean();
    if (!product) {
      return fail(res, 404, 'PRODUCT_NOT_FOUND', 'Product not found');
    }
    const data = serializeAdminDropshipProduct(product);
    return ok(res, { product: data, data });
  } catch (error) {
    return fail(res, 500, 'ADMIN_DROPSHIP_PRODUCT_FAILED', error.message || 'Failed to load product');
  }
};

/** PATCH /products/:slug/variants/:productCode/price */
exports.setVariantPrice = async (req, res) => {
  try {
    const product = await loadProductBySlug(req.params.slug);
    if (!product) return fail(res, 404, 'PRODUCT_NOT_FOUND', 'Product not found');

    const variant = findVariant(product, req.params.productCode);
    if (!variant) return fail(res, 404, 'VARIANT_NOT_FOUND', 'Variant not found');

    const priceCheck = validateDropshipBase(req.body.dropshipBase);
    if (!priceCheck.ok) {
      return fail(res, 400, 'INVALID_DROPSHIP_BASE', priceCheck.message);
    }

    variant.price = variant.price || {};
    variant.price.dropshipBase = priceCheck.dropshipBase;

    const shouldEnable = req.body.enable === true || req.body.enable === 'true' || req.body.enable === 1;
    if (shouldEnable || getDropshipBase(variant) > 0) {
      if (shouldEnable) {
        enableDropshipVariant(variant, priceCheck.dropshipBase);
      }
    }

    syncProductChannelStatusDropship(product);
    product.markModified('variants');
    await product.save();

    return ok(res, {
      data: serializeAdminDropshipProduct(product.toObject({ virtuals: true })),
      variant: {
        productCode: variant.productCode,
        dropshipBase: getDropshipBase(variant),
        dropship: variant.dropship === true,
        listed: variant.dropship === true && String(variant.channelVisibility?.dropship) === 'active' && getDropshipBase(variant) > 0
      }
    });
  } catch (error) {
    return fail(res, 500, 'SET_PRICE_FAILED', error.message || 'Failed to set dropship price');
  }
};

/** PATCH /products/:slug/variants/:productCode/enable */
exports.enableVariant = async (req, res) => {
  try {
    const product = await loadProductBySlug(req.params.slug);
    if (!product) return fail(res, 404, 'PRODUCT_NOT_FOUND', 'Product not found');

    const variant = findVariant(product, req.params.productCode);
    if (!variant) return fail(res, 404, 'VARIANT_NOT_FOUND', 'Variant not found');

    let dropshipBase = getDropshipBase(variant);
    if (req.body.dropshipBase != null) {
      const priceCheck = validateDropshipBase(req.body.dropshipBase);
      if (!priceCheck.ok) {
        return fail(res, 400, 'INVALID_DROPSHIP_BASE', priceCheck.message);
      }
      dropshipBase = priceCheck.dropshipBase;
    }

    if (!(dropshipBase > 0)) {
      return fail(res, 400, 'DROPSHIP_BASE_REQUIRED', 'Set dropshipBase > 0 before enabling listing');
    }

    enableDropshipVariant(variant, dropshipBase);
    syncProductChannelStatusDropship(product);
    product.markModified('variants');
    await product.save();

    return ok(res, {
      data: serializeAdminDropshipProduct(product.toObject({ virtuals: true })),
      message: 'Variant enabled for dropship'
    });
  } catch (error) {
    return fail(res, 500, 'ENABLE_VARIANT_FAILED', error.message || 'Failed to enable variant');
  }
};

/** PATCH /products/:slug/variants/:productCode/disable */
exports.disableVariant = async (req, res) => {
  try {
    const product = await loadProductBySlug(req.params.slug);
    if (!product) return fail(res, 404, 'PRODUCT_NOT_FOUND', 'Product not found');

    const variant = findVariant(product, req.params.productCode);
    if (!variant) return fail(res, 404, 'VARIANT_NOT_FOUND', 'Variant not found');

    const clearPrice = parseBool(req.body.clearPrice, false);
    disableDropshipVariant(variant, { clearPrice });
    syncProductChannelStatusDropship(product);
    product.markModified('variants');
    await product.save();

    return ok(res, {
      data: serializeAdminDropshipProduct(product.toObject({ virtuals: true })),
      message: 'Variant disabled for dropship'
    });
  } catch (error) {
    return fail(res, 500, 'DISABLE_VARIANT_FAILED', error.message || 'Failed to disable variant');
  }
};

/** POST /products/bulk-enable */
exports.bulkEnable = async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) {
      return fail(res, 400, 'ITEMS_REQUIRED', 'items array is required');
    }

    const results = [];
    for (const item of items) {
      const productCode = String(item.productCode || '')
        .trim()
        .toUpperCase();
      let product = null;
      if (item.slug) {
        product = await loadProductBySlug(item.slug);
      }
      if (!product && productCode) {
        product = await Product.findOne({ 'variants.productCode': productCode });
      }
      if (!product) {
        results.push({ productCode, slug: item.slug || null, ok: false, code: 'PRODUCT_NOT_FOUND' });
        continue;
      }
      const variant = findVariant(product, productCode);
      if (!variant) {
        results.push({ productCode, slug: product.slug, ok: false, code: 'VARIANT_NOT_FOUND' });
        continue;
      }

      let base = getDropshipBase(variant);
      if (item.dropshipBase != null) {
        const priceCheck = validateDropshipBase(item.dropshipBase);
        if (!priceCheck.ok) {
          results.push({ productCode, slug: product.slug, ok: false, code: 'INVALID_DROPSHIP_BASE' });
          continue;
        }
        base = priceCheck.dropshipBase;
      }
      if (!(base > 0)) {
        results.push({ productCode, slug: product.slug, ok: false, code: 'DROPSHIP_BASE_REQUIRED' });
        continue;
      }

      enableDropshipVariant(variant, base);
      syncProductChannelStatusDropship(product);
      product.markModified('variants');
      // eslint-disable-next-line no-await-in-loop
      await product.save();
      results.push({ productCode, slug: product.slug, ok: true, dropshipBase: base });
    }

    return ok(res, { data: { results }, results });
  } catch (error) {
    return fail(res, 500, 'BULK_ENABLE_FAILED', error.message || 'Bulk enable failed');
  }
};

/** POST /products/bulk-set-price */
exports.bulkSetPrice = async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) {
      return fail(res, 400, 'ITEMS_REQUIRED', 'items array is required');
    }

    const results = [];
    for (const item of items) {
      const productCode = String(item.productCode || '')
        .trim()
        .toUpperCase();
      const priceCheck = validateDropshipBase(item.dropshipBase);
      if (!priceCheck.ok) {
        results.push({ productCode, ok: false, code: 'INVALID_DROPSHIP_BASE' });
        continue;
      }

      let product = null;
      if (item.slug) {
        product = await loadProductBySlug(item.slug);
      }
      if (!product && productCode) {
        product = await Product.findOne({ 'variants.productCode': productCode });
      }
      if (!product) {
        results.push({ productCode, ok: false, code: 'PRODUCT_NOT_FOUND' });
        continue;
      }
      const variant = findVariant(product, productCode);
      if (!variant) {
        results.push({ productCode, slug: product.slug, ok: false, code: 'VARIANT_NOT_FOUND' });
        continue;
      }

      variant.price = variant.price || {};
      variant.price.dropshipBase = priceCheck.dropshipBase;
      const shouldEnable = item.enable === true || item.enable === 'true' || item.enable === 1;
      if (shouldEnable) {
        enableDropshipVariant(variant, priceCheck.dropshipBase);
      }
      syncProductChannelStatusDropship(product);
      product.markModified('variants');
      // eslint-disable-next-line no-await-in-loop
      await product.save();
      results.push({
        productCode,
        slug: product.slug,
        ok: true,
        dropshipBase: priceCheck.dropshipBase,
        enabled: shouldEnable || undefined
      });
    }

    return ok(res, { data: { results }, results });
  } catch (error) {
    return fail(res, 500, 'BULK_SET_PRICE_FAILED', error.message || 'Bulk set price failed');
  }
};
