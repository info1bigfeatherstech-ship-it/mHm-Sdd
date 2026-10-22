const ProductLabel = require('../models/ProductLabel');
const {
  normalizeSlug,
  normalizePagePath,
  normalizeStorefronts,
  assertValidSlug,
  assertValidName,
  invalidateProductCaches,
  findLabelByIdOrSlug,
  migrateProductTagSlug,
  removeSlugFromAllProducts,
  attachProductCounts,
} = require('../services/productLabel.service');
const logger = require('../utils/logger');

const HOMEPAGE_LIMIT_DEFAULT = 10;
const HOMEPAGE_LIMIT_MIN = 1;
const HOMEPAGE_LIMIT_MAX = 48;
const HOMEPAGE_SORT_DEFAULT = 100;

function normalizeHomepageLimit(value, fallback = HOMEPAGE_LIMIT_DEFAULT) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(HOMEPAGE_LIMIT_MAX, Math.max(HOMEPAGE_LIMIT_MIN, Math.round(n)));
}

function normalizeHomepageSortOrder(value, fallback = HOMEPAGE_SORT_DEFAULT) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n);
}

function sendError(res, err, fallbackMessage) {
  const code = err?.code;
  const statusByCode = {
    INVALID_SLUG: 400,
    INVALID_NAME: 400,
    INVALID_PAGE_PATH: 400,
    INVALID_FLAG_TYPE: 400,
    DUPLICATE_SLUG: 409,
    LABEL_NOT_FOUND: 404,
  };
  const status = statusByCode[code] || (err?.name === 'ValidationError' ? 400 : 500);
  if (status >= 500) {
    logger.error('[productLabel]', { message: err?.message, stack: err?.stack });
  }
  return res.status(status).json({
    success: false,
    code: code || (status >= 500 ? 'SERVER_ERROR' : 'BAD_REQUEST'),
    message: status >= 500 ? fallbackMessage : err.message || fallbackMessage,
  });
}

/** Admin: list all labels (optional ?activeOnly=true, includes productCount). */
async function listLabelsAdmin(req, res) {
  try {
    const activeOnly = String(req.query.activeOnly || '').toLowerCase() === 'true';
    const filter = activeOnly ? { isActive: true } : {};
    const labels = await ProductLabel.find(filter)
      .sort({ sortOrder: 1, name: 1 })
      .lean();
    const withCounts = await attachProductCounts(labels);
    return res.status(200).json({
      success: true,
      count: withCounts.length,
      labels: withCounts,
    });
  } catch (err) {
    return sendError(res, err, 'Failed to list product labels');
  }
}

/** Admin: get one by id or slug. */
async function getLabelAdmin(req, res) {
  try {
    const label = await findLabelByIdOrSlug(req.params.idOrSlug);
    if (!label) {
      const err = new Error('Label not found');
      err.code = 'LABEL_NOT_FOUND';
      throw err;
    }
    const lean = label.toObject ? label.toObject() : label;
    const [withCount] = await attachProductCounts([lean]);
    return res.status(200).json({ success: true, label: withCount });
  } catch (err) {
    return sendError(res, err, 'Failed to fetch product label');
  }
}

