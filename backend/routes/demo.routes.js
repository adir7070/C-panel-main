const router = require('express').Router();
const { getDemoAds, saveDemoAds } = require('../controllers/demo.controller');

router.get('/ads', getDemoAds);
router.put('/ads', saveDemoAds);

module.exports = router;
