const { hasUsableCustomerPhone } = require('./indianMobile');

function buildPublicAuthUser(user) {
  const phone = hasUsableCustomerPhone(user?.phone) ? String(user.phone).trim() : null;
  return {
    id: user._id,
    email: user.email || null,
    name: user.name || '',
    phone,
    userType: user.userType,
    role: user.role || user.userType,
    status: user.status,
    isPhoneVerified: Boolean(user.isPhoneVerified),
    isEmailVerified: Boolean(user.isEmailVerified),
    isProfileComplete: Boolean(phone),
    needsPhone: !phone
  };
}

module.exports = {
  buildPublicAuthUser
};
