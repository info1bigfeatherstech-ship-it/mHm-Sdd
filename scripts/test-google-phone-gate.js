/**
 * Google phone-gate helpers — unit checks (no DB).
 * Run: node scripts/test-google-phone-gate.js
 */
const assert = require('assert');
const {
  normalizeIndianMobile,
  isValidIndianMobile,
  hasUsableCustomerPhone
} = require('../utils/indianMobile');
const {
  getGoogleAudiences,
  toVerifyAudience,
  splitList
} = require('../utils/googleAuthAudience');
const { buildPublicAuthUser } = require('../utils/authUserPayload');
const {
  extractRequestedPhone,
  canSetFirstTimeCustomerPhone
} = require('../services/completeCustomerPhone.service');
const {
  isPhoneGatePath,
  normalizeRequestPath
} = require('../middlewares/require-complete-phone.middleware');

function testIndianMobile() {
  assert.strictEqual(normalizeIndianMobile('9845476897'), '9845476897');
  assert.strictEqual(normalizeIndianMobile('+91 98454 76897'), '9845476897');
  assert.strictEqual(normalizeIndianMobile('919845476897'), '9845476897');
  assert.strictEqual(normalizeIndianMobile('09845476897'), '9845476897');
  assert.strictEqual(isValidIndianMobile('9845476897'), true);
  assert.strictEqual(isValidIndianMobile('1845476897'), false);
  assert.strictEqual(isValidIndianMobile('98454'), false);
  assert.strictEqual(hasUsableCustomerPhone(''), false);
  assert.strictEqual(hasUsableCustomerPhone(null), false);
}

function testGoogleAudiences() {
  const audiences = getGoogleAudiences({
    GOOGLE_CLIENT_ID: 'id-a.apps.googleusercontent.com',
    GOOGLE_WEB_CLIENT_ID: 'id-a.apps.googleusercontent.com',
    GOOGLE_CLIENT_IDS: 'id-b.apps.googleusercontent.com, id-c.apps.googleusercontent.com'
  });
  assert.deepStrictEqual(audiences, [
    'id-a.apps.googleusercontent.com',
    'id-b.apps.googleusercontent.com',
    'id-c.apps.googleusercontent.com'
  ]);
  assert.strictEqual(toVerifyAudience([]), null);
  assert.strictEqual(toVerifyAudience(['only']), 'only');
  assert.deepStrictEqual(toVerifyAudience(['a', 'b']), ['a', 'b']);
  assert.deepStrictEqual(splitList('x, y  z'), ['x', 'y', 'z']);
  assert.deepStrictEqual(getGoogleAudiences({ GOOGLE_CLIENT_ID: 'NO_CLIENT_ID_SET' }), []);
}

function testAuthUserPayload() {
  const withPhone = buildPublicAuthUser({
    _id: 'u1',
    email: 'a@b.com',
    name: 'A',
    phone: '9845476897',
    userType: 'user',
    role: 'user',
    status: 'active',
    isPhoneVerified: true,
    isEmailVerified: true,
    isProfileComplete: false
  });
  assert.strictEqual(withPhone.needsPhone, false);
  assert.strictEqual(withPhone.isProfileComplete, true);
  assert.strictEqual(withPhone.phone, '9845476897');

  const missing = buildPublicAuthUser({
    _id: 'u2',
    email: 'g@b.com',
    name: 'G',
    userType: 'user',
    role: 'user',
    status: 'active',
    isPhoneVerified: false,
    isEmailVerified: true
  });
  assert.strictEqual(missing.needsPhone, true);
  assert.strictEqual(missing.isProfileComplete, false);
  assert.strictEqual(missing.phone, null);
}

function testPhoneExtractionAndGate() {
  const extracted = extractRequestedPhone({
    phone: '9845476897',
    mobile: '9845476897',
    phoneNumber: '+919845476897'
  });
  assert.strictEqual(extracted.provided, true);
  assert.strictEqual(extracted.raw, '9845476897');
  const fromPrefixed = extractRequestedPhone({
    phone: '',
    phoneNumber: '+919845476897'
  });
  assert.strictEqual(fromPrefixed.provided, true);
  assert.strictEqual(fromPrefixed.raw, '+919845476897');
  assert.strictEqual(extractRequestedPhone({ name: 'A' }).provided, false);

  assert.strictEqual(canSetFirstTimeCustomerPhone({ userType: 'user', role: 'user' }), true);
  assert.strictEqual(canSetFirstTimeCustomerPhone({ userType: 'admin', role: 'admin' }), false);
  assert.strictEqual(canSetFirstTimeCustomerPhone({ userType: 'wholesaler' }), false);

  assert.strictEqual(isPhoneGatePath('/api/cart'), true);
  assert.strictEqual(isPhoneGatePath('/api/cart/merge'), true);
  assert.strictEqual(isPhoneGatePath('/api/checkout/confirm'), true);
  assert.strictEqual(isPhoneGatePath('/api/auth/profile'), false);
  assert.strictEqual(isPhoneGatePath('/api/auth/me'), false);
  assert.strictEqual(isPhoneGatePath('/api/products'), false);
  assert.strictEqual(isPhoneGatePath('/api/admin/orders'), false);
  assert.strictEqual(normalizeRequestPath({ originalUrl: '/api/cart/merge?x=1' }), '/api/cart/merge');
}

testIndianMobile();
testGoogleAudiences();
testAuthUserPayload();
testPhoneExtractionAndGate();
console.log('test-google-phone-gate: ok');
