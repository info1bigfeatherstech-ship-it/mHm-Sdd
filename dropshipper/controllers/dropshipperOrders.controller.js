const crypto = require('crypto');
const mongoose = require('mongoose');
const Razorpay = require('razorpay');
const Order = require('../../models/Order');
const Address = require('../../models/Address');
const paymentHoldExpiryService = require('../../services/paymentHoldExpiry.service');
const { reserveCheckoutStock } = require('../../services/orderStockBridge.service');
const { allocateUniqueOrderId, orderIdsForDigitSuffix } = require('../../utils/orderId');
const { buildAddressCreatePayload } = require('../../utils/splitCheckoutAddress');
const { recoverOrderStatusAfterSuccessfulCapture } = require('../../utils/orderPaymentState');
const shippingProviderSettingsService = require('../../services/shippingProviderSettings.service');
const {
  resolveDropshipOrderLines,
  quoteDropshipShipping,
  roundMoney2
} = require('../services/dropshipOrderPricing.service');
const { isCodPaymentMode } = require('../utils/dropshipperValidators');

let _razorpay = null;
function getRazorpay() {
  if (_razorpay) return _razorpay;
  const key_id = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const key_secret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!key_id || !key_secret) {
    const err = new Error('Razorpay is not configured');
    err.statusCode = 503;
    err.code = 'RAZORPAY_NOT_CONFIGURED';
    throw err;
  }
  _razorpay = new Razorpay({ key_id, key_secret });
  return _razorpay;
}

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, ...extra });
}

function ok(res, payload = {}, status = 200) {
  return res.status(status).json({ success: true, ...payload });
}

function mergeCustomerShippingAddress(body = {}) {
  const customer = body.customer && typeof body.customer === 'object' ? body.customer : {};
  const shipping =
    (body.shippingAddress && typeof body.shippingAddress === 'object' && body.shippingAddress) ||
    (body.address && typeof body.address === 'object' && body.address) ||
    {};

  const blob = String(
    shipping.address ||
      shipping.fullAddress ||
      shipping.streetAddress ||
      shipping.street ||
      customer.address ||
      customer.fullAddress ||
      ''
  ).trim();

  // Merge customer + shippingAddress so houseNumber/area/postal exist
  // (avoids ADDRESS_VALIDATION_FAILED when portal sends customer-only fields).
  const pinMerged = String(
    shipping.postalCode ||
      shipping.pincode ||
      shipping.pin ||
      customer.postalCode ||
      customer.pincode ||
      customer.pin ||
      ''
  )
    .replace(/\D/g, '')
    .slice(0, 6);

  const built = buildAddressCreatePayload({
    name: shipping.fullName || customer.name || customer.fullName || '',
    phone: shipping.phone || customer.phone || customer.mobile || '',
    houseNumber: shipping.houseNumber || shipping.house || customer.houseNumber || customer.house || '',
    building: shipping.building || customer.building || '',
    floor: shipping.floor || customer.floor || '',
    addressLine1:
      shipping.addressLine1 ||
      shipping.line1 ||
      customer.addressLine1 ||
      customer.line1 ||
      blob ||
      '',
    addressLine2: shipping.addressLine2 || shipping.line2 || customer.addressLine2 || customer.line2 || '',
    area: shipping.area || shipping.locality || customer.area || customer.locality || '',
    landmark: shipping.landmark || customer.landmark || '',
    city: shipping.city || customer.city || '',
    state: shipping.state || customer.state || '',
    pincode: pinMerged,
    postalCode: pinMerged,
    address: blob
  });

  return {
    fullName: built.fullName,
    phone: built.phone,
    email: String(shipping.email || customer.email || '').trim().toLowerCase(),
    houseNumber: built.houseNumber,
    building: built.building || '',
    floor: built.floor || '',
    addressLine1: built.addressLine1,
    addressLine2: built.addressLine2 || '',
    area: built.area,
    landmark: built.landmark || '',
    city: built.city,
    state: built.state,
    postalCode: built.postalCode,
    country: String(shipping.country || 'India').trim() || 'India'
  };
}

function ownershipOk(order, dropshipperId) {
  if (!order || !dropshipperId) return false;
  if (String(order.userId) === String(dropshipperId)) return true;
  if (order.dropshipMeta?.dropshipperId && String(order.dropshipMeta.dropshipperId) === String(dropshipperId)) {
    return true;
  }
  return false;
}

