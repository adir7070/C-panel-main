const express = require('express');
const router = express.Router();
const { clientError, ingest, query } = require('../controllers/log.controller');

router.post('/client-error', clientError);
router.post('/ingest', ingest);
router.get('/', query);

module.exports = router;
