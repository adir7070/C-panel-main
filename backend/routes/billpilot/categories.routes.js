'use strict';

const express = require('express');
const router = express.Router();
const { bpProtect, bpRequireRole } = require('../../middlewares/bp.middleware');
const { listCategories, getCategoryById, createCategory, updateCategory, deleteCategory, seedDefaultCategories } = require('../../services/bp-categories.service');

function err(res, e) { return res.status(e.status || 500).json({ success: false, message: e.message }); }

// GET /api/bp/categories
router.get('/', ...bpProtect, async (req, res) => {
  try {
    const data = await listCategories(req.bp.tenantId.toString());
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// POST /api/bp/categories/seed  — seed default categories for current tenant
router.post('/seed', ...bpProtect, bpRequireRole('accountant', 'super_admin'), async (req, res) => {
  try {
    const count = await seedDefaultCategories(req.bp.tenantId.toString());
    res.json({ success: true, data: { seeded: count } });
  } catch (e) { err(res, e); }
});

// POST /api/bp/categories
router.post('/', ...bpProtect, bpRequireRole('accountant', 'super_admin'), async (req, res) => {
  try {
    const data = await createCategory(req.bp.tenantId.toString(), req.body);
    res.status(201).json({ success: true, data });
  } catch (e) { err(res, e); }
});

// PATCH /api/bp/categories/:id
router.patch('/:id', ...bpProtect, bpRequireRole('accountant', 'super_admin'), async (req, res) => {
  try {
    const data = await updateCategory(req.bp.tenantId.toString(), req.params.id, req.body);
    res.json({ success: true, data });
  } catch (e) { err(res, e); }
});

// DELETE /api/bp/categories/:id
router.delete('/:id', ...bpProtect, bpRequireRole('accountant', 'super_admin'), async (req, res) => {
  try {
    await deleteCategory(req.bp.tenantId.toString(), req.params.id);
    res.json({ success: true });
  } catch (e) { err(res, e); }
});

module.exports = router;
