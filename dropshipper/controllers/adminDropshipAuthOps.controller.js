const Dropshipper = require('../models/Dropshipper');
const DropshipperRegistrationRequest = require('../models/DropshipperRegistrationRequest');
const { getSettings, updateSettings } = require('../services/dropshipperSettings.service');

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, ...extra });
}

function ok(res, payload = {}) {
  return res.status(200).json({ success: true, ...payload });
}

function serializeRequest(doc) {
  if (!doc) return null;
  const row = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    _id: row._id,
    id: String(row._id),
    kind: row.kind,
    adminStatus: row.adminStatus,
    paymentStatus: row.paymentStatus === 'created' ? 'pending' : row.paymentStatus,
    fullName: row.fullName,
    email: row.email,
    phone: row.phone,
    businessName: row.businessName || null,
    whatsappNumber: row.whatsappNumber || null,
    permanentAddress: row.permanentAddress,
    haveShop: Boolean(row.haveShop),
    businessAddress: row.businessAddress || null,
    deliveryAddress: row.deliveryAddress || null,
    sellingPlaceFrom: row.sellingPlaceFrom || null,
    sellingZoneCity: row.sellingZoneCity || null,
    productCategory: row.productCategory || null,
    monthlyEstimatedPurchase: row.monthlyEstimatedPurchase ?? null,
    idProofUrl: row.idProofUrl || null,
    businessAddressProofUrl: row.businessAddressProofUrl || null,
    subscriptionAmountInr: row.subscriptionAmountInr,
    subscriptionYears: row.subscriptionYears || 1,
    adminNote: row.adminNote || null,
    dropshipperId: row.dropshipperId || null,
    paidAt: row.paidAt || null,
    approvedAt: row.approvedAt || null,
    rejectedAt: row.rejectedAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/** GET /settings */
exports.getSettings = async (req, res) => {
  try {
    const settings = await getSettings();
    return ok(res, { settings: settings.toPublicSettings() });
  } catch (error) {
    return fail(res, 500, 'SETTINGS_FETCH_FAILED', error.message || 'Failed to load settings');
  }
};

/** PATCH /settings */
exports.patchSettings = async (req, res) => {
  try {
    const settings = await updateSettings({
      subscriptionAmountInr: req.body.subscriptionAmountInr,
      registrationOpen: req.body.registrationOpen
    });
    return ok(res, { settings: settings.toPublicSettings() });
  } catch (error) {
    return fail(
      res,
      error.statusCode || 500,
      error.code || 'SETTINGS_UPDATE_FAILED',
      error.message || 'Failed to update settings'
    );
  }
};

/** GET /requests */
exports.listRequests = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const adminStatus = String(req.query.adminStatus || '').trim().toLowerCase();
    const kind = String(req.query.kind || '').trim().toLowerCase();
    const search = String(req.query.search || req.query.q || '').trim();

    const filter = {};
    if (['pending', 'approved', 'rejected'].includes(adminStatus)) {
      filter.adminStatus = adminStatus;
    }
    if (['registration', 'renewal'].includes(kind)) {
      filter.kind = kind;
    }
    if (search) {
      const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ fullName: re }, { email: re }, { phone: re }, { businessName: re }];
    }

    const [total, rows] = await Promise.all([
      DropshipperRegistrationRequest.countDocuments(filter),
      DropshipperRegistrationRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()
    ]);

    const requests = rows.map(serializeRequest);
    return ok(res, {
      data: {
        requests,
        items: requests,
        total,
        page,
        limit
      }
    });
  } catch (error) {
    return fail(res, 500, 'REQUESTS_LIST_FAILED', error.message || 'Failed to list requests');
  }
};

