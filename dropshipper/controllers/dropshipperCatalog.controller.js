const Product = require('../../models/Product');
const { buildListedDropshipProductMatch, isListedDropshipVariant, getDropshipBase } = require('../utils/dropshipCatalog');
const {
  serializeDropshipProduct,
  serializeDropshipVariant,
  pickImageUrls
} = require('../utils/dropshipperCatalogSerialize');

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, ...extra });
}

function ok(res, payload = {}) {
  return res.status(200).json({ success: true, ...payload });
}

function parseSort(sort) {
  const s = String(sort || '').trim().toLowerCase();
  if (s === 'price_asc' || s === 'price-asc') return { 'variants.price.dropshipBase': 1 };
  if (s === 'price_desc' || s === 'price-desc') return { 'variants.price.dropshipBase': -1 };
  if (s === 'name' || s === 'name_asc') return { name: 1 };
  if (s === 'newest' || s === 'created_desc') return { createdAt: -1 };
  return { updatedAt: -1 };
}

/** GET /catalog/products */
exports.listCatalogProducts = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const match = buildListedDropshipProductMatch({
      q: req.query.q || req.query.search,
      categoryId: req.query.categoryId,
      inStockOnly: req.query.inStockOnly
    });

    const [total, rows] = await Promise.all([
      Product.countDocuments(match),
      Product.find(match)
        .sort(parseSort(req.query.sort))
        .skip(skip)
        .limit(limit)
        .populate('category', 'name slug title')
        .lean({ virtuals: true })
    ]);

    const products = rows.map((p) => serializeDropshipProduct(p, { listedOnly: true }));

    return ok(res, {
      data: {
        products,
        items: products,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 1
      }
    });
  } catch (error) {
    return fail(res, 500, 'CATALOG_LIST_FAILED', error.message || 'Failed to list catalog');
  }
};

/** GET /catalog/products/:slug */
exports.getCatalogProduct = async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim();
    if (!slug) return fail(res, 400, 'SLUG_REQUIRED', 'slug is required');

    const product = await Product.findOne({ slug })
      .populate('category', 'name slug title')
      .lean({ virtuals: true });

    if (!product) {
      return fail(res, 404, 'PRODUCT_NOT_FOUND', 'Product not found');
    }

    const serialized = serializeDropshipProduct(product, { listedOnly: true });
    if (!serialized.variants.length) {
      return fail(res, 404, 'PRODUCT_NOT_LISTED', 'Product is not listed for dropship');
    }

    return ok(res, { product: serialized, data: serialized });
  } catch (error) {
    return fail(res, 500, 'CATALOG_PRODUCT_FAILED', error.message || 'Failed to load product');
  }
};

/** GET /catalog/variants/:productCode */
exports.getCatalogVariant = async (req, res) => {
  try {
    const productCode = String(req.params.productCode || '')
      .trim()
      .toUpperCase();
    if (!productCode) return fail(res, 400, 'PRODUCT_CODE_REQUIRED', 'productCode is required');

    const product = await Product.findOne({ 'variants.productCode': productCode })
      .populate('category', 'name slug title')
      .lean({ virtuals: true });

    if (!product) {
      return fail(res, 404, 'VARIANT_NOT_FOUND', 'Variant not found');
    }

    const variant = (product.variants || []).find(
      (v) => String(v.productCode || '').trim().toUpperCase() === productCode
    );
    if (!variant || !isListedDropshipVariant(variant)) {
      return fail(res, 404, 'VARIANT_NOT_LISTED', 'Variant is not listed for dropship');
    }

    const serialized = serializeDropshipVariant(variant, product);
    return ok(res, {
      variant: serialized,
      product: {
        _id: product._id,
        slug: product.slug,
        name: product.name || product.title,
        title: product.title || product.name
      },
      data: serialized
    });
  } catch (error) {
    return fail(res, 500, 'CATALOG_VARIANT_FAILED', error.message || 'Failed to load variant');
  }
};

/**
 * GET /catalog/variants/:productCode/download-pack
 * Returns JSON pack with image URLs + meta (zip optional / deferred).
 */
exports.downloadVariantPack = async (req, res) => {
  try {
    const productCode = String(req.params.productCode || '')
      .trim()
      .toUpperCase();
    if (!productCode) return fail(res, 400, 'PRODUCT_CODE_REQUIRED', 'productCode is required');

    const product = await Product.findOne({ 'variants.productCode': productCode }).lean();
    if (!product) {
      return fail(res, 404, 'VARIANT_NOT_FOUND', 'Variant not found');
    }

    const variant = (product.variants || []).find(
      (v) => String(v.productCode || '').trim().toUpperCase() === productCode
    );
    if (!variant || !isListedDropshipVariant(variant)) {
      return fail(res, 404, 'VARIANT_NOT_LISTED', 'Variant is not listed for dropship');
    }

    const images = [
      ...pickImageUrls(variant.images),
      ...pickImageUrls(product.images)
    ].filter((url, idx, arr) => arr.indexOf(url) === idx);

    const pack = {
      format: 'json',
      productCode,
      slug: product.slug,
      title: variant.title || product.title || product.name,
      description: variant.description || product.description || null,
      dropshipPrice: getDropshipBase(variant),
      attributes: variant.attributes || [],
      images,
      meta: {
        hsnCode: product.hsnCode || null,
        gstRate: product.gstRate ?? null,
        sku: variant.sku || null,
        generatedAt: new Date().toISOString()
      }
    };

    return ok(res, { pack, data: pack });
  } catch (error) {
    return fail(res, 500, 'DOWNLOAD_PACK_FAILED', error.message || 'Failed to build download pack');
  }
};