/** POST /orders/quote */
exports.quoteOrder = async (req, res) => {
  try {
    const items = req.body.items || req.body.lines || [];
    const paymentMode = String(req.body.paymentMode || req.body.shippingPaymentMode || 'prepaid');
    if (isCodPaymentMode(paymentMode)) {
      return fail(res, 400, 'COD_NOT_ALLOWED', 'Dropship orders are prepaid only — COD is rejected');
    }

    const address = mergeCustomerShippingAddress(req.body);
    if (!/^\d{6}$/.test(address.postalCode)) {
      return fail(res, 400, 'INVALID_PINCODE', 'Valid shipping pincode is required');
    }

    const priced = await resolveDropshipOrderLines(items);
    const shipping = await quoteDropshipShipping(address.postalCode, {
      weightKg: priced.weightKg,
      dimensions: priced.dimensions,
      orderAmount: priced.subtotal
    });

    if (!shipping.isDeliverable) {
      return fail(res, 409, 'NOT_SERVICEABLE', shipping.message || 'Delivery not available to this pincode', {
        shipping
      });
    }

    const deliveryCharges = shipping.deliveryCharges;
    const totalAmount = roundMoney2(priced.subtotal + deliveryCharges);

    return ok(res, {
      quote: {
        items: priced.lines.map((l) => ({
          productCode: l.productCode,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
          slug: l.slug
        })),
        subtotal: priced.subtotal,
        deliveryCharges,
        tax: 0,
        discount: 0,
        totalAmount,
        paymentMode: 'prepaid',
        shipping,
        currency: 'INR'
      }
    });
  } catch (error) {
    return fail(res, error.statusCode || 500, error.code || 'QUOTE_FAILED', error.message || 'Quote failed');
  }
};

