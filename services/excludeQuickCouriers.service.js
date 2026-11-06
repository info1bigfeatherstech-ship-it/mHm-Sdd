/**
 * Exclude Shiprocket Quick / hyperlocal product couriers from standard quotes.
 * Standard checkout and fulfillment must never auto-pick these products.
 */

const QUICK_PRODUCT_NAME_RE =
  /quick|hyperlocal|same[\s-]*day|\bsdd\b|borzo|dunzo|wefast/i;

function isQuickProductCourier(courier) {
  const name = String(
    courier?.courier_name || courier?.courierName || courier?.name || ''
  ).trim();
  return Boolean(name) && QUICK_PRODUCT_NAME_RE.test(name);
}

function excludeQuickProductCouriers(couriers) {
  if (!Array.isArray(couriers)) return [];
  return couriers.filter((c) => !isQuickProductCourier(c));
}

module.exports = {
  isQuickProductCourier,
  excludeQuickProductCouriers
};
