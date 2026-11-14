const mongoose = require('mongoose');
const Order = require('../../models/Order');
const Dropshipper = require('../models/Dropshipper');

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, ...extra });
}

function ok(res, payload = {}) {
  return res.status(200).json({ success: true, ...payload });
}

/** Compact partner card for list/detail — never mixes with retail customer. */
function dropshipperSummary(ds) {
  if (!ds) return null;
  const id = String(ds._id || ds.id || '').trim();
  return {
    id: id || null,
    _id: id || null,
    fullName: String(ds.fullName || '').trim() || null,
    businessName: String(ds.businessName || '').trim() || null,
    email: String(ds.email || '').trim() || null,
    phone: String(ds.phone || '').trim() || null,
    whatsappNumber: String(ds.whatsappNumber || '').trim() || null,
    status: ds.status || null
  };
}

function resolveDropshipperIdFromOrder(order) {
  const raw = order?.dropshipMeta?.dropshipperId || order?.userId || null;
  if (!raw) return null;
  const id = String(raw._id || raw.id || raw).trim();
  return mongoose.isValidObjectId(id) ? id : null;
}

/**
 * Batch-attach dropshipper summaries onto lean order docs.
 * Keeps dropship channel isolated — only Dropshipper model, never ecomm User.
 */
async function attachDropshippersToOrders(orders) {
  const list = Array.isArray(orders) ? orders : [];
  if (!list.length) return list;

  const idSet = new Set();
  for (const ord of list) {
    const id = resolveDropshipperIdFromOrder(ord);
    if (id) idSet.add(id);
  }
  if (!idSet.size) {
    return list.map((ord) => ({ ...ord, dropshipper: null }));
  }

  const partners = await Dropshipper.find({ _id: { $in: Array.from(idSet) } })
    .select('fullName email phone businessName whatsappNumber status')
    .lean();
  const byId = new Map();
  for (const p of partners) {
    byId.set(String(p._id), dropshipperSummary(p));
  }

  return list.map((ord) => {
    const id = resolveDropshipperIdFromOrder(ord);
    return {
      ...ord,
      dropshipper: (id && byId.get(id)) || null
    };
  });
}

/** GET /orders — storefront:dropship only */
exports.listOrders = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;

    const filter = { storefront: 'dropship' };

    const status = String(req.query.status || req.query.orderStatus || '').trim().toLowerCase();
    if (status && status !== 'all') {
      filter.orderStatus = status;
    }

    const paymentStatus = String(req.query.paymentStatus || '').trim().toLowerCase();
    if (paymentStatus && paymentStatus !== 'all') {
      filter.paymentStatus = paymentStatus;
    }

    const dropshipperId = String(req.query.dropshipperId || '').trim();
    if (dropshipperId && mongoose.isValidObjectId(dropshipperId)) {
      filter.$or = [{ userId: dropshipperId }, { 'dropshipMeta.dropshipperId': dropshipperId }];
    }

    const ref = String(req.query.ref || '').trim();
    if (ref) {
      filter['dropshipMeta.ref'] = new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    const q = String(req.query.q || req.query.search || '').trim();
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      // Partner name/phone/email search → resolve Dropshipper ids first (isolated channel).
      let partnerIds = [];
      try {
        const matchedPartners = await Dropshipper.find({
          $or: [{ fullName: re }, { businessName: re }, { email: re }, { phone: re }, { whatsappNumber: re }]
        })
          .select('_id')
          .limit(50)
          .lean();
        partnerIds = matchedPartners.map((p) => String(p._id));
      } catch {
        partnerIds = [];
      }

      const qOr = [
        { orderId: re },
        { 'dropshipMeta.ref': re },
        { 'dropshipMeta.customerName': re },
        { 'dropshipMeta.customerPhone': re },
        { 'addressSnapshot.fullName': re },
        { 'addressSnapshot.phone': re },
        { 'shipmentInfo.awbCode': re },
        { 'shipmentInfo.trackingNumber': re }
      ];
      if (partnerIds.length) {
        qOr.push({ 'dropshipMeta.dropshipperId': { $in: partnerIds } });
        qOr.push({ userId: { $in: partnerIds } });
      }
      const qFilter = { $or: qOr };
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, qFilter];
        delete filter.$or;
      } else {
        Object.assign(filter, qFilter);
      }
    }

    const [total, rawOrders] = await Promise.all([
      Order.countDocuments(filter),
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()
    ]);
    const orders = await attachDropshippersToOrders(rawOrders);

    return ok(res, {
      data: {
        orders,
        items: orders,
        total,
        page,
        limit
      }
    });
  } catch (error) {
    return fail(res, 500, 'ADMIN_DROPSHIP_ORDERS_FAILED', error.message || 'Failed to list orders');
  }
};

/** GET /orders/:orderId */
exports.getOrder = async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    const order = await Order.findOne({ orderId, storefront: 'dropship' }).lean();
    if (!order) {
      return fail(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
    }

    let dropshipper = null;
    const dsId = resolveDropshipperIdFromOrder(order);
    if (dsId) {
      const ds = await Dropshipper.findById(dsId);
      if (ds) dropshipper = ds.toSafeJSON();
    }

    const orderWithPartner = {
      ...order,
      dropshipper: dropshipperSummary(dropshipper) || dropshipper
    };

    return ok(res, {
      order: orderWithPartner,
      data: orderWithPartner,
      dropshipper
    });
  } catch (error) {
    return fail(res, 500, 'ADMIN_DROPSHIP_ORDER_FAILED', error.message || 'Failed to load order');
  }
};