/** POST /orders — create + reserve stock + Razorpay; COD rejected; storefront dropship */
exports.createOrder = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  let orderDoc = null;

  try {
    const ds = req.dropshipper;
    if (!ds && !req.dropshipperBypass) {
      await session.abortTransaction();
      return fail(res, 401, 'DROPSHIPPER_AUTH_REQUIRED', 'Not authenticated');
    }
    if (!ds) {
      await session.abortTransaction();
      return fail(res, 403, 'BYPASS_ORDER_BLOCKED', 'Staff bypass cannot place dropship orders');
    }

    const paymentMode = String(req.body.paymentMode || req.body.shippingPaymentMode || 'prepaid');
    if (isCodPaymentMode(paymentMode)) {
      await session.abortTransaction();
      return fail(res, 400, 'COD_NOT_ALLOWED', 'Dropship orders are prepaid only — COD is rejected');
    }

    if (!String(process.env.RAZORPAY_KEY_ID || '').trim() || !String(process.env.RAZORPAY_KEY_SECRET || '').trim()) {
      await session.abortTransaction();
      return fail(res, 503, 'RAZORPAY_NOT_CONFIGURED', 'Online payment is temporarily unavailable');
    }

    const addressInput = mergeCustomerShippingAddress(req.body);
    if (!addressInput.fullName || !/^\d{10}$/.test(addressInput.phone) || !/^\d{6}$/.test(addressInput.postalCode)) {
      await session.abortTransaction();
      return fail(res, 400, 'INVALID_ADDRESS', 'fullName, 10-digit phone and 6-digit pincode are required');
    }
    if (!addressInput.houseNumber || !addressInput.city || !addressInput.state) {
      await session.abortTransaction();
      return fail(res, 400, 'INVALID_ADDRESS', 'houseNumber, city and state are required');
    }

    const items = req.body.items || req.body.lines || [];
    const priced = await resolveDropshipOrderLines(items);
    const shipping = await quoteDropshipShipping(addressInput.postalCode, {
      weightKg: priced.weightKg,
      dimensions: priced.dimensions,
      orderAmount: priced.subtotal
    });
    if (!shipping.isDeliverable) {
      await session.abortTransaction();
      return fail(res, 409, 'NOT_SERVICEABLE', shipping.message || 'Delivery not available', { shipping });
    }

    const deliveryCharges = shipping.deliveryCharges;
    const subtotal = priced.subtotal;
    const totalAmount = roundMoney2(subtotal + deliveryCharges);

    const address = await Address.create(
      [
        {
          userId: ds._id,
          storefront: 'dropship',
          fullName: addressInput.fullName,
          phone: addressInput.phone,
          houseNumber: addressInput.houseNumber,
          building: addressInput.building || undefined,
          floor: addressInput.floor || undefined,
          addressLine1: addressInput.addressLine1 || addressInput.houseNumber,
          addressLine2: addressInput.addressLine2 || undefined,
          area: addressInput.area || 'N/A',
          landmark: addressInput.landmark || undefined,
          city: addressInput.city,
          state: addressInput.state,
          postalCode: addressInput.postalCode,
          country: addressInput.country || 'India',
          isDefault: false
        }
      ],
      { session }
    );
    const addressDoc = address[0];

    const addressSnapshot = {
      fullName: addressDoc.fullName,
      phone: addressDoc.phone,
      email: addressInput.email || ds.email,
      houseNumber: addressDoc.houseNumber,
      building: addressDoc.building,
      floor: addressDoc.floor,
      addressLine1: addressDoc.addressLine1,
      addressLine2: addressDoc.addressLine2,
      area: addressDoc.area,
      landmark: addressDoc.landmark,
      city: addressDoc.city,
      state: addressDoc.state,
      postalCode: addressDoc.postalCode,
      country: addressDoc.country
    };

    let shippingProvider = 'shiprocket';
    try {
      shippingProvider = await shippingProviderSettingsService.getActiveProviderForNewOrders('ecomm');
    } catch {
      shippingProvider = 'shiprocket';
    }

    const orderId = await allocateUniqueOrderId({
      storefront: 'dropship',
      userType: 'normal',
      maxAttempts: 32,
      isSuffixTaken: async (digits) => {
        const ids = orderIdsForDigitSuffix(digits);
        return Boolean(await Order.exists({ orderId: { $in: ids } }));
      }
    });

    const ref = String(req.body.ref || req.body.dropshipRef || req.body.partnerRef || '').trim() || null;

    const orderItems = priced.lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      productCode: l.productCode,
      quantity: l.quantity,
      priceSnapshot: l.priceSnapshot,
      variantAttributesSnapshot: l.variantAttributesSnapshot,
      userType: 'normal',
      hsnCode: l.hsnCode,
      gstRate: l.gstRate,
      isFragile: l.isFragile
    }));

    orderDoc = new Order({
      orderId,
      userId: ds._id,
      items: orderItems,
      subtotal,
      deliveryCharges,
      deliveryFreightInr: shipping.freightInr,
      deliveryCodFeeInr: 0,
      tax: 0,
      discount: 0,
      totalAmount,
      address: addressDoc._id,
      addressSnapshot,
      userType: 'normal',
      storefront: 'dropship',
      shippingProvider,
      shippingSpeed: 'standard',
      orderStatus: 'pending',
      paymentStatus: 'pending',
      amountPaidInr: 0,
      balanceDueInr: totalAmount,
      paymentHoldExpiresAt: new Date(Date.now() + paymentHoldExpiryService.getPaymentHoldMs()),
      paymentInfo: {
        method: 'online',
        status: 'created',
        shippingPaymentMode: 'prepaid'
      },
      dropshipMeta: {
        ref,
        placedByUserId: ds._id,
        dropshipperId: ds._id,
        customerPhone: addressInput.phone,
        customerName: addressInput.fullName
      }
    });

    // Reserve stock before Razorpay (map dropship→ecomm inside bridge)
    const inventoryHold = await reserveCheckoutStock({
      orderId,
      storefront: 'dropship',
      lines: priced.lines.map((l) => ({
        productId: l.productId,
        variantId: l.variantId,
        productCode: l.productCode,
        quantity: l.quantity,
        trackInventory: l.trackInventory
      })),
      session
    });
    orderDoc.inventoryHold = {
      source: inventoryHold.source || null,
      status: inventoryHold.status || 'held',
      reservationId: inventoryHold.reservationId || null,
      inventoryReserved: Boolean(inventoryHold.inventoryReserved),
      mongoReserved: Boolean(inventoryHold.mongoReserved),
      reason: inventoryHold.reason || null,
      updatedAt: new Date()
    };

    const amountPaise = Math.round(totalAmount * 100);
    const rzOrder = await getRazorpay().orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: String(orderId).slice(0, 40),
      payment_capture: 1,
      notes: {
        orderId,
        storefront: 'dropship',
        dropshipperId: String(ds._id)
      }
    });

    orderDoc.paymentInfo.razorpayOrderId = rzOrder.id;
    orderDoc.paymentInfo.sessions = [
      {
        razorpayOrderId: rzOrder.id,
        amountPaise,
        status: 'created',
        createdAt: new Date()
      }
    ];
    orderDoc.paymentStatus = 'initiated';

    await orderDoc.save({ session });
    await session.commitTransaction();

    return ok(
      res,
      {
        message: 'Order created — complete prepaid payment',
        order: {
          orderId: orderDoc.orderId,
          orderStatus: orderDoc.orderStatus,
          paymentStatus: orderDoc.paymentStatus,
          totalAmount: orderDoc.totalAmount,
          subtotal: orderDoc.subtotal,
          deliveryCharges: orderDoc.deliveryCharges,
          balanceDueInr: orderDoc.balanceDueInr,
          dropshipMeta: orderDoc.dropshipMeta,
          paymentHoldExpiresAt: orderDoc.paymentHoldExpiresAt
        },
        razorpayKeyId: String(process.env.RAZORPAY_KEY_ID || '').trim(),
        razorpayOrder: {
          id: rzOrder.id,
          amount: rzOrder.amount,
          currency: rzOrder.currency
        }
      },
      201
    );
  } catch (error) {
    try {
      await session.abortTransaction();
    } catch {
      /* ignore */
    }
    return fail(
      res,
      error.statusCode || 500,
      error.code || 'ORDER_CREATE_FAILED',
      error.message || 'Failed to create order'
    );
  } finally {
    session.endSession();
  }
};

