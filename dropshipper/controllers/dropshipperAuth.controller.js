const crypto = require('crypto');
const Razorpay = require('razorpay');
const redisManager = require('../../config/redis.config');
const tokenStore = require('../../config/tokenBlacklist');
const { generateOTP, deliverOtpFor, getOtpExpiryMs } = require('../../services/otp.service');
const Dropshipper = require('../models/Dropshipper');
const DropshipperRegistrationRequest = require('../models/DropshipperRegistrationRequest');
const { getSettings } = require('../services/dropshipperSettings.service');
const { validateRegistrationApplicant, validatePassword, normalizeEmail, normalizeIndianMobile } = require('../utils/dropshipperValidators');
const { resolveRegistrationRequestBody } = require('../utils/resolveRegistrationRequestBody');
const { uploadRegistrationProofs } = require('../utils/dropshipperProofCloudinary');
const {
  signDropshipperAccessToken,
  signDropshipperRefreshToken,
  verifyDropshipperRefreshToken,
  hashRefreshToken,
  getAccessTtlSeconds,
  getRefreshExpiryDate
} = require('../utils/dropshipperJwt');
const { extractBearer, isTokenBlacklisted } = require('../middlewares/dropshipperAccess.middleware');

const OTP_TTL_MS = getOtpExpiryMs();
const MAX_OTP_ATTEMPTS = 5;

let _razorpay = null;
function getRazorpay() {
  if (_razorpay) return _razorpay;
  const key_id = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const key_secret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!key_id || !key_secret) {
    const err = new Error('Razorpay is not configured');
    err.statusCode = 503;
    err.code = 'RAZORPAY_NOT_CONFIGURED';
    throw err;
  }
  _razorpay = new Razorpay({ key_id, key_secret });
  return _razorpay;
}

function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ success: false, code, message, ...extra });
}

function ok(res, payload = {}, status = 200) {
  return res.status(status).json({ success: true, ...payload });
}

function addYears(date, years) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + Number(years || 1));
  return d;
}

async function issueTokenPair(dropshipper) {
  const accessToken = signDropshipperAccessToken(dropshipper._id);
  const refreshToken = signDropshipperRefreshToken(dropshipper._id);
  const tokenHash = hashRefreshToken(refreshToken);
  const expiresAt = getRefreshExpiryDate();

  const doc = await Dropshipper.findById(dropshipper._id).select('+refreshTokens');
  if (!doc) throw new Error('Dropshipper not found while issuing tokens');
  doc.refreshTokens = (doc.refreshTokens || []).filter((t) => t.expiresAt && t.expiresAt > new Date());
  doc.refreshTokens.push({ tokenHash, expiresAt, createdAt: new Date() });
  // Cap stored refresh tokens
  if (doc.refreshTokens.length > 10) {
    doc.refreshTokens = doc.refreshTokens.slice(-10);
  }
  doc.lastLoginAt = new Date();
  await doc.save();

  return { accessToken, refreshToken, dropshipper: doc };
}

async function blacklistAccessToken(token) {
  if (!token) return;
  const ttl = getAccessTtlSeconds();
  try {
    const redis = redisManager.getRedisClient();
    if (redis) {
      await redis.set(`bl_${token}`, '1');
      if (ttl > 0) await redis.expire(`bl_${token}`, ttl);
      return;
    }
  } catch {
    /* fallback */
  }
  tokenStore.add(token, ttl);
}

/** GET /auth/subscription-settings */
exports.getSubscriptionSettings = async (req, res) => {
  try {
    const settings = await getSettings();
    return ok(res, { settings: settings.toPublicSettings() });
  } catch (error) {
    return fail(res, 500, 'SETTINGS_FETCH_FAILED', error.message || 'Failed to load settings');
  }
};

