const express = require('express');
const { verifyToken } = require('../../middlewares/auth.middleware');
const { authorizeRoles } = require('../../middlewares/authorize-roles.middleware');
const adminAuthOps = require('../controllers/adminDropshipAuthOps.controller');
const adminOrders = require('../controllers/adminDropshipOrders.controller');
const adminProducts = require('../controllers/adminDropshipProducts.controller');

const router = express.Router();

/**
 * Role matrix (matches OWB dropship admin contract):
 * - Products read:  admin | product_manager | inventory_manager
 * - Products write: admin | product_manager
 * - Orders:         admin | order_manager | product_manager | inventory_manager
 * - Requests / accounts / settings: admin | product_manager | order_manager
 */
const productReadRoles = authorizeRoles('admin', 'product_manager', 'inventory_manager');
const productWriteRoles = authorizeRoles('admin', 'product_manager');
const orderRoles = authorizeRoles(
  'admin',
  'order_manager',
  'product_manager',
  'inventory_manager'
);
const authOpsRoles = authorizeRoles('admin', 'product_manager', 'order_manager');

router.use(verifyToken);

// Settings
router.get('/settings', authOpsRoles, adminAuthOps.getSettings);
router.patch('/settings', authOpsRoles, adminAuthOps.patchSettings);

// Registration / renewal requests
router.get('/requests', authOpsRoles, adminAuthOps.listRequests);
router.post('/requests/:id/approve', authOpsRoles, adminAuthOps.approveRequest);
router.post('/requests/:id/reject', authOpsRoles, adminAuthOps.rejectRequest);

// Accounts
router.get('/accounts', authOpsRoles, adminAuthOps.listAccounts);
router.get('/accounts/:id', authOpsRoles, adminAuthOps.getAccount);

// Orders (dropship storefront only)
router.get('/orders', orderRoles, adminOrders.listOrders);
router.get('/orders/:orderId', orderRoles, adminOrders.getOrder);

// Products / variant pricing
router.get('/products', productReadRoles, adminProducts.listProducts);
router.get('/products/:slug', productReadRoles, adminProducts.getProduct);
router.patch(
  '/products/:slug/variants/:productCode/price',
  productWriteRoles,
  adminProducts.setVariantPrice
);
router.patch(
  '/products/:slug/variants/:productCode/enable',
  productWriteRoles,
  adminProducts.enableVariant
);
router.patch(
  '/products/:slug/variants/:productCode/disable',
  productWriteRoles,
  adminProducts.disableVariant
);
router.post('/products/bulk-enable', productWriteRoles, adminProducts.bulkEnable);
router.post('/products/bulk-set-price', productWriteRoles, adminProducts.bulkSetPrice);

module.exports = router;