/** POST /orders/verify-payment — ownership gate then HMAC verify */
exports.verifyPayment = async (req, res) => {
  try {
    const ds = req.dropshipper;
    if (!ds) {
      return fail(res, 401, 'DROPSHIPPER_AUTH_REQUIRED', 'Not authenticated');
    }

    const razorpay_order_id = String(req.body.razorpay_order_id || '').trim();
    const razorpay_payment_id = String(req.body.razorpay_payment_id || '').trim();
    const razorpay_signature = String(req.body.razorpay_signature || '').trim();
    const orderId = String(req.body.orderId || '').trim();

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !orderId) {
      return fail(
        res,
        400,
        'PAYMENT_VERIFY_PAYLOAD_INVALID',
        'razorpay_order_id, razorpay_payment_id, razorpay_signature and orderId are required'
      );
    }

    const order = await Order.findOne({ orderId, storefront: 'dropship' });
    if (!order) {
      return fail(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
    }
    if (!ownershipOk(order, ds._id)) {
      return fail(res, 403, 'ORDER_ACCESS_DENIED', 'Unauthorized');
    }

    const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');
    if (expectedSignature !== razorpay_signature) {
      return fail(res, 400, 'PAYMENT_SIGNATURE_INVALID', 'Invalid payment signature');
    }

    order.paymentInfo = order.paymentInfo || {};
    order.paymentInfo.capturedPaymentIds = order.paymentInfo.capturedPaymentIds || [];

    if (order.paymentInfo.capturedPaymentIds.includes(razorpay_payment_id)) {
      recoverOrderStatusAfterSuccessfulCapture(order, { trigger: 'dropship_verify_idempotent' });
      // Force pending for dropship even if legacy auto-fulfill tried to confirm
      if (String(order.storefront) === 'dropship' && order.orderStatus === 'confirmed') {
        order.orderStatus = 'pending';
      }
      await order.save();
      return ok(res, {
        message: 'Payment already verified',
        order: {
          orderId: order.orderId,
          orderStatus: order.orderStatus,
          paymentStatus: order.paymentStatus,
          balanceDueInr: order.balanceDueInr
        }
      });
    }

    const sessionMatches =
      order.paymentInfo?.razorpayOrderId === razorpay_order_id ||
      (Array.isArray(order.paymentInfo?.sessions) &&
        order.paymentInfo.sessions.some((s) => s.razorpayOrderId === razorpay_order_id));
    if (!sessionMatches) {
      return fail(res, 400, 'PAYMENT_ORDER_MISMATCH', 'Payment does not match this order');
    }

    if (String(order.paymentStatus).toLowerCase() === 'paid' && Number(order.amountPaidInr || 0) > 0.01) {
      recoverOrderStatusAfterSuccessfulCapture(order, { trigger: 'dropship_verify_already_paid' });
      if (order.orderStatus === 'confirmed') order.orderStatus = 'pending';
      await order.save();
      return ok(res, {
        message: 'Payment already verified',
        order: {
          orderId: order.orderId,
          orderStatus: order.orderStatus,
          paymentStatus: order.paymentStatus
        }
      });
    }

    const payment = await getRazorpay().payments.fetch(razorpay_payment_id);
    if (payment.order_id !== razorpay_order_id) {
      return fail(res, 400, 'PAYMENT_ORDER_MISMATCH', 'Payment and order mismatch');
    }

    const rpOrder = await getRazorpay().orders.fetch(razorpay_order_id);
    if (rpOrder?.notes?.orderId && rpOrder.notes.orderId !== order.orderId) {
      return fail(res, 400, 'PAYMENT_NOT_LINKED_TO_ORDER', 'Razorpay order is not linked to this checkout');
    }

    const expectedPaise = Number(rpOrder.amount);
    const paidPaise = Number(payment.amount);
    if (!Number.isFinite(paidPaise) || !Number.isFinite(expectedPaise) || paidPaise !== expectedPaise) {
      return fail(res, 400, 'PAYMENT_AMOUNT_MISMATCH', 'Paid amount does not match Razorpay order');
    }

    if (payment.status !== 'captured') {
      if (payment.status === 'authorized') {
        return fail(res, 409, 'PAYMENT_NOT_CAPTURED_YET', 'Payment is authorized but not captured yet');
      }
      return fail(res, 400, 'PAYMENT_NOT_COMPLETED', `Payment not completed (status: ${payment.status})`);
    }

    const paidInr = roundMoney2(paidPaise / 100);
    order.amountPaidInr = roundMoney2((order.amountPaidInr || 0) + paidInr);
    order.balanceDueInr = roundMoney2(order.totalAmount - order.amountPaidInr);
    if (order.balanceDueInr <= 0.005) {
      order.paymentStatus = 'paid';
      order.balanceDueInr = 0;
    } else {
      order.paymentStatus = 'partially_paid';
    }

    order.paymentInfo.razorpayPaymentId = razorpay_payment_id;
    order.paymentInfo.razorpaySignature = razorpay_signature;
    order.paymentInfo.status = 'success';
    order.paymentInfo.paidAt = new Date();
    order.paymentInfo.amountPaise = paidPaise;
    order.paymentInfo.capturedPaymentIds.push(razorpay_payment_id);
    if (Array.isArray(order.paymentInfo.sessions)) {
      const s = order.paymentInfo.sessions.find((x) => x.razorpayOrderId === razorpay_order_id);
      if (s) {
        s.status = 'paid';
        s.razorpayPaymentId = razorpay_payment_id;
        s.paidAt = new Date();
      }
    }

    order.paymentHoldExpiresAt = null;
    // Dropship: paymentStatus paid, orderStatus pending — NEVER auto-confirm
    order.orderStatus = 'pending';
    recoverOrderStatusAfterSuccessfulCapture(order, { trigger: 'dropship_payment_verified' });
    if (order.orderStatus === 'confirmed') {
      order.orderStatus = 'pending';
    }

    order.markModified('paymentInfo');
    await order.save();

    return ok(res, {
      message: 'Payment verified successfully',
      order: {
        orderId: order.orderId,
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus,
        balanceDueInr: order.balanceDueInr,
        amountPaidInr: order.amountPaidInr
      }
    });
  } catch (error) {
    return fail(res, 500, 'PAYMENT_VERIFY_FAILED', error.message || 'Error verifying payment');
  }
};