/** POST /auth/register/start — validate applicant + fee JSON (no payment yet). */
exports.registerStart = async (req, res) => {
  try {
    const settings = await getSettings();
    if (settings.registrationOpen === false) {
      return fail(res, 403, 'REGISTRATION_CLOSED', 'Dropshipper registration is currently closed');
    }

    const body = resolveRegistrationRequestBody(req);
    const validated = validateRegistrationApplicant(body);
    if (!validated.ok) {
      return fail(res, 400, validated.code, validated.message, { errors: validated.errors });
    }

    const existing = await Dropshipper.findOne({
      $or: [{ email: validated.data.email }, { phone: validated.data.phone }]
    }).lean();
    if (existing && ['active', 'pending_otp', 'pending_admin', 'expired', 'suspended'].includes(existing.status)) {
      return fail(res, 409, 'ACCOUNT_EXISTS', 'A dropshipper account already exists for this email or phone');
    }

    const pendingPaid = await DropshipperRegistrationRequest.findOne({
      kind: 'registration',
      adminStatus: 'pending',
      paymentStatus: 'paid',
      $or: [{ email: validated.data.email }, { phone: validated.data.phone }]
    }).lean();
    if (pendingPaid) {
      return ok(res, {
        message: 'Registration payment already completed — awaiting admin approval',
        requestId: String(pendingPaid._id),
        alreadyPaid: true,
        settings: settings.toPublicSettings(),
        applicant: validated.data
      });
    }

    return ok(res, {
      message: 'Applicant validated — proceed to create-payment',
      settings: settings.toPublicSettings(),
      fee: {
        subscriptionAmountInr: settings.subscriptionAmountInr,
        subscriptionYears: 1
      },
      applicant: validated.data
    });
  } catch (error) {
    return fail(res, 500, 'REGISTER_START_FAILED', error.message || 'Registration start failed');
  }
};

/** POST /auth/register/create-payment — multipart + proofs → Razorpay order on request doc. */
exports.registerCreatePayment = async (req, res) => {
  try {
    const settings = await getSettings();
    if (settings.registrationOpen === false) {
      return fail(res, 403, 'REGISTRATION_CLOSED', 'Dropshipper registration is currently closed');
    }

    const body = resolveRegistrationRequestBody(req);
    const validated = validateRegistrationApplicant(body);
    if (!validated.ok) {
      return fail(res, 400, validated.code, validated.message, { errors: validated.errors });
    }

    if (!String(process.env.RAZORPAY_KEY_ID || '').trim() || !String(process.env.RAZORPAY_KEY_SECRET || '').trim()) {
      return fail(res, 503, 'RAZORPAY_NOT_CONFIGURED', 'Registration payment is temporarily unavailable');
    }

    const existingAccount = await Dropshipper.findOne({
      $or: [{ email: validated.data.email }, { phone: validated.data.phone }],
      status: { $in: ['active', 'pending_otp', 'pending_admin', 'expired', 'suspended'] }
    }).lean();
    if (existingAccount) {
      return fail(res, 409, 'ACCOUNT_EXISTS', 'A dropshipper account already exists for this email or phone');
    }

    let proofs;
    try {
      proofs = await uploadRegistrationProofs(req.files, validated.data.email);
    } catch (uploadErr) {
      return fail(res, 400, 'PROOF_UPLOAD_FAILED', uploadErr.message || 'Proof upload failed');
    }

    if (!proofs.idProofUrl) {
      return fail(res, 400, 'ID_PROOF_REQUIRED', 'idProof file is required');
    }

    const feeInr = Number(settings.subscriptionAmountInr) || 800;
    let request = await DropshipperRegistrationRequest.findOne({
      kind: 'registration',
      email: validated.data.email,
      phone: validated.data.phone,
      adminStatus: 'pending',
      paymentStatus: { $in: ['pending', 'created'] }
    }).sort({ createdAt: -1 });

    if (!request) {
      request = new DropshipperRegistrationRequest({
        kind: 'registration',
        adminStatus: 'pending',
        paymentStatus: 'pending'
      });
    }

    Object.assign(request, {
      ...validated.data,
      idProofUrl: proofs.idProofUrl || request.idProofUrl,
      idProofPublicId: proofs.idProofPublicId || request.idProofPublicId,
      businessAddressProofUrl: proofs.businessAddressProofUrl || request.businessAddressProofUrl,
      businessAddressProofPublicId: proofs.businessAddressProofPublicId || request.businessAddressProofPublicId,
      subscriptionAmountInr: feeInr,
      subscriptionYears: 1
    });

    if (request.paymentStatus === 'paid') {
      return ok(res, {
        message: 'Registration payment already completed',
        alreadyPaid: true,
        requestId: String(request._id),
        request: { id: request._id, paymentStatus: request.paymentStatus, adminStatus: request.adminStatus }
      });
    }

    const amountPaise = Math.round(feeInr * 100);
    const order = await getRazorpay().orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `dsreg-${String(request._id || 'new').slice(-12)}-${Date.now().toString(36)}`.slice(0, 40),
      payment_capture: 1,
      notes: {
        type: 'dropshipper_registration',
        email: validated.data.email,
        phone: validated.data.phone
      }
    });

    request.paymentStatus = 'created';
    request.razorpayOrderId = order.id;
    request.paymentMeta = {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      initiatedAt: new Date()
    };
    await request.save();

    // Attach requestId to razorpay notes via a second notes write isn't possible — store on doc.
    return ok(res, {
      message: 'Registration payment order created',
      requestId: String(request._id),
      amountInr: feeInr,
      razorpayKeyId: String(process.env.RAZORPAY_KEY_ID || '').trim(),
      razorpayOrder: {
        id: order.id,
        amount: order.amount,
        currency: order.currency
      },
      request: {
        id: request._id,
        paymentStatus: request.paymentStatus,
        adminStatus: request.adminStatus
      }
    });
  } catch (error) {
    return fail(res, 500, 'REGISTER_CREATE_PAYMENT_FAILED', error.message || 'Failed to create registration payment');
  }
};

