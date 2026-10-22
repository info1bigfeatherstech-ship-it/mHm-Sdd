const express = require('express');
const router = express.Router();
const productLabelController = require('../controllers/productLabel.controller');

/** Public marketing labels for storefront nav / landing pages. */
router.get('/', productLabelController.listLabelsPublic);
router.get('/:slug', productLabelController.getLabelPublic);

module.exports = router;
