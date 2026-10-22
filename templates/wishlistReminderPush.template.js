/**
 * Wishlist reminder web push copy.
 * Placeholders: {{name}}, {{itemCount}}, {{itemLabel}}, {{appName}}
 */
module.exports = {
  title: 'Your wishlist is waiting',
  body:
    'Hi {{name}}, you have {{itemCount}} {{itemLabel}} saved on {{appName}}. Come back and grab them before they sell out!',
  icon: '/pwa-192x192.png',
  badge: '/pwa-192x192.png',
  tag: 'wishlist-reminder',
  ctaPath: '/account/userwishlist',
};