/** POST /auth/register/verify-payment */
exports.registerVerifyPayment = async (req, res) => {
  try {
    const requestId = String(req.body.requestId || req.body.request_id || '').trim();
    const razorpayOrderId = String(req.body.razorpay_order_id || '').trim();
    const razorpayPaymentId = String(req.body.razorpay_payment_id || '').trim();
    const razorpaySignature = String(req.body.razorpay_signature || '').trim();

    if (!requestId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return fail(
        res,
        400,
        'INVALID_PAYMENT_VERIFY_PAYLOAD',
        'requestId, razorpay_order_id, razorpay_payment_id and razorpay_signature are required'
      );
    }

    const doc = await DropshipperRegistrationRequest.findById(requestId);
    if (!doc || doc.kind !== 'registration') {
      return fail(res, 404, 'REQUEST_NOT_FOUND', 'Registration request not found');
    }

    if (doc.paymentStatus === 'paid') {
      return ok(res, {
        message: 'Payment already verified — awaiting admin approval',
        alreadyPaid: true,
        requestId: String(doc._id),
        request: {
          id: doc._id,
          paymentStatus: doc.paymentStatus,
          adminStatus: doc.adminStatus
        }
      });
    }

    if (!String(process.env.RAZORPAY_KEY_SECRET || '').trim()) {
      return fail(res, 503, 'RAZORPAY_NOT_CONFIGURED', 'Payment verification unavailable');
    }

    if (doc.razorpayOrderId && doc.razorpayOrderId !== razorpayOrderId) {
      return fail(res, 409, 'PAYMENT_ORDER_MISMATCH', 'Payment order does not match this registration');
    }

    const expectedSignature = crypto
      .createHmac('sha256', String(process.env.RAZORPAY_KEY_SECRET || '').trim())
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');
    if (expectedSignature !== razorpaySignature) {
      return fail(res, 400, 'PAYMENT_SIGNATURE_INVALID', 'Payment signature verification failed');
    }

    const [payment, order] = await Promise.all([
      getRazorpay().payments.fetch(razorpayPaymentId),
      getRazorpay().orders.fetch(razorpayOrderId)
    ]);

    if (!['authorized', 'captured'].includes(String(payment.status || '').toLowerCase())) {
      return fail(res, 409, 'PAYMENT_NOT_CAPTURED', 'Registration payment is not completed yet');
    }
    if (String(payment.order_id || '') !== razorpayOrderId) {
      return fail(res, 409, 'PAYMENT_ORDER_MISMATCH', 'Razorpay payment does not belong to this order');
    }

    const expectedAmountPaise = Math.round(Number(doc.subscriptionAmountInr) * 100);
    if (Number(order.amount) !== expectedAmountPaise || Number(payment.amount) !== expectedAmountPaise) {
      return fail(res, 409, 'PAYMENT_AMOUNT_MISMATCH', 'Registration payment amount mismatch');
    }

    doc.paymentStatus = 'paid';
    doc.adminStatus = 'pending';
    doc.razorpayOrderId = razorpayOrderId;
    doc.razorpayPaymentId = razorpayPaymentId;
    doc.razorpaySignature = razorpaySignature;
    doc.paidAt = new Date();
    doc.paymentMeta = {
      ...(doc.paymentMeta || {}),
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      paymentStatus: payment.status,
      method: payment.method || null,
      captured: payment.captured === true
    };
    await doc.save();

    return ok(res, {
      message: 'Payment verified — awaiting admin approval',
      requestId: String(doc._id),
      request: {
        id: doc._id,
        paymentStatus: doc.paymentStatus,
        adminStatus: doc.adminStatus,
        paidAt: doc.paidAt
      }
    });
  } catch (error) {
    return fail(res, 500, 'REGISTER_VERIFY_PAYMENT_FAILED', error.message || 'Payment verification failed');
  }
};

