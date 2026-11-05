const mongoose = require('mongoose');
const Order = require('../../models/Order');
const Dropshipper = require('../models/Dropshipper');

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, ...extra });
}

function ok(res, payload = {}) {
  return res.status(200).json({ success: true, ...payload });
}

/** GET /orders */
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
      const qFilter = {
        $or: [
          { orderId: re },
          { 'dropshipMeta.ref': re },
          { 'dropshipMeta.customerName': re },
          { 'dropshipMeta.customerPhone': re },
          { 'addressSnapshot.fullName': re },
          { 'addressSnapshot.phone': re }
        ]
      };
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, qFilter];
        delete filter.$or;
      } else {
        Object.assign(filter, qFilter);
      }
    }

    const [total, orders] = await Promise.all([
      Order.countDocuments(filter),
      Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()
    ]);

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
    const dsId = order.dropshipMeta?.dropshipperId || order.userId;
    if (dsId) {
      const ds = await Dropshipper.findById(dsId);
      if (ds) dropshipper = ds.toSafeJSON();
    }

    return ok(res, { order, data: order, dropshipper });
  } catch (error) {
    return fail(res, 500, 'ADMIN_DROPSHIP_ORDER_FAILED', error.message || 'Failed to load order');
  }
};