/** Admin: create label. */
async function createLabel(req, res) {
  try {
    const name = assertValidName(req.body?.name);
    const slugInput = req.body?.slug ? String(req.body.slug).trim() : name;
    const slug = normalizeSlug(slugInput);
    assertValidSlug(slug);

    const existing = await ProductLabel.findOne({ slug }).select('_id').lean();
    if (existing) {
      const err = new Error(`Label slug "${slug}" already exists`);
      err.code = 'DUPLICATE_SLUG';
      throw err;
    }

    const pagePath = normalizePagePath(req.body?.pagePath, slug);
    const storefronts = normalizeStorefronts(req.body?.storefronts);
    const sortOrder =
      req.body?.sortOrder != null && Number.isFinite(Number(req.body.sortOrder))
        ? Number(req.body.sortOrder)
        : 100;
    const isActive = req.body?.isActive === false ? false : true;
    const showInNav = req.body?.showInNav === false ? false : true;
    // Homepage opt-in must be explicit (default false) so existing labels stay off homepage.
    const showOnHomepage = req.body?.showOnHomepage === true;
    const homepageSortOrder = normalizeHomepageSortOrder(
      req.body?.homepageSortOrder,
      HOMEPAGE_SORT_DEFAULT
    );
    const homepageLimit = normalizeHomepageLimit(req.body?.homepageLimit, HOMEPAGE_LIMIT_DEFAULT);
    const description = String(req.body?.description || '').trim().slice(0, 300);

    const label = await ProductLabel.create({
      name,
      slug,
      pagePath,
      description,
      isActive,
      showInNav,
      showOnHomepage,
      homepageSortOrder,
      homepageLimit,
      sortOrder,
      storefronts,
      isSystem: false,
    });

    return res.status(201).json({
      success: true,
      message: 'Label created successfully',
      label,
    });
  } catch (err) {
    if (err?.code === 11000) {
      err.code = 'DUPLICATE_SLUG';
      err.message = 'Label slug already exists';
    }
    return sendError(res, err, 'Failed to create product label');
  }
}

/** Admin: update name / slug / pagePath / flags. */
async function updateLabel(req, res) {
  try {
    const label = await findLabelByIdOrSlug(req.params.idOrSlug);
    if (!label) {
      const err = new Error('Label not found');
      err.code = 'LABEL_NOT_FOUND';
      throw err;
    }

    const oldSlug = label.slug;
    let slugChanged = false;

    if (req.body?.name != null) {
      label.name = assertValidName(req.body.name);
    }

    if (req.body?.slug != null && String(req.body.slug).trim()) {
      const nextSlug = normalizeSlug(req.body.slug);
      assertValidSlug(nextSlug);
      if (nextSlug !== oldSlug) {
        const clash = await ProductLabel.findOne({
          slug: nextSlug,
          _id: { $ne: label._id },
        })
          .select('_id')
          .lean();
        if (clash) {
          const err = new Error(`Label slug "${nextSlug}" already exists`);
          err.code = 'DUPLICATE_SLUG';
          throw err;
        }
        label.slug = nextSlug;
        slugChanged = true;
      }
    }

    if (req.body?.pagePath != null) {
      label.pagePath = normalizePagePath(req.body.pagePath, label.slug);
    } else if (slugChanged && (!req.body?.pagePath || !String(req.body.pagePath).trim())) {
      // If path still ends with old slug segment, rewrite it
      if (label.pagePath.endsWith(`/${oldSlug}`)) {
        label.pagePath = label.pagePath.replace(new RegExp(`/${oldSlug}$`), `/${label.slug}`);
      }
    }

    if (req.body?.description != null) {
      label.description = String(req.body.description || '').trim().slice(0, 300);
    }
    if (req.body?.isActive != null) {
      label.isActive = Boolean(req.body.isActive);
    }
    if (req.body?.showInNav != null) {
      label.showInNav = Boolean(req.body.showInNav);
    }
    if (req.body?.showOnHomepage != null) {
      label.showOnHomepage = Boolean(req.body.showOnHomepage);
    }
    if (req.body?.homepageSortOrder != null) {
      label.homepageSortOrder = normalizeHomepageSortOrder(
        req.body.homepageSortOrder,
        label.homepageSortOrder ?? HOMEPAGE_SORT_DEFAULT
      );
    }
    if (req.body?.homepageLimit != null) {
      label.homepageLimit = normalizeHomepageLimit(
        req.body.homepageLimit,
        label.homepageLimit ?? HOMEPAGE_LIMIT_DEFAULT
      );
    }
    if (req.body?.sortOrder != null && Number.isFinite(Number(req.body.sortOrder))) {
      label.sortOrder = Number(req.body.sortOrder);
    }
    if (req.body?.storefronts != null) {
      label.storefronts = normalizeStorefronts(req.body.storefronts);
    }

    await label.save();

    if (slugChanged) {
      await migrateProductTagSlug(oldSlug, label.slug);
      await invalidateProductCaches();
    }

    const lean = label.toObject();
    const [withCount] = await attachProductCounts([lean]);

    return res.status(200).json({
      success: true,
      message: 'Label updated successfully',
      label: withCount,
      slugMigrated: slugChanged,
    });
  } catch (err) {
    if (err?.code === 11000) {
      err.code = 'DUPLICATE_SLUG';
      err.message = 'Label slug already exists';
    }
    return sendError(res, err, 'Failed to update product label');
  }
}

