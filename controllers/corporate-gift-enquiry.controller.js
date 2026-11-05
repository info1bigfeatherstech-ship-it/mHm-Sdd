const mongoose = require('mongoose');
const CorporateGiftEnquiry = require('../models/CorporateGiftEnquiry');
const {
  OPEN_STATUSES
} = require('../models/CorporateGiftEnquiry');
const {
  validateGiftEnquiryBody,
  validateGiftEnquiryFilesForType,
  validateStatusUpdateBody
} = require('../utils/corporateGiftEnquiryValidation');
const {
  uploadGiftEnquiryFiles,
  rollbackAssets
} = require('../services/corporateGiftEnquiryUpload.service');
const { enqueueGiftEnquiryEmails } = require('../services/corporateGiftEnquiryEmail.service');
const logger = require('../utils/logger');

const DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Gift enquiries are ecomm|wholesale only (not dropship).
 * Unknown / dropship headers fall back to ecomm for public create;
 * admin routes should call assertGiftEnquiryAdminStorefront first.
 */
function resolveStorefront(req) {
  const fromScope = req.adminScope?.storefront;
  if (fromScope === 'wholesale' || fromScope === 'ecomm') return fromScope;
  return req.storefront === 'wholesale' ? 'wholesale' : 'ecomm';
}

function assertGiftEnquiryAdminStorefront(req, res) {
  const sf = req.adminScope?.storefront || req.storefront || 'ecomm';
  if (sf === 'dropship') {
    fail(
      res,
      400,
      'STOREFRONT_UNSUPPORTED',
      'Gift enquiries are not available on the dropship admin storefront. Use ecomm or wholesale.'
    );
    return null;
  }
  return resolveStorefront(req);
}

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, ...extra });
}

function publicCreateData(doc) {
  return {
    id: doc._id,
    enquiryType: doc.enquiryType,
    status: doc.status,
    createdAt: doc.createdAt
  };
}

function serializeAdminEnquiry(doc, { includeFiles = true } = {}) {
  const row = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  const base = {
    id: row._id,
    _id: row._id,
    enquiryType: row.enquiryType,
    name: row.name,
    email: row.email || null,
    phone: row.phone,
    organizationName: row.organizationName || null,
    city: row.city || null,
    occasion: row.occasion || null,
    giftCategory: row.giftCategory || null,
    quantity: row.quantity ?? null,
    targetDeliveryDate: row.targetDeliveryDate || null,
    message: row.message || null,
    businessType: row.businessType || null,
    volumeOrder: row.volumeOrder ?? null,
    storefront: row.storefront,
    source: row.source,
    status: row.status,
    adminNote: row.adminNote || null,
    convertedOrderId: row.convertedOrderId || null,
    userId: row.userId || null,
    contactedAt: row.contactedAt || null,
    quotedAt: row.quotedAt || null,
    closedAt: row.closedAt || null,
    convertedAt: row.convertedAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };

  if (includeFiles) {
    base.logos = row.logos || [];
    base.referencePhotos = row.referencePhotos || [];
    base.businessCard = row.businessCard || null;
  }

  return base;
}

/**
 * POST /api/gift-enquiries
 * multipart/form-data; storefront from x-storefront header (ecomm|wholesale).
 */
exports.createGiftEnquiry = async (req, res) => {
  let uploadedAssets = [];

  try {
    const validated = validateGiftEnquiryBody(req.body || {});
    if (!validated.ok) {
      return fail(res, 400, validated.code, validated.message, { errors: validated.errors });
    }

    const filesCheck = validateGiftEnquiryFilesForType(validated.data.enquiryType, req.files);
    if (!filesCheck.ok) {
      return fail(res, 400, filesCheck.code, filesCheck.message);
    }

    const storefront = resolveStorefront(req);
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);

    const existing = await CorporateGiftEnquiry.findOne({
      phone: validated.data.phone,
      enquiryType: validated.data.enquiryType,
      storefront,
      status: { $in: OPEN_STATUSES },
      createdAt: { $gte: since }
    })
      .select('_id enquiryType status createdAt')
      .lean();

    if (existing) {
      // Duplicate: do NOT upload/save new files
      return res.status(200).json({
        success: true,
        alreadyRegistered: true,
        message:
          'We already have your enquiry. Our team will get back to you shortly.',
        data: {
          id: existing._id,
          enquiryType: existing.enquiryType,
          status: existing.status,
          createdAt: existing.createdAt
        }
      });
    }

    const hasFiles =
      (Array.isArray(req.files?.logos) && req.files.logos.length) ||
      (Array.isArray(req.files?.referencePhotos) && req.files.referencePhotos.length) ||
      (Array.isArray(req.files?.businessCard) && req.files.businessCard.length);

    let media = { logos: [], referencePhotos: [], businessCard: null };
    if (hasFiles) {
      media = await uploadGiftEnquiryFiles(validated.data.enquiryType, req.files);
      uploadedAssets = media.uploaded || [];
    }

    const userId =
      req.userId && mongoose.Types.ObjectId.isValid(String(req.userId))
        ? req.userId
        : null;

    let doc;
    try {
      doc = await CorporateGiftEnquiry.create({
        ...validated.data,
        logos: media.logos,
        referencePhotos: media.referencePhotos,
        businessCard: media.businessCard,
        storefront,
        source: 'gift_page',
        status: 'pending',
        userId
      });
    } catch (dbErr) {
      await rollbackAssets(uploadedAssets);
      throw dbErr;
    }

    enqueueGiftEnquiryEmails(doc);

    return res.status(201).json({
      success: true,
      alreadyRegistered: false,
      message: 'Enquiry submitted successfully. Our team will contact you soon.',
      data: publicCreateData(doc)
    });
  } catch (error) {
    if (uploadedAssets.length) {
      await rollbackAssets(uploadedAssets).catch(() => {});
    }
    const status = error.statusCode || 500;
    const code = error.code || 'GIFT_ENQUIRY_CREATE_FAILED';
    if (status >= 500) {
      logger.error('[gift-enquiry] create failed', { message: error.message, code });
    }
    return fail(
      res,
      status,
      code,
      status >= 500 ? 'Could not submit enquiry' : error.message || 'Could not submit enquiry'
    );
  }
};

