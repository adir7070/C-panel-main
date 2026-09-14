'use strict';

/**
 * BillPilot master router — mounted at /api/bp
 * All sub-routers use bpProtect (X-Phone auth + tenant injection) internally.
 */

const express = require('express');
const router = express.Router();

router.use('/internal',          require('./internal.routes'));
router.use('/documents',         require('./documents.routes'));
router.use('/clients',           require('./clients.routes'));
router.use('/email-connections', require('./email-connections.routes'));
router.use('/notifications',     require('./notifications.routes'));
router.use('/review-queue',      require('./review-queue.routes'));
router.use('/dashboard',         require('./dashboard.routes'));
router.use('/reports',           require('./reports.routes'));
router.use('/export',            require('./export.routes'));
router.use('/invitations',       require('./invitations.routes'));
router.use('/user-rules',        require('./user-rules.routes'));
router.use('/integrations',      require('./integrations.routes'));
router.use('/users',             require('./users.routes'));
router.use('/categories',        require('./categories.routes'));
router.use('/vendors',           require('./vendors.routes'));

// Keep backward-compat with old /api/billpilot/* routes used by the mobile app
// (provision, documents, dashboard, gmail-auth)
router.post('/provision', require('./internal.routes').stack?.[0]?.route?.stack?.[0]?.handle || ((req, res, next) => {
  req.url = '/provision';
  require('./internal.routes')(req, res, next);
}));

module.exports = router;
