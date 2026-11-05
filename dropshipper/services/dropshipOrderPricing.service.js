const mongoose = require('mongoose');
const Product = require('../../models/Product');
const { getDropshipBase, isListedDropshipVariant } = require('../utils/dropshipCatalog');
const {
  resolveVariantShipping,
  unitWeightKgFromResolvedShipping,
  DEFAULT_UNIT_WEIGHT_KG
} = require('../../utils/variantCatalogFields');
const { checkDeliveryAvailabilityForActiveProvider } = require('../../services/shippingQuote.service');

function roundMoney2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function findVariantByProductCode(product, productCode) {
  const code = String(productCode || '')
    .trim()
    .toUpperCase();
  if (!code || !Array.isArray(product?.variants)) return null;
  return (
    product.variants.find(
      (v) => String(v.productCode || '').trim().toUpperCase() === code
    ) || null
  );
}

/**
 * Resolve payable dropship lines from [{ productCode, quantity, slug? }].
 */
async function resolveDropshipOrderLines(rawItems = []) {
  if (!Array.isArray(rawItems) || !rawItems.length) {
    const err = new Error('At least one order item is required');
    err.statusCode = 400;
    err.code = 'ITEMS_REQUIRED';
    throw err;
  }

  const codes = [
    ...new Set(
      rawItems
        .map((it) =>
          String(it.productCode || it.sku || '')
            .trim()
            .toUpperCase()
        )
        .filter(Boolean)
    )
  ];

  if (!codes.length) {
    const err = new Error('Each item requires a productCode');
    err.statusCode = 400;
    err.code = 'PRODUCT_CODE_REQUIRED';
    throw err;
  }

  const products = await Product.find({
    'variants.productCode': { $in: codes }
  }).select(
    'slug name title description images shipping hsnCode gstRate isFragile variants category status channelStatus'
  );

  const byCode = new Map();
  for (const p of products) {
    for (const v of p.variants || []) {
      const c = String(v.productCode || '')
        .trim()
        .toUpperCase();
      if (c) byCode.set(c, { product: p, variant: v });
    }
  }

  const lines = [];
  let subtotal = 0;
  let totalWeightKg = 0;
  let maxL = 0;
  let maxW = 0;
  let maxH = 0;

  for (const raw of rawItems) {
    const productCode = String(raw.productCode || raw.sku || '')
      .trim()
      .toUpperCase();
    const quantity = Math.floor(Number(raw.quantity) || 0);
    if (!productCode || quantity < 1) {
      const err = new Error('Each item needs productCode and quantity >= 1');
      err.statusCode = 400;
      err.code = 'INVALID_ITEM';
      throw err;
    }

    const hit = byCode.get(productCode);
    if (!hit) {
      const err = new Error(`Variant not found: ${productCode}`);
      err.statusCode = 404;
      err.code = 'VARIANT_NOT_FOUND';
      throw err;
    }

    const { product, variant } = hit;
    if (!isListedDropshipVariant(variant)) {
      const err = new Error(`Variant ${productCode} is not listed for dropship`);
      err.statusCode = 409;
      err.code = 'VARIANT_NOT_LISTED';
      throw err;
    }

    const unitPrice = getDropshipBase(variant);
    if (unitPrice == null || unitPrice <= 0) {
      const err = new Error(`Invalid dropship price for ${productCode}`);
      err.statusCode = 409;
      err.code = 'INVALID_DROPSHIP_PRICE';
      throw err;
    }

    const track = variant.inventory?.trackInventory !== false;
    const available = Number(variant.inventory?.quantity) || 0;
    if (track && available < quantity) {
      const err = new Error(`Insufficient stock for ${productCode}`);
      err.statusCode = 409;
      err.code = 'INSUFFICIENT_STOCK';
      throw err;
    }

    const lineTotal = roundMoney2(unitPrice * quantity);
    subtotal = roundMoney2(subtotal + lineTotal);

    const resolvedShipping = resolveVariantShipping(variant, product);
    const unitKg = unitWeightKgFromResolvedShipping(resolvedShipping) || DEFAULT_UNIT_WEIGHT_KG;
    totalWeightKg += unitKg * quantity;
    const dims = resolvedShipping?.dimensions || {};
    maxL = Math.max(maxL, Number(dims.length) || 0);
    maxW = Math.max(maxW, Number(dims.width) || 0);
    maxH = Math.max(maxH, Number(dims.height) || 0);

    lines.push({
      productId: product._id,
      variantId: variant._id,
      productCode,
      slug: product.slug,
      quantity,
      unitPrice,
      lineTotal,
      priceSnapshot: {
        base: unitPrice,
        sale: null,
        total: lineTotal
      },
      variantAttributesSnapshot: Array.isArray(variant.attributes)
        ? variant.attributes.map((a) => ({ key: a.key, value: a.value }))
        : [],
      hsnCode: product.hsnCode || null,
      gstRate: product.gstRate ?? null,
      isFragile: product.isFragile === true,
      userType: 'normal',
      trackInventory: track,
      product,
      variant,
      resolvedShipping
    });
  }

  return {
    lines,
    subtotal,
    weightKg: Math.max(0.05, totalWeightKg || DEFAULT_UNIT_WEIGHT_KG),
    dimensions: {
      lengthCm: maxL || 10,
      widthCm: maxW || 10,
      heightCm: maxH || 5
    }
  };
}

/**
 * Quote shipping using ecomm provider settings (shared warehouse).
 * Prepaid only — COD amount always 0.
 */
async function quoteDropshipShipping(postalCode, { weightKg, dimensions, orderAmount } = {}) {
  const pin = String(postalCode || '')
    .replace(/\D/g, '')
    .slice(0, 6);
  if (!/^\d{6}$/.test(pin)) {
    const err = new Error('Valid 6-digit pincode is required');
    err.statusCode = 400;
    err.code = 'INVALID_PINCODE';
    throw err;
  }

  const result = await checkDeliveryAvailabilityForActiveProvider(pin, {
    weightKg: weightKg || DEFAULT_UNIT_WEIGHT_KG,
    lengthCm: dimensions?.lengthCm,
    widthCm: dimensions?.widthCm,
    heightCm: dimensions?.heightCm,
    codAmount: 0,
    orderAmount: orderAmount || 0,
    storefront: 'ecomm'
  });

  return {
    pincode: pin,
    isDeliverable: Boolean(result.isDeliverable),
    deliveryCharges: roundMoney2(result.deliveryCharges || 0),
    freightInr: result.freightInr != null ? roundMoney2(result.freightInr) : roundMoney2(result.deliveryCharges || 0),
    codFeeInr: 0,
    estimatedDays: result.estimatedDays ?? null,
    courierName: result.courierName || null,
    courierCompanyId: result.courierCompanyId || null,
    shipmozoCourierId: result.shipmozoCourierId || null,
    message: result.message || null,
    provider: result.provider || result.shippingProvider || null,
    shippingProvider: result.shippingProvider || result.provider || null,
    mock: Boolean(result.mock)
  };
}

module.exports = {
  roundMoney2,
  findVariantByProductCode,
  resolveDropshipOrderLines,
  quoteDropshipShipping
};
