/**
 * New products digest web push copy.
 * Click targets (see storefrontFrontendUrl.js):
 * - ecomm:     /#best-sellers
 * - wholesale: /TagProducts/today-arrival
 * Placeholders: {{appName}}
 */
module.exports = {
  title: 'New products on {{appName}}',
  body: 'Explore latest arrivals on {{appName}}.',
  icon: '/pwa-192x192.png',
  badge: '/pwa-192x192.png',
  tag: 'new-products-digest',
  ctaPath: '/#best-sellers',
  wholesaleCtaPath: '/TagProducts/today-arrival',
  ctaLabel: 'Shop New Arrivals',
  actions: [{ action: 'shop-new-arrivals', title: 'Shop New Arrivals' }],
};
