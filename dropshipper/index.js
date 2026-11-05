/**
 * Isolated dropshipping backend module.
 * Mount from server.js only:
 *   app.use('/api/admin/dropshipper', adminDropshipperRoutes);
 *   app.use('/api/dropshipper', dropshipperRoutes);
 */

const adminDropshipperRoutes = require('./routes/adminDropshipProduct.route');
const dropshipperRoutes = require('./routes/dropshipper.route');

module.exports = {
  adminDropshipperRoutes,
  dropshipperRoutes,
  /** Alias matching layout naming */
  adminDropshipProductRoutes: adminDropshipperRoutes
};
