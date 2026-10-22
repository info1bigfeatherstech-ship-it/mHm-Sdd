const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middlewares/auth.middleware');
const { authorizeRoles } = require('../middlewares/authorize-roles.middleware');
const catalogAttributeController = require('../controllers/catalogAttribute.controller');

const readRoles = authorizeRoles(
  'admin',
  'product_manager',
  'marketing_manager',
  'inventory_manager'
);
const writeRoles = authorizeRoles('admin', 'product_manager');

router.use(verifyToken);

router.get('/', readRoles, catalogAttributeController.listAttributes);
router.get('/:idOrCode', readRoles, catalogAttributeController.getAttribute);
router.post('/', writeRoles, catalogAttributeController.createAttribute);
router.put('/:idOrCode', writeRoles, catalogAttributeController.updateAttribute);
router.post('/:idOrCode/values', writeRoles, catalogAttributeController.addAttributeValue);
router.delete('/:idOrCode/values', writeRoles, catalogAttributeController.removeAttributeValue);
router.delete('/:idOrCode', writeRoles, catalogAttributeController.deleteAttribute);

module.exports = router;