/** GET /auth/register/status/:requestId?email=&phone= */
exports.registerStatus = async (req, res) => {
  try {
    const requestId = String(req.params.requestId || '').trim();
    const email = normalizeEmail(req.query.email || '');
    const phone = normalizeIndianMobile(req.query.phone || '');

    if (!requestId) {
      return fail(res, 400, 'REQUEST_ID_REQUIRED', 'requestId is required');
    }

    const doc = await DropshipperRegistrationRequest.findById(requestId).lean();
    if (!doc) {
      return fail(res, 404, 'REQUEST_NOT_FOUND', 'Registration request not found');
    }

    if (email && doc.email !== email) {
      return fail(res, 403, 'REQUEST_ACCESS_DENIED', 'Email does not match this request');
    }
    if (phone && doc.phone !== phone) {
      return fail(res, 403, 'REQUEST_ACCESS_DENIED', 'Phone does not match this request');
    }

    let dropshipperStatus = null;
    if (doc.dropshipperId) {
      const ds = await Dropshipper.findById(doc.dropshipperId).select('status').lean();
      dropshipperStatus = ds?.status || null;
    }

    return ok(res, {
      requestId: String(doc._id),
      kind: doc.kind,
      adminStatus: doc.adminStatus,
      paymentStatus: doc.paymentStatus,
      paidAt: doc.paidAt || null,
      approvedAt: doc.approvedAt || null,
      rejectedAt: doc.rejectedAt || null,
      dropshipperStatus,
      canActivate: doc.adminStatus === 'approved' && dropshipperStatus === 'pending_otp'
    });
  } catch (error) {
    return fail(res, 500, 'REGISTER_STATUS_FAILED', error.message || 'Failed to load status');
  }
};

