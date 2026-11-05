const express = require('express');
const authPublicRoutes = require('./dropshipperAuthPublic.route');
const {
  requireDropshipperAuth,
  requireActiveDropshipperSubscription
} = require('../middlewares/dropshipperAccess.middleware');
const catalog = require('../controllers/dropshipperCatalog.controller');
const orders = require('../controllers/dropshipperOrders.controller');
const serviceability = require('../controllers/dropshipperServiceability.controller');

const router = express.Router();

// Public + auth endpoints under /api/dropshipper/auth/*
router.use('/auth', authPublicRoutes);

// Panel: dropshipper JWT + active subscription
const panel = [requireDropshipperAuth, requireActiveDropshipperSubscription];

router.post('/serviceability/check', ...panel, serviceability.checkServiceability);

router.get('/catalog/products', ...panel, catalog.listCatalogProducts);
router.get('/catalog/products/:slug', ...panel, catalog.getCatalogProduct);
router.get('/catalog/variants/:productCode', ...panel, catalog.getCatalogVariant);
router.get(
  '/catalog/variants/:productCode/download-pack',
  ...panel,
  catalog.downloadVariantPack
);

router.post('/orders/quote', ...panel, orders.quoteOrder);
router.post('/orders', ...panel, orders.createOrder);
router.post('/orders/verify-payment', ...panel, orders.verifyPayment);
router.get('/orders', ...panel, orders.listOrders);
router.get('/orders/:orderId', ...panel, orders.getOrder);

module.exports = router;