/** Admin: delete label + remove from all products. */
async function deleteLabel(req, res) {
  try {
    const label = await findLabelByIdOrSlug(req.params.idOrSlug);
    if (!label) {
      const err = new Error('Label not found');
      err.code = 'LABEL_NOT_FOUND';
      throw err;
    }

    const slug = label.slug;
    const cleanup = await removeSlugFromAllProducts(slug);
    await ProductLabel.deleteOne({ _id: label._id });
    await invalidateProductCaches();

    return res.status(200).json({
      success: true,
      message: 'Label deleted successfully',
      deleted: { slug, name: label.name, isSystem: label.isSystem },
      cleanup,
    });
  } catch (err) {
    return sendError(res, err, 'Failed to delete product label');
  }
}

/**
 * Public: active labels for storefront nav / homepage sections.
 * Query:
 *   showInNavOnly=true (default when not homepage) | false
 *   showOnHomepageOnly=true — homepage sections (defaults showInNavOnly to false)
 */
async function listLabelsPublic(req, res) {
  try {
    const storefront = req.storefront === 'wholesale' ? 'wholesale' : 'ecomm';
    const showOnHomepageOnly =
      String(req.query.showOnHomepageOnly || '').toLowerCase() === 'true';
    // Homepage filter is independent of nav; default showInNavOnly=false when homepage-only.
    const showInNavDefault = showOnHomepageOnly ? 'false' : 'true';
    const showInNavOnly =
      String(req.query.showInNavOnly || showInNavDefault).toLowerCase() !== 'false';

    const filter = {
      isActive: true,
      storefronts: storefront,
    };
    if (showInNavOnly) {
      filter.showInNav = true;
    }
    if (showOnHomepageOnly) {
      filter.showOnHomepage = true;
    }

    const sort = showOnHomepageOnly
      ? { homepageSortOrder: 1, name: 1 }
      : { sortOrder: 1, name: 1 };

    const labels = await ProductLabel.find(filter)
      .select(
        'name slug pagePath description sortOrder storefronts showInNav showOnHomepage homepageSortOrder homepageLimit'
      )
      .sort(sort)
      .lean();

    return res.status(200).json({
      success: true,
      storefront,
      count: labels.length,
      labels,
    });
  } catch (err) {
    return sendError(res, err, 'Failed to list product labels');
  }
}

/** Public: single active label by slug (for page title / meta). */
async function getLabelPublic(req, res) {
  try {
    const storefront = req.storefront === 'wholesale' ? 'wholesale' : 'ecomm';
    const slug = normalizeSlug(req.params.slug);
    assertValidSlug(slug);

    const label = await ProductLabel.findOne({
      slug,
      isActive: true,
      storefronts: storefront,
    })
      .select(
        'name slug pagePath description sortOrder storefronts showInNav showOnHomepage homepageSortOrder homepageLimit'
      )
      .lean();

    if (!label) {
      const err = new Error('Label not found');
      err.code = 'LABEL_NOT_FOUND';
      throw err;
    }

    return res.status(200).json({ success: true, storefront, label });
  } catch (err) {
    return sendError(res, err, 'Failed to fetch product label');
  }
}

module.exports = {
  listLabelsAdmin,
  getLabelAdmin,
  createLabel,
  updateLabel,
  deleteLabel,
  listLabelsPublic,
  getLabelPublic,
};
