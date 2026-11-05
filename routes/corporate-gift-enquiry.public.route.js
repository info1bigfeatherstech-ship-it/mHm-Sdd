/**
 * Public corporate gift / bulk enquiry create.
 * Auth optional (global optionalAuth may attach userId).
 */
const express = require('express');
const { uploadGiftEnquiryFiles } = require('../middlewares/upload.middleware');
const { createGiftEnquiry } = require('../controllers/corporate-gift-enquiry.controller');

const router = express.Router();

function handleMulterErrors(err, req, res, next) {
  if (!err) return next();
  if (err.name === 'MulterError') {
    const code =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'FILE_TOO_LARGE'
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'TOO_MANY_FILES'
          : 'UPLOAD_FAILED';
    return res.status(400).json({
      success: false,
      code,
      message: err.message || 'File upload failed'
    });
  }
  if (err.message && /only|allowed|pdf|image/i.test(err.message)) {
    return res.status(400).json({
      success: false,
      code: 'INVALID_FILE_TYPE',
      message: err.message
    });
  }
  return next(err);
}

router.post('/', (req, res, next) => {
  uploadGiftEnquiryFiles(req, res, (err) => {
    if (err) return handleMulterErrors(err, req, res, next);
    return createGiftEnquiry(req, res, next);
  });
});

module.exports = router;