/** POST /auth/activate/send-otp { email } OR { phone } */
exports.activateSendOtp = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email || '');
    const phone = normalizeIndianMobile(req.body.phone || req.body.mobileNumber || '');
    if (!email && !phone) {
      return fail(res, 400, 'IDENTIFIER_REQUIRED', 'email or phone is required');
    }

    const query = email ? { email } : { phone };
    const doc = await Dropshipper.findOne(query).select('+otpHash');
    if (!doc) {
      return fail(res, 404, 'DROPSHIPPER_NOT_FOUND', 'No dropshipper account found for activation');
    }
    if (doc.status === 'rejected' || doc.status === 'suspended') {
      return fail(res, 403, 'ACCOUNT_BLOCKED', `Account is ${doc.status}`);
    }
    if (doc.status === 'active' && doc.passwordSetAt) {
      return fail(res, 409, 'ALREADY_ACTIVATED', 'Account is already activated — please login');
    }
    if (doc.status !== 'pending_otp' && doc.status !== 'active') {
      return fail(res, 409, 'NOT_READY_FOR_OTP', `Account status is ${doc.status}`);
    }

    const otp = generateOTP();
    doc.otpHash = hashOtp(otp);
    doc.otpExpiresAt = new Date(Date.now() + OTP_TTL_MS);
    doc.otpAttempts = 0;
    doc.otpSentAt = new Date();
    await doc.save();

    try {
      await deliverOtpFor({
        phone: doc.phone,
        email: doc.email,
        otp,
        purpose: 'dropshipper_activation'
      });
    } catch (deliverErr) {
      return fail(res, 502, 'OTP_SEND_FAILED', 'Could not send activation OTP. Please try again.');
    }

    return ok(res, {
      message: 'Activation OTP sent successfully',
      email: doc.email,
      phone: doc.phone
    });
  } catch (error) {
    return fail(res, 500, 'OTP_SEND_FAILED', error.message || 'Failed to send OTP');
  }
};

/** POST /auth/activate/complete { email|phone, otp, password } */
exports.activateComplete = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email || '');
    const phone = normalizeIndianMobile(req.body.phone || req.body.mobileNumber || '');
    const otp = String(req.body.otp || '').trim();
    const passwordCheck = validatePassword(req.body.password);

    if ((!email && !phone) || !otp || !passwordCheck.ok) {
      return fail(
        res,
        400,
        'INVALID_ACTIVATION_PAYLOAD',
        passwordCheck.ok
          ? 'email|phone, otp and password are required'
          : passwordCheck.message
      );
    }

    const query = email ? { email } : { phone };
    const doc = await Dropshipper.findOne(query).select('+otpHash +passwordHash');
    if (!doc) {
      return fail(res, 404, 'DROPSHIPPER_NOT_FOUND', 'No dropshipper account found');
    }
    if (doc.status === 'rejected' || doc.status === 'suspended') {
      return fail(res, 403, 'ACCOUNT_BLOCKED', `Account is ${doc.status}`);
    }
    if (!doc.otpHash || !doc.otpExpiresAt || new Date() > doc.otpExpiresAt) {
      return fail(res, 400, 'OTP_EXPIRED_OR_MISSING', 'OTP expired or not requested');
    }
    if ((doc.otpAttempts || 0) >= MAX_OTP_ATTEMPTS) {
      return fail(res, 429, 'OTP_MAX_ATTEMPTS_EXCEEDED', 'Too many invalid attempts. Request OTP again.');
    }

    if (hashOtp(otp) !== doc.otpHash) {
      doc.otpAttempts = (doc.otpAttempts || 0) + 1;
      await doc.save();
      return fail(res, 400, 'OTP_INVALID', 'Invalid OTP');
    }

    const settings = await getSettings();
    const years = 1;
    const amount = Number(doc.subscription?.amountPaidInr) || Number(settings.subscriptionAmountInr) || 800;
    const startsAt = new Date();
    const endsAt = addYears(startsAt, years);

    await doc.setPassword(passwordCheck.password);
    doc.status = 'active';
    doc.subscription = {
      startsAt,
      endsAt,
      amountPaidInr: amount,
      planYears: years,
      renewedAt: doc.subscription?.renewedAt || null
    };
    doc.otpHash = null;
    doc.otpExpiresAt = null;
    doc.otpAttempts = 0;
    await doc.save();

    const tokens = await issueTokenPair(doc);
    return ok(res, {
      message: 'Account activated successfully',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      dropshipper: tokens.dropshipper.toSafeJSON()
    });
  } catch (error) {
    return fail(res, 500, 'ACTIVATION_FAILED', error.message || 'Activation failed');
  }
};

