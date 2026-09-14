'use strict';

const express = require('express');
const router = express.Router();
const { bpProtect, bpRequireRole } = require('../../middlewares/bp.middleware');
const { listVendors, getVendorById, updateVendor } = require('../../services/bp-vendors.service');

function err(res, e) { return res.status(e.status || 500).json({ success: false, message: e.message }); }

// GET /api/bp/vendors
router.get('/', ...bpProtect, async (req, res) => {
  try {
    const data = await listVendors(req.bp.tenantId.toString(), req.query);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// GET /api/bp/vendors/:id
router.get('/:id', ...bpProtect, async (req, res) => {
  try {
    const data = await getVendorById(req.bp.tenantId.toString(), req.params.id);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// PATCH /api/bp/vendors/:id
router.patch('/:id', ...bpProtect, bpRequireRole('accountant', 'super_admin'), async (req, res) => {
  try {
    const data = await updateVendor(req.bp.tenantId.toString(), req.params.id, req.body);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

module.exports = router;
