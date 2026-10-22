const CatalogAttribute = require('../models/CatalogAttribute');
const {
  normalizeCode,
  assertValidCode,
  normalizeValues,
  ensureDefaultCatalogAttributes,
} = require('../services/catalogAttribute.service');
const logger = require('../utils/logger');

function sendError(res, err, fallback) {
  const map = {
    INVALID_ATTR_CODE: 400,
    INVALID_NAME: 400,
    DUPLICATE_CODE: 409,
    ATTR_NOT_FOUND: 404,
    INVALID_KIND: 400,
  };
  const status = map[err?.code] || (err?.name === 'ValidationError' ? 400 : 500);
  if (status >= 500) {
    logger.error('[catalogAttribute]', { message: err?.message, stack: err?.stack });
  }
  return res.status(status).json({
    success: false,
    code: err?.code || (status >= 500 ? 'SERVER_ERROR' : 'BAD_REQUEST'),
    message: status >= 500 ? fallback : err.message || fallback,
  });
}

function toClient(doc) {
  const o = doc.toObject ? doc.toObject() : doc;
  return {
    id: String(o._id),
    _id: o._id,
    name: o.name,
    code: o.code,
    kind: o.kind,
    inputType: o.inputType,
    values: Array.isArray(o.values) ? o.values : [],
    group: o.group || 'General',
    category: o.group || 'General', // alias for existing admin UI
    isActive: o.isActive !== false,
    sortOrder: o.sortOrder ?? 100,
    isSystem: Boolean(o.isSystem),
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

async function listAttributes(req, res) {
  try {
    await ensureDefaultCatalogAttributes();
    const kind = String(req.query.kind || '').trim().toLowerCase();
    const activeOnly = String(req.query.activeOnly || '').toLowerCase() === 'true';
    const filter = {};
    if (kind === 'variant' || kind === 'spec') filter.kind = kind;
    if (activeOnly) filter.isActive = true;

    const rows = await CatalogAttribute.find(filter).sort({ sortOrder: 1, name: 1 }).lean();
    return res.status(200).json({
      success: true,
      count: rows.length,
      attributes: rows.map(toClient),
    });
  } catch (err) {
    return sendError(res, err, 'Failed to list attributes');
  }
}

async function getAttribute(req, res) {
  try {
    const key = String(req.params.idOrCode || '').trim();
    let doc = null;
    if (/^[a-f0-9]{24}$/i.test(key)) {
      doc = await CatalogAttribute.findById(key);
    }
    if (!doc) {
      doc = await CatalogAttribute.findOne({ code: normalizeCode(key) });
    }
    if (!doc) {
      const err = new Error('Attribute not found');
      err.code = 'ATTR_NOT_FOUND';
      throw err;
    }
    return res.status(200).json({ success: true, attribute: toClient(doc) });
  } catch (err) {
    return sendError(res, err, 'Failed to fetch attribute');
  }
}

async function createAttribute(req, res) {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      const err = new Error('Attribute name is required');
      err.code = 'INVALID_NAME';
      throw err;
    }
    const kind = String(req.body?.kind || 'spec').toLowerCase();
    if (kind !== 'variant' && kind !== 'spec') {
      const err = new Error('kind must be "variant" or "spec"');
      err.code = 'INVALID_KIND';
      throw err;
    }
    const code = normalizeCode(req.body?.code, name);
    assertValidCode(code);

    const clash = await CatalogAttribute.findOne({ code }).select('_id').lean();
    if (clash) {
      const err = new Error(`Attribute code "${code}" already exists`);
      err.code = 'DUPLICATE_CODE';
      throw err;
    }

    let values = normalizeValues(req.body?.values);
    if ((!values.length || values.length === 0) && typeof req.body?.valuesRaw === 'string') {
      values = normalizeValues(
        String(req.body.valuesRaw)
          .split(',')
          .map((s) => s.trim())
      );
    }

    const inputType = ['select', 'text', 'number'].includes(String(req.body?.inputType || '').toLowerCase())
      ? String(req.body.inputType).toLowerCase()
      : 'select';

    const doc = await CatalogAttribute.create({
      name,
      code,
      kind,
      inputType,
      values,
      group: String(req.body?.group || req.body?.category || 'General').trim().slice(0, 60) || 'General',
      isActive: req.body?.isActive === false ? false : true,
      sortOrder: Number.isFinite(Number(req.body?.sortOrder)) ? Number(req.body.sortOrder) : 100,
      isSystem: false,
    });

    return res.status(201).json({
      success: true,
      message: 'Attribute created',
      attribute: toClient(doc),
    });
  } catch (err) {
    if (err?.code === 11000) {
      err.code = 'DUPLICATE_CODE';
      err.message = 'Attribute code already exists';
    }
    return sendError(res, err, 'Failed to create attribute');
  }
}