/** POST /auth/login */
exports.login = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email || '');
    const phone = normalizeIndianMobile(req.body.phone || req.body.mobileNumber || '');
    const password = String(req.body.password || '');

    if ((!email && !phone) || !password) {
      return fail(res, 400, 'INVALID_LOGIN_PAYLOAD', 'email|phone and password are required');
    }

    const query = email ? { email } : { phone };
    const doc = await Dropshipper.findOne(query).select('+passwordHash');
    if (!doc) {
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }
    if (doc.status === 'suspended' || doc.status === 'rejected') {
      return fail(res, 403, 'ACCOUNT_BLOCKED', `Account is ${doc.status}`);
    }
    if (doc.status === 'pending_otp' || !doc.passwordSetAt) {
      return fail(res, 403, 'ACCOUNT_PENDING_OTP', 'Complete OTP activation before login');
    }

    const valid = await doc.comparePassword(password);
    if (!valid) {
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }

    if (doc.status === 'active' && !doc.hasActiveSubscription()) {
      doc.status = 'expired';
      await doc.save();
    }

    const tokens = await issueTokenPair(doc);
    return ok(res, {
      message: 'Login successful',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      dropshipper: tokens.dropshipper.toSafeJSON()
    });
  } catch (error) {
    return fail(res, 500, 'LOGIN_FAILED', error.message || 'Login failed');
  }
};

/** POST /auth/refresh */
exports.refresh = async (req, res) => {
  try {
    const refreshToken = String(req.body.refreshToken || req.body.refresh_token || '').trim();
    if (!refreshToken) {
      return fail(res, 400, 'REFRESH_TOKEN_REQUIRED', 'refreshToken is required');
    }

    let decoded;
    try {
      decoded = verifyDropshipperRefreshToken(refreshToken);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return fail(res, 401, 'REFRESH_TOKEN_EXPIRED', 'Refresh token expired');
      }
      return fail(res, 401, 'INVALID_REFRESH_TOKEN', 'Invalid refresh token');
    }

    const tokenHash = hashRefreshToken(refreshToken);
    const doc = await Dropshipper.findById(decoded.id).select('+refreshTokens +passwordHash');
    if (!doc) {
      return fail(res, 401, 'DROPSHIPPER_NOT_FOUND', 'Dropshipper not found');
    }

    const entry = (doc.refreshTokens || []).find((t) => t.tokenHash === tokenHash);
    if (!entry || !entry.expiresAt || entry.expiresAt <= new Date()) {
      return fail(res, 401, 'REFRESH_TOKEN_INVALID', 'Refresh token is not recognized');
    }

    // Rotate
    doc.refreshTokens = (doc.refreshTokens || []).filter((t) => t.tokenHash !== tokenHash);
    await doc.save();

    const tokens = await issueTokenPair(doc);
    return ok(res, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      token: tokens.accessToken,
      dropshipper: tokens.dropshipper.toSafeJSON()
    });
  } catch (error) {
    return fail(res, 500, 'REFRESH_FAILED', error.message || 'Token refresh failed');
  }
};

/** GET /auth/me */
exports.me = async (req, res) => {
  try {
    if (req.dropshipperBypass && !req.dropshipper) {
      return ok(res, {
        bypass: true,
        dropshipper: null,
        message: 'Staff bypass session (non-production)'
      });
    }
    if (!req.dropshipper) {
      return fail(res, 401, 'DROPSHIPPER_AUTH_REQUIRED', 'Not authenticated');
    }
    return ok(res, { dropshipper: req.dropshipper.toSafeJSON() });
  } catch (error) {
    return fail(res, 500, 'ME_FAILED', error.message || 'Failed to load profile');
  }
};

