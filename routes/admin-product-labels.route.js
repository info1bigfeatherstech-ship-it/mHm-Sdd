const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const productLabelController = require('../controllers/productLabel.controller');

const writeRoles = authorizeRoles('admin', 'product_manager', 'marketing_manager');
const readRoles = authorizeRoles(
  'admin',
  'product_manager',
  'marketing_manager',
  'inventory_manager'
);

router.use(verifyToken);

router.get('/', readRoles, productLabelController.listLabelsAdmin);
router.get('/:idOrSlug', readRoles, productLabelController.getLabelAdmin);
router.post('/', writeRoles, productLabelController.createLabel);
router.put('/:idOrSlug', writeRoles, productLabelController.updateLabel);
router.delete('/:idOrSlug', writeRoles, productLabelController.deleteLabel);

module.exports = router;