/** POST /requests/:id/approve */
exports.approveRequest = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const note = String(req.body.note || '').trim() || null;

    const doc = await DropshipperRegistrationRequest.findById(id);
    if (!doc) {
      return fail(res, 404, 'REQUEST_NOT_FOUND', 'Request not found');
    }
    if (doc.kind === 'renewal') {
      return fail(res, 409, 'RENEWAL_AUTO_APPROVED', 'Renewals are auto-approved on payment verify');
    }
    if (doc.paymentStatus !== 'paid') {
      return fail(res, 409, 'PAYMENT_REQUIRED', 'Cannot approve until registration payment is paid');
    }
    if (doc.adminStatus === 'approved' && doc.dropshipperId) {
      const existing = await Dropshipper.findById(doc.dropshipperId);
      return ok(res, {
        message: 'Request already approved',
        data: serializeRequest(doc),
        dropshipper: existing ? existing.toSafeJSON() : null
      });
    }
    if (doc.adminStatus === 'rejected') {
      return fail(res, 409, 'ALREADY_REJECTED', 'Request was already rejected');
    }

    let dropshipper = await Dropshipper.findOne({
      $or: [{ email: doc.email }, { phone: doc.phone }]
    });

    if (dropshipper && ['active', 'pending_otp', 'expired', 'suspended'].includes(dropshipper.status)) {
      return fail(res, 409, 'ACCOUNT_EXISTS', 'A dropshipper account already exists for this email/phone');
    }

    if (!dropshipper) {
      dropshipper = new Dropshipper({
        fullName: doc.fullName,
        email: doc.email,
        phone: doc.phone,
        businessName: doc.businessName,
        whatsappNumber: doc.whatsappNumber,
        status: 'pending_otp',
        channel: 'dropship',
        subscription: {
          amountPaidInr: doc.subscriptionAmountInr,
          planYears: 1,
          startsAt: null,
          endsAt: null
        },
        application: {
          permanentAddress: doc.permanentAddress,
          haveShop: doc.haveShop,
          businessAddress: doc.businessAddress,
          deliveryAddress: doc.deliveryAddress,
          sellingPlaceFrom: doc.sellingPlaceFrom,
          sellingZoneCity: doc.sellingZoneCity,
          productCategory: doc.productCategory,
          monthlyEstimatedPurchase: doc.monthlyEstimatedPurchase,
          idProofUrl: doc.idProofUrl,
          businessAddressProofUrl: doc.businessAddressProofUrl
        },
        registrationRequestId: doc._id
      });
    } else {
      dropshipper.fullName = doc.fullName;
      dropshipper.businessName = doc.businessName;
      dropshipper.whatsappNumber = doc.whatsappNumber;
      dropshipper.status = 'pending_otp';
      dropshipper.subscription = {
        amountPaidInr: doc.subscriptionAmountInr,
        planYears: 1,
        startsAt: null,
        endsAt: null
      };
      dropshipper.application = {
        permanentAddress: doc.permanentAddress,
        haveShop: doc.haveShop,
        businessAddress: doc.businessAddress,
        deliveryAddress: doc.deliveryAddress,
        sellingPlaceFrom: doc.sellingPlaceFrom,
        sellingZoneCity: doc.sellingZoneCity,
        productCategory: doc.productCategory,
        monthlyEstimatedPurchase: doc.monthlyEstimatedPurchase,
        idProofUrl: doc.idProofUrl,
        businessAddressProofUrl: doc.businessAddressProofUrl
      };
      dropshipper.registrationRequestId = doc._id;
      dropshipper.rejectionNote = null;
      dropshipper.rejectedAt = null;
    }

    dropshipper.approvedAt = new Date();
    await dropshipper.save();

    doc.adminStatus = 'approved';
    doc.adminNote = note;
    doc.reviewedBy = req.userId || req.user?.id || null;
    doc.reviewedAt = new Date();
    doc.approvedAt = new Date();
    doc.dropshipperId = dropshipper._id;
    await doc.save();

    return ok(res, {
      message: 'Request approved — dropshipper can activate via OTP',
      data: serializeRequest(doc),
      dropshipper: dropshipper.toSafeJSON()
    });
  } catch (error) {
    return fail(res, 500, 'REQUEST_APPROVE_FAILED', error.message || 'Failed to approve request');
  }
};

/** POST /requests/:id/reject */
exports.rejectRequest = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const note = String(req.body.note || '').trim();
    if (!note) {
      return fail(res, 400, 'NOTE_REQUIRED', 'Rejection note is required');
    }

    const doc = await DropshipperRegistrationRequest.findById(id);
    if (!doc) {
      return fail(res, 404, 'REQUEST_NOT_FOUND', 'Request not found');
    }
    if (doc.adminStatus === 'approved') {
      return fail(res, 409, 'ALREADY_APPROVED', 'Cannot reject an approved request');
    }

    doc.adminStatus = 'rejected';
    doc.adminNote = note;
    doc.reviewedBy = req.userId || req.user?.id || null;
    doc.reviewedAt = new Date();
    doc.rejectedAt = new Date();
    await doc.save();

    if (doc.dropshipperId) {
      await Dropshipper.updateOne(
        { _id: doc.dropshipperId, status: { $in: ['pending_otp', 'pending_admin'] } },
        { $set: { status: 'rejected', rejectionNote: note, rejectedAt: new Date() } }
      );
    }

    return ok(res, {
      message: 'Request rejected',
      data: serializeRequest(doc)
    });
  } catch (error) {
    return fail(res, 500, 'REQUEST_REJECT_FAILED', error.message || 'Failed to reject request');
  }
};

/** GET /accounts */
exports.listAccounts = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const status = String(req.query.status || '').trim().toLowerCase();
    const q = String(req.query.q || req.query.search || '').trim();

    const filter = {};
    if (status && status !== 'all') {
      filter.status = status;
    }
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ fullName: re }, { email: re }, { phone: re }, { businessName: re }];
    }

    const [total, rows] = await Promise.all([
      Dropshipper.countDocuments(filter),
      Dropshipper.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
    ]);

    const accounts = rows.map((d) => d.toSafeJSON());
    return ok(res, {
      data: {
        accounts,
        items: accounts,
        dropshippers: accounts,
        total,
        page,
        limit
      },
      accounts,
      total,
      page,
      limit
    });
  } catch (error) {
    return fail(res, 500, 'ACCOUNTS_LIST_FAILED', error.message || 'Failed to list accounts');
  }
};

/** GET /accounts/:id */
exports.getAccount = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const doc = await Dropshipper.findById(id);
    if (!doc) {
      return fail(res, 404, 'ACCOUNT_NOT_FOUND', 'Dropshipper account not found');
    }
    const payload = doc.toSafeJSON();
    return ok(res, {
      dropshipper: payload,
      account: payload,
      data: payload
    });
  } catch (error) {
    return fail(res, 500, 'ACCOUNT_GET_FAILED', error.message || 'Failed to load account');
  }
};
