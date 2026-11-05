/**
 * Admin corporate gift / bulk enquiry list, detail, status.
 * Scoped by x-storefront (ecomm | wholesale) via requireStrictAdminStorefrontScope.
 */
const express = require('express');
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const { requireStrictAdminStorefrontScope } = require('../middlewares/admin-storefront-scope.middleware');
const {
  listGiftEnquiries,
  getGiftEnquiry,
  updateGiftEnquiryStatus
} = require('../controllers/corporate-gift-enquiry.controller');

const router = express.Router();

router.use(verifyToken);
router.use(authorizeRoles('admin', 'marketing_manager', 'order_manager'));
router.use(requireStrictAdminStorefrontScope);

router.get('/', listGiftEnquiries);
router.get('/:id', getGiftEnquiry);
router.patch('/:id/status', updateGiftEnquiryStatus);

module.exports = router;
