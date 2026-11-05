const express = require('express');
const multer = require('multer');
const auth = require('../controllers/dropshipperAuth.controller');
const {
  requireDropshipperAuth
} = require('../middlewares/dropshipperAccess.middleware');

const router = express.Router();

const proofUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/jpg',
      'image/heic',
      'image/heif',
      'image/gif',
      'image/avif'
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF and image proofs are allowed'), false);
  }
});

const uploadRegistrationProofs = proofUpload.fields([
  { name: 'idProof', maxCount: 1 },
  { name: 'idProofUpload', maxCount: 1 },
  { name: 'idProofFile', maxCount: 1 },
  { name: 'businessAddressProof', maxCount: 1 },
  { name: 'businessAddressProofUpload', maxCount: 1 },
  { name: 'businessAddressProofFile', maxCount: 1 }
]);

// Public auth
router.get('/subscription-settings', auth.getSubscriptionSettings);
router.post('/register/start', auth.registerStart);
router.post('/register/create-payment', uploadRegistrationProofs, auth.registerCreatePayment);
router.post('/register/verify-payment', auth.registerVerifyPayment);
router.get('/register/status/:requestId', auth.registerStatus);
router.post('/activate/send-otp', auth.activateSendOtp);
router.post('/activate/complete', auth.activateComplete);
router.post('/login', auth.login);
router.post('/refresh', auth.refresh);

// Authenticated auth helpers
router.get('/me', requireDropshipperAuth, auth.me);
router.post('/logout', requireDropshipperAuth, auth.logout);
router.post('/renew/create-payment', requireDropshipperAuth, auth.renewCreatePayment);
router.post('/renew/verify-payment', requireDropshipperAuth, auth.renewVerifyPayment);

module.exports = router;