/**
 * GET /api/admin/gift-enquiries
 */
exports.listGiftEnquiries = async (req, res) => {
  try {
    const storefront = assertGiftEnquiryAdminStorefront(req, res);
    if (!storefront) return;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const enquiryType = String(req.query.enquiryType || '').trim().toLowerCase();
    const status = String(req.query.status || '').trim().toLowerCase();
    const search = String(req.query.search || req.query.q || '').trim();

    const filter = { storefront };

    if (enquiryType === 'bulk' || enquiryType === 'custom') {
      filter.enquiryType = enquiryType;
    }

    if (status && status !== 'all') {
      if (!['pending', 'contacted', 'quoted', 'closed', 'converted'].includes(status)) {
        return fail(res, 400, 'INVALID_STATUS', 'Invalid status filter');
      }
      filter.status = status;
    }

    if (search) {
      const safe = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(safe, 'i');
      filter.$or = [
        { name: re },
        { email: re },
        { phone: re },
        { organizationName: re },
        { city: re },
        { businessType: re },
        { occasion: re },
        { giftCategory: re }
      ];
    }

    const [rows, total] = await Promise.all([
      CorporateGiftEnquiry.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CorporateGiftEnquiry.countDocuments(filter)
    ]);

    // List: omit heavy file payloads for speed; include presence flags + first URL hints
    const data = rows.map((row) => {
      const item = serializeAdminEnquiry(row, { includeFiles: false });
      item.hasBusinessCard = Boolean(row.businessCard?.url);
      item.logoCount = Array.isArray(row.logos) ? row.logos.length : 0;
      item.referencePhotoCount = Array.isArray(row.referencePhotos)
        ? row.referencePhotos.length
        : 0;
      return item;
    });

    return res.json({
      success: true,
      data,
      items: data,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 0
      }
    });
  } catch (error) {
    logger.error('[gift-enquiry] list failed', { message: error.message });
    return fail(res, 500, 'GIFT_ENQUIRY_LIST_FAILED', 'Could not load gift enquiries');
  }
};

/**
 * GET /api/admin/gift-enquiries/:id
 */
exports.getGiftEnquiry = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, 400, 'INVALID_ID', 'Valid enquiry id is required');
    }

    const storefront = assertGiftEnquiryAdminStorefront(req, res);
    if (!storefront) return;

    const doc = await CorporateGiftEnquiry.findOne({ _id: id, storefront }).lean();
    if (!doc) {
      return fail(res, 404, 'NOT_FOUND', 'Enquiry not found');
    }

    const data = serializeAdminEnquiry(doc, { includeFiles: true });
    return res.json({ success: true, data, enquiry: data });
  } catch (error) {
    logger.error('[gift-enquiry] get failed', { message: error.message });
    return fail(res, 500, 'GIFT_ENQUIRY_GET_FAILED', 'Could not load enquiry');
  }
};

/**
 * PATCH /api/admin/gift-enquiries/:id/status
 * Body: { status, adminNote?, convertedOrderId? }
 */
exports.updateGiftEnquiryStatus = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return fail(res, 400, 'INVALID_ID', 'Valid enquiry id is required');
    }

    const validated = validateStatusUpdateBody(req.body || {});
    if (!validated.ok) {
      return fail(res, 400, validated.code, validated.message);
    }

    const storefront = assertGiftEnquiryAdminStorefront(req, res);
    if (!storefront) return;

    const doc = await CorporateGiftEnquiry.findOne({ _id: id, storefront });
    if (!doc) {
      return fail(res, 404, 'NOT_FOUND', 'Enquiry not found');
    }

    const { status, adminNote, convertedOrderId } = validated.data;
    doc.status = status;
    if (adminNote !== undefined) doc.adminNote = adminNote;
    if (convertedOrderId !== undefined) doc.convertedOrderId = convertedOrderId;

    const now = new Date();
    if (status === 'contacted') doc.contactedAt = doc.contactedAt || now;
    if (status === 'quoted') doc.quotedAt = doc.quotedAt || now;
    if (status === 'closed') doc.closedAt = now;
    if (status === 'converted') {
      doc.convertedAt = now;
      if (!doc.convertedOrderId && convertedOrderId) {
        doc.convertedOrderId = convertedOrderId;
      }
    }
    if (status === 'pending') {
      doc.contactedAt = null;
      doc.quotedAt = null;
      doc.closedAt = null;
      doc.convertedAt = null;
    }

    await doc.save();

    return res.json({
      success: true,
      message: 'Enquiry status updated',
      data: {
        id: doc._id,
        status: doc.status,
        adminNote: doc.adminNote,
        convertedOrderId: doc.convertedOrderId,
        contactedAt: doc.contactedAt,
        quotedAt: doc.quotedAt,
        closedAt: doc.closedAt,
        convertedAt: doc.convertedAt,
        updatedAt: doc.updatedAt
      }
    });
  } catch (error) {
    logger.error('[gift-enquiry] status update failed', { message: error.message });
    return fail(res, 500, 'GIFT_ENQUIRY_STATUS_FAILED', 'Could not update enquiry status');
  }
};