/** GET /orders — own orders only */
exports.listOrders = async (req, res) => {
  try {
    const ds = req.dropshipper;
    if (!ds) {
      return fail(res, 401, 'DROPSHIPPER_AUTH_REQUIRED', 'Not authenticated');
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const ref = String(req.query.ref || '').trim();

    const filter = {
      storefront: 'dropship',
      $or: [{ userId: ds._id }, { 'dropshipMeta.dropshipperId': ds._id }]
    };
    if (ref) {
      filter['dropshipMeta.ref'] = new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    const [total, orders] = await Promise.all([
      Order.countDocuments(filter),
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(
          'orderId orderStatus paymentStatus totalAmount subtotal deliveryCharges createdAt dropshipMeta paymentHoldExpiresAt amountPaidInr balanceDueInr items'
        )
        .lean()
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
    return fail(res, 500, 'ORDERS_LIST_FAILED', error.message || 'Failed to list orders');
  }
};

/** GET /orders/:orderId — own only */
exports.getOrder = async (req, res) => {
  try {
    const ds = req.dropshipper;
    if (!ds) {
      return fail(res, 401, 'DROPSHIPPER_AUTH_REQUIRED', 'Not authenticated');
    }

    const orderId = String(req.params.orderId || '').trim();
    const order = await Order.findOne({ orderId, storefront: 'dropship' }).lean();
    if (!order || !ownershipOk(order, ds._id)) {
      return fail(res, 404, 'ORDER_NOT_FOUND', 'Order not found');
    }

    return ok(res, { order, data: order });
  } catch (error) {
    return fail(res, 500, 'ORDER_GET_FAILED', error.message || 'Failed to load order');
  }
};
