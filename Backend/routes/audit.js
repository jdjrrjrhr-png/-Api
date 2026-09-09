'use strict';

const express = require('express');
const router  = express.Router();
const { auditLogs, pushAuditLog } = require('../state');
const { verifyServerAdmin } = require('../middleware/auth');

router.get('/:serverCode', verifyServerAdmin, (req, res) => {
    const { serverCode } = req.params;
    const types = req.query.types ? req.query.types.split(',') : null;

    let logs = auditLogs[serverCode] || [];
    if (types && types.length > 0) logs = logs.filter(l => types.includes(l.type));

    res.json({ logs, total: logs.length });
});

router.post('/:serverCode', verifyServerAdmin, (req, res) => {
    const { serverCode } = req.params;
    pushAuditLog(serverCode, { ...req.body, source: 'dashboard' });
    res.json({ success: true });
});

router.patch('/:serverCode/:logId', verifyServerAdmin, (req, res) => {
    const { serverCode, logId } = req.params;
    const { revokedByUsername } = req.body;

    const logs = auditLogs[serverCode] || [];
    const entry = logs.find(l => l.id === logId);
    if (!entry) return res.status(404).json({ error: 'Log entry not found' });

    entry.revoked = true;
    entry.revokedBy = req.callerId;
    entry.revokedByUsername = revokedByUsername;
    entry.revokedAt = Date.now();

    res.json({ success: true, entry });
});

module.exports = router;
