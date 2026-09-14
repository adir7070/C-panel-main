'use strict';

const express = require('express');
const router = express.Router();
const { bpProtect, bpRequireRole } = require('../../middlewares/bp.middleware');
const bpClients = require('../../services/bp-clients.service');

function err(res, e) {
  return res.status(e.status || 500).json({ success: false, message: e.message });
}

// GET /api/bp/clients
router.get('/', ...bpProtect, bpRequireRole('accountant', 'team_member', 'super_admin'), async (req, res) => {
  try {
    const data = await bpClients.listClients(req.bp.tenantId, req.bp.user._id);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// GET /api/bp/clients/:id
router.get('/:id', ...bpProtect, bpRequireRole('accountant', 'team_member', 'super_admin'), async (req, res) => {
  try {
    const data = await bpClients.getClientById(req.bp.tenantId, req.params.id, req.bp.user._id);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// PATCH /api/bp/clients/:id
router.patch('/:id', ...bpProtect, bpRequireRole('accountant', 'super_admin'), async (req, res) => {
  try {
    const data = await bpClients.updateClient(req.params.id, req.bp.user._id, req.body);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// DELETE /api/bp/clients/:id
router.delete('/:id', ...bpProtect, bpRequireRole('accountant', 'super_admin'), async (req, res) => {
  try {
    await bpClients.deleteClient(req.params.id, req.bp.user._id);
    res.json({ success: true });
  } catch (e) { err(res, e); }
});

module.exports = router;