/** POST /auth/logout */
exports.logout = async (req, res) => {
  try {
    const accessToken = extractBearer(req) || req.dropshipperAccessToken;
    if (accessToken) {
      await blacklistAccessToken(accessToken);
    }

    const refreshToken = String(req.body.refreshToken || req.body.refresh_token || '').trim();
    if (refreshToken && req.dropshipperId) {
      const tokenHash = hashRefreshToken(refreshToken);
      await Dropshipper.updateOne(
        { _id: req.dropshipperId },
        { $pull: { refreshTokens: { tokenHash } } }
      );
    }

    return ok(res, { message: 'Logged out successfully' });
  } catch (error) {
    return fail(res, 500, 'LOGOUT_FAILED', error.message || 'Logout failed');
  }
};

/** POST /auth/renew/create-payment — Bearer */
exports.renewCreatePayment = async (req, res) => {
  try {
    const ds = req.dropshipper;
    if (!ds) {
      return fail(res, 401, 'DROPSHIPPER_AUTH_REQUIRED', 'Not authenticated');
    }
    if (!String(process.env.RAZORPAY_KEY_ID || '').trim() || !String(process.env.RAZORPAY_KEY_SECRET || '').trim()) {
      return fail(res, 503, 'RAZORPAY_NOT_CONFIGURED', 'Renewal payment unavailable');
    }

    const settings = await getSettings();
    const feeInr = Number(settings.subscriptionAmountInr) || 800;

    const request = await DropshipperRegistrationRequest.create({
      kind: 'renewal',
      adminStatus: 'pending',
      paymentStatus: 'pending',
      fullName: ds.fullName,
      email: ds.email,
      phone: ds.phone,
      businessName: ds.businessName,
      whatsappNumber: ds.whatsappNumber,
      permanentAddress: ds.application?.permanentAddress || 'N/A',
      haveShop: Boolean(ds.application?.haveShop),
      businessAddress: ds.application?.businessAddress || null,
      deliveryAddress: ds.application?.deliveryAddress || null,
      sellingPlaceFrom: ds.application?.sellingPlaceFrom || null,
      sellingZoneCity: ds.application?.sellingZoneCity || null,
      productCategory: ds.application?.productCategory || null,
      monthlyEstimatedPurchase: ds.application?.monthlyEstimatedPurchase ?? null,
      idProofUrl: ds.application?.idProofUrl || null,
      businessAddressProofUrl: ds.application?.businessAddressProofUrl || null,
      subscriptionAmountInr: feeInr,
      subscriptionYears: 1,
      dropshipperId: ds._id
    });

    const amountPaise = Math.round(feeInr * 100);
    const order = await getRazorpay().orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `dsren-${String(request._id).slice(-12)}-${Date.now().toString(36)}`.slice(0, 40),
      payment_capture: 1,
      notes: {
        type: 'dropshipper_renewal',
        requestId: String(request._id),
        dropshipperId: String(ds._id)
      }
    });

    request.paymentStatus = 'created';
    request.razorpayOrderId = order.id;
    request.paymentMeta = { orderId: order.id, amount: order.amount, currency: order.currency };
    await request.save();

    return ok(res, {
      message: 'Renewal payment order created',
      requestId: String(request._id),
      amountInr: feeInr,
      razorpayKeyId: String(process.env.RAZORPAY_KEY_ID || '').trim(),
      razorpayOrder: {
        id: order.id,
        amount: order.amount,
        currency: order.currency
      }
    });
  } catch (error) {
    return fail(res, 500, 'RENEW_CREATE_PAYMENT_FAILED', error.message || 'Failed to create renewal payment');
  }
};

