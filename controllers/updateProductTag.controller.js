const Product = require('../models/Product');
const ProductTag = require('../models/ProductTag');
const {
  assertAssignableLabelSlug,
  invalidateProductCaches,
} = require('../services/productLabel.service');
const logger = require('../utils/logger');

/**
 * Assign / remove a marketing label on one or more products (by slug).
 * Body: { slugs: string[], flagType|labelSlug: string, value: boolean }
 * Backward-compatible with existing admin "updateFlags" clients.
 */
async function updateProductTagController(req, res) {
  try {
    const { slugs } = req.body;
    const flagType = req.body.flagType || req.body.labelSlug;
    const rawValue = req.body.value;

    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({
        success: false,
        code: 'SLUGS_REQUIRED',
        message: 'Slugs are required',
      });
    }

    if (!flagType) {
      return res.status(400).json({
        success: false,
        code: 'FLAG_TYPE_REQUIRED',
        message: 'flagType (or labelSlug) is required',
      });
    }

    // Accept boolean or common string/number forms from older admin clients
    let value;
    if (typeof rawValue === 'boolean') {
      value = rawValue;
    } else if (rawValue === 1 || rawValue === '1' || String(rawValue).toLowerCase() === 'true') {
      value = true;
    } else if (rawValue === 0 || rawValue === '0' || String(rawValue).toLowerCase() === 'false') {
      value = false;
    } else {
      return res.status(400).json({
        success: false,
        code: 'VALUE_REQUIRED',
        message: 'value must be a boolean',
      });
    }

    // Adding requires an active label; removing allows inactive (cleanup) but still must exist
    // OR we allow remove of orphaned slugs for safety. Prefer: add → active label; remove → any known or kebab slug.
    let labelSlug;
    if (value === true) {
      const label = await assertAssignableLabelSlug(flagType, { requireActive: true });
      labelSlug = label.slug;
    } else {
      try {
        const label = await assertAssignableLabelSlug(flagType, { requireActive: false });
        labelSlug = label.slug;
      } catch (lookupErr) {
        // Allow removing a stale slug that no longer has a ProductLabel row
        const normalized = String(flagType || '')
          .trim()
          .toLowerCase()
          .replace(/_/g, '-');
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized)) {
          throw lookupErr;
        }
        labelSlug = normalized;
      }
    }

    const uniqueSlugs = [
      ...new Set(
        slugs
          .map((s) => String(s || '').trim())
          .filter(Boolean)
      ),
    ];

    const products = await Product.find({
      slug: { $in: uniqueSlugs },
    }).select('_id slug');

    if (!products.length) {
      return res.status(404).json({
        success: false,
        code: 'PRODUCTS_NOT_FOUND',
        message: 'No matching products found for the given slugs',
      });
    }

    const results = await Promise.all(
      products.map(async (product) => {
        const existing = await ProductTag.findOne({ product: product._id });
        let updatedTags = Array.isArray(existing?.tags) ? [...existing.tags] : [];

        if (value) {
          if (!updatedTags.includes(labelSlug)) {
            updatedTags.push(labelSlug);
          }
        } else {
          updatedTags = updatedTags.filter((tag) => tag !== labelSlug);
        }

        // Deduplicate
        updatedTags = Array.from(new Set(updatedTags));

        if (updatedTags.length === 0) {
          if (existing) {
            await ProductTag.deleteOne({ _id: existing._id });
            return { productId: product._id, tags: [] };
          }
          return { productId: product._id, tags: [] };
        }

        const updatedDoc = await ProductTag.findOneAndUpdate(
          { product: product._id },
          { $set: { tags: updatedTags } },
          { new: true, upsert: true, setDefaultsOnInsert: true }
        );

        return updatedDoc;
      })
    );

    await invalidateProductCaches();

    return res.status(200).json({
      success: true,
      message: value
        ? `Label "${labelSlug}" applied successfully`
        : `Label "${labelSlug}" removed successfully`,
      flagType: labelSlug,
      labelSlug,
      value,
      updatedCount: results.length,
      requestedCount: uniqueSlugs.length,
    });
  } catch (error) {
    if (error?.code === 'INVALID_FLAG_TYPE' || error?.code === 'INVALID_SLUG') {
      return res.status(400).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    }
    logger.error('[updateProductTag]', { message: error?.message, stack: error?.stack });
    return res.status(500).json({
      success: false,
      code: 'SERVER_ERROR',
      message: 'Server error',
    });
  }
}

module.exports = updateProductTagController;
