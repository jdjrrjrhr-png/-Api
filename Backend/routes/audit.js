'use strict';

const express = require('express');
const router  = express.Router();
const { auditLogs, pushAuditLog } = require('../state');
const { verifyAdminAccess } = require('../middleware/auth');

/** GET /api/audit/:serverCode — return filtered audit log */
router.get('/:serverCode', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const types = req.query.types ? req.query.types.split(',') : null;

    let logs = auditLogs[serverCode] || [];

    if (types && types.length > 0) {
        logs = logs.filter(l => types.includes(l.type));
    }

    res.json({ logs, total: logs.length });
});

/** POST /api/audit/:serverCode — add entry (from dashboard admin actions) */
router.post('/:serverCode', verifyAdminAccess, (req, res) => {
    const { serverCode } = req.params;
    const entry = req.body;
    pushAuditLog(serverCode, { ...entry, source: 'dashboard' });
    res.json({ success: true });
});

/** PATCH /api/audit/:serverCode/:logId — mark log entry as revoked */
router.patch('/:serverCode/:logId', verifyAdminAccess, (req, res) => {
    const { serverCode, logId } = req.params;
    const { revokedBy, revokedByUsername } = req.body;

    const logs = auditLogs[serverCode] || [];
    const entry = logs.find(l => l.id === logId);
    if (!entry) return res.status(404).json({ error: 'Log entry not found' });

    entry.revoked = true;
    entry.revokedBy = revokedBy;
    entry.revokedByUsername = revokedByUsername;
    entry.revokedAt = Date.now();

    res.json({ success: true, entry });
});

module.exports = router;