/** POST /auth/renew/verify-payment — Bearer; extends endsAt on success (no admin gate). */
exports.renewVerifyPayment = async (req, res) => {
  try {
    const ds = req.dropshipper;
    if (!ds) {
      return fail(res, 401, 'DROPSHIPPER_AUTH_REQUIRED', 'Not authenticated');
    }

    const requestId = String(req.body.requestId || req.body.request_id || '').trim();
    const razorpayOrderId = String(req.body.razorpay_order_id || '').trim();
    const razorpayPaymentId = String(req.body.razorpay_payment_id || '').trim();
    const razorpaySignature = String(req.body.razorpay_signature || '').trim();

    if (!requestId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return fail(
        res,
        400,
        'INVALID_PAYMENT_VERIFY_PAYLOAD',
        'requestId, razorpay_order_id, razorpay_payment_id and razorpay_signature are required'
      );
    }

    const doc = await DropshipperRegistrationRequest.findById(requestId);
    if (!doc || doc.kind !== 'renewal') {
      return fail(res, 404, 'REQUEST_NOT_FOUND', 'Renewal request not found');
    }
    if (String(doc.dropshipperId) !== String(ds._id)) {
      return fail(res, 403, 'REQUEST_ACCESS_DENIED', 'Renewal request does not belong to this account');
    }

    if (doc.paymentStatus === 'paid' && doc.adminStatus === 'approved') {
      const fresh = await Dropshipper.findById(ds._id);
      return ok(res, {
        message: 'Renewal already verified',
        alreadyPaid: true,
        dropshipper: fresh.toSafeJSON()
      });
    }

    const expectedSignature = crypto
      .createHmac('sha256', String(process.env.RAZORPAY_KEY_SECRET || '').trim())
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');
    if (expectedSignature !== razorpaySignature) {
      return fail(res, 400, 'PAYMENT_SIGNATURE_INVALID', 'Payment signature verification failed');
    }

    const [payment, order] = await Promise.all([
      getRazorpay().payments.fetch(razorpayPaymentId),
      getRazorpay().orders.fetch(razorpayOrderId)
    ]);
    if (!['authorized', 'captured'].includes(String(payment.status || '').toLowerCase())) {
      return fail(res, 409, 'PAYMENT_NOT_CAPTURED', 'Renewal payment is not completed yet');
    }
    if (String(payment.order_id || '') !== razorpayOrderId) {
      return fail(res, 409, 'PAYMENT_ORDER_MISMATCH', 'Payment does not belong to this order');
    }
    const expectedAmountPaise = Math.round(Number(doc.subscriptionAmountInr) * 100);
    if (Number(order.amount) !== expectedAmountPaise || Number(payment.amount) !== expectedAmountPaise) {
      return fail(res, 409, 'PAYMENT_AMOUNT_MISMATCH', 'Renewal payment amount mismatch');
    }

    const account = await Dropshipper.findById(ds._id);
    const now = new Date();
    const base =
      account.subscription?.endsAt && new Date(account.subscription.endsAt) > now
        ? new Date(account.subscription.endsAt)
        : now;
    const endsAt = addYears(base, 1);
    const startsAt = account.subscription?.startsAt || now;

    account.subscription = {
      startsAt,
      endsAt,
      amountPaidInr: Number(doc.subscriptionAmountInr),
      planYears: 1,
      renewedAt: now
    };
    account.status = 'active';
    await account.save();

    doc.paymentStatus = 'paid';
    doc.adminStatus = 'approved';
    doc.razorpayOrderId = razorpayOrderId;
    doc.razorpayPaymentId = razorpayPaymentId;
    doc.razorpaySignature = razorpaySignature;
    doc.paidAt = now;
    doc.approvedAt = now;
    doc.paymentMeta = {
      ...(doc.paymentMeta || {}),
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
      paymentStatus: payment.status
    };
    await doc.save();

    return ok(res, {
      message: 'Subscription renewed successfully',
      dropshipper: account.toSafeJSON(),
      requestId: String(doc._id)
    });
  } catch (error) {
    return fail(res, 500, 'RENEW_VERIFY_PAYMENT_FAILED', error.message || 'Renewal verification failed');
  }
};

module.exports.isTokenBlacklisted = isTokenBlacklisted;