async function updateAttribute(req, res) {
  try {
    const key = String(req.params.idOrCode || '').trim();
    let doc = null;
    if (/^[a-f0-9]{24}$/i.test(key)) doc = await CatalogAttribute.findById(key);
    if (!doc) doc = await CatalogAttribute.findOne({ code: normalizeCode(key) });
    if (!doc) {
      const err = new Error('Attribute not found');
      err.code = 'ATTR_NOT_FOUND';
      throw err;
    }

    if (req.body?.name != null) {
      const name = String(req.body.name).trim();
      if (!name) {
        const err = new Error('Attribute name is required');
        err.code = 'INVALID_NAME';
        throw err;
      }
      doc.name = name;
    }

    if (req.body?.kind != null) {
      const kind = String(req.body.kind).toLowerCase();
      if (kind !== 'variant' && kind !== 'spec') {
        const err = new Error('kind must be "variant" or "spec"');
        err.code = 'INVALID_KIND';
        throw err;
      }
      doc.kind = kind;
    }

    if (req.body?.code != null && String(req.body.code).trim()) {
      const nextCode = normalizeCode(req.body.code, doc.name);
      assertValidCode(nextCode);
      if (nextCode !== doc.code) {
        const clash = await CatalogAttribute.findOne({
          code: nextCode,
          _id: { $ne: doc._id },
        })
          .select('_id')
          .lean();
        if (clash) {
          const err = new Error(`Attribute code "${nextCode}" already exists`);
          err.code = 'DUPLICATE_CODE';
          throw err;
        }
        doc.code = nextCode;
      }
    }

    if (req.body?.values != null) {
      doc.values = normalizeValues(req.body.values);
    }
    if (req.body?.inputType != null) {
      const t = String(req.body.inputType).toLowerCase();
      if (['select', 'text', 'number'].includes(t)) doc.inputType = t;
    }
    if (req.body?.group != null || req.body?.category != null) {
      doc.group = String(req.body.group || req.body.category || 'General')
        .trim()
        .slice(0, 60) || 'General';
    }
    if (req.body?.isActive != null) doc.isActive = Boolean(req.body.isActive);
    if (req.body?.sortOrder != null && Number.isFinite(Number(req.body.sortOrder))) {
      doc.sortOrder = Number(req.body.sortOrder);
    }

    await doc.save();
    return res.status(200).json({
      success: true,
      message: 'Attribute updated',
      attribute: toClient(doc),
    });
  } catch (err) {
    if (err?.code === 11000) {
      err.code = 'DUPLICATE_CODE';
      err.message = 'Attribute code already exists';
    }
    return sendError(res, err, 'Failed to update attribute');
  }
}

async function addAttributeValue(req, res) {
  try {
    const key = String(req.params.idOrCode || '').trim();
    let doc = null;
    if (/^[a-f0-9]{24}$/i.test(key)) doc = await CatalogAttribute.findById(key);
    if (!doc) doc = await CatalogAttribute.findOne({ code: normalizeCode(key) });
    if (!doc) {
      const err = new Error('Attribute not found');
      err.code = 'ATTR_NOT_FOUND';
      throw err;
    }
    const value = String(req.body?.value || '').trim();
    if (!value) {
      return res.status(400).json({ success: false, code: 'VALUE_REQUIRED', message: 'value is required' });
    }
    doc.values = normalizeValues([...(doc.values || []), value]);
    await doc.save();
    return res.status(200).json({ success: true, attribute: toClient(doc) });
  } catch (err) {
    return sendError(res, err, 'Failed to add attribute value');
  }
}

async function removeAttributeValue(req, res) {
  try {
    const key = String(req.params.idOrCode || '').trim();
    let doc = null;
    if (/^[a-f0-9]{24}$/i.test(key)) doc = await CatalogAttribute.findById(key);
    if (!doc) doc = await CatalogAttribute.findOne({ code: normalizeCode(key) });
    if (!doc) {
      const err = new Error('Attribute not found');
      err.code = 'ATTR_NOT_FOUND';
      throw err;
    }
    const value = String(req.body?.value || req.query?.value || '').trim().toLowerCase();
    if (!value) {
      return res.status(400).json({ success: false, code: 'VALUE_REQUIRED', message: 'value is required' });
    }
    doc.values = (doc.values || []).filter((v) => String(v).trim().toLowerCase() !== value);
    await doc.save();
    return res.status(200).json({ success: true, attribute: toClient(doc) });
  } catch (err) {
    return sendError(res, err, 'Failed to remove attribute value');
  }
}

async function deleteAttribute(req, res) {
  try {
    const key = String(req.params.idOrCode || '').trim();
    let doc = null;
    if (/^[a-f0-9]{24}$/i.test(key)) doc = await CatalogAttribute.findById(key);
    if (!doc) doc = await CatalogAttribute.findOne({ code: normalizeCode(key) });
    if (!doc) {
      const err = new Error('Attribute not found');
      err.code = 'ATTR_NOT_FOUND';
      throw err;
    }
    await CatalogAttribute.deleteOne({ _id: doc._id });
    return res.status(200).json({
      success: true,
      message: 'Attribute deleted',
      deleted: { code: doc.code, name: doc.name, isSystem: doc.isSystem },
    });
  } catch (err) {
    return sendError(res, err, 'Failed to delete attribute');
  }
}

module.exports = {
  listAttributes,
  getAttribute,
  createAttribute,
  updateAttribute,
  addAttributeValue,
  removeAttributeValue,
  deleteAttribute,
};
