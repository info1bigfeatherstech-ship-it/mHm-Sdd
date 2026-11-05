const { quoteDropshipShipping } = require('../services/dropshipOrderPricing.service');
const { isCodPaymentMode } = require('../utils/dropshipperValidators');

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, ...extra });
}

/**
 * POST /serviceability/check
 * warehouse → customer pincode; paymentMode prepaid only.
 * Uses checkDeliveryAvailabilityForActiveProvider with storefront mapped to ecomm.
 */
exports.checkServiceability = async (req, res) => {
  try {
    const customerPincode = String(
      req.body.customerPincode || req.body.pincode || req.body.deliveryPincode || ''
    )
      .replace(/\D/g, '')
      .slice(0, 6);

    const paymentMode = String(req.body.paymentMode || req.body.shippingPaymentMode || 'prepaid')
      .trim()
      .toLowerCase();

    if (isCodPaymentMode(paymentMode)) {
      return fail(res, 400, 'COD_NOT_ALLOWED', 'Dropship serviceability is prepaid only — COD is rejected');
    }

    if (!/^\d{6}$/.test(customerPincode)) {
      return fail(res, 400, 'INVALID_PINCODE', 'Valid 6-digit customer pincode is required');
    }

    const warehousePincode = String(
      req.body.warehousePincode ||
        process.env.STORE_PINCODE ||
        process.env.PICKUP_PINCODE ||
        ''
    )
      .replace(/\D/g, '')
      .slice(0, 6);

    const weightKg = Number(req.body.weightKg) > 0 ? Number(req.body.weightKg) : 0.5;
    const orderAmount = Number(req.body.orderAmount) > 0 ? Number(req.body.orderAmount) : 0;

    const quote = await quoteDropshipShipping(customerPincode, {
      weightKg,
      dimensions: {
        lengthCm: Number(req.body.lengthCm) || undefined,
        widthCm: Number(req.body.widthCm) || undefined,
        heightCm: Number(req.body.heightCm) || undefined
      },
      orderAmount
    });

    return res.status(200).json({
      success: true,
      serviceable: quote.isDeliverable,
      warehousePincode: warehousePincode || null,
      customerPincode,
      paymentMode: 'prepaid',
      delivery: quote
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return fail(res, status, error.code || 'SERVICEABILITY_CHECK_FAILED', error.message || 'Serviceability check failed');
  }
};
