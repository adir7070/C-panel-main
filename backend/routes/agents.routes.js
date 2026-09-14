const express = require('express');
const router = express.Router();
const c = require('../controllers/agents.controller');
const contractPages = require('../controllers/contract-pages.controller');

router.post('/login', c.login);
router.get('/me', c.getMe);

// Named sub-routes MUST be before /:id to avoid conflict
router.get('/stats', c.getStats);
router.get('/stations', c.getStations);
router.post('/stations', c.createStation);
router.put('/stations/:id', c.updateStation);
router.delete('/stations/:id', c.deleteStation);

// Drive upload for chat messages
router.post('/drive/upload', c.driveUploadMessageFile);
// Drive check-and-upload: checks if file exists in folder before uploading
router.post('/drive/check-upload', c.driveCheckAndUpload);
// Drive connection test — GET /api/agents/drive/test?driveUrl=https://drive.google.com/...
router.get('/drive/test', c.driveTest);

// User avatar from Backblaze
router.get('/user-avatar', c.getUserAvatar);

// Users (clients from support_chats)
router.get('/users', c.getUsers);
router.put('/users/:id', c.updateUser);
router.put('/users/:id/assign-manager', c.assignManager);
router.delete('/users/:id', c.deleteUser);

// Canned templates
router.get('/templates', c.getTemplates);
router.post('/templates', c.createTemplate);
router.put('/templates/:id', c.updateTemplate);
router.delete('/templates/:id', c.deleteTemplate);

// Custom roles CRUD
router.get('/roles', c.getRoles);
router.post('/roles', c.createRole);
router.put('/roles/:id', c.updateRole);
router.delete('/roles/:id', c.deleteRole);

// Contract pages admin — documents, rules
router.get   ('/contract-pages/available',              contractPages.available);
router.put   ('/contract-pages/available/:file/name',   contractPages.nameDocument);
router.put   ('/contract-pages/available/:file/always', contractPages.toggleAlways);
router.put   ('/contract-pages/available/:file/replace',contractPages.uploadMiddleware, contractPages.replaceDocument);
router.delete('/contract-pages/available/:file',        contractPages.deleteDocument);
router.post  ('/contract-pages/upload',                 contractPages.uploadMiddleware, contractPages.uploadDocument);
router.get   ('/contract-pages/products',            contractPages.products);
router.post  ('/contract-pages/products',            contractPages.createProduct);
router.put   ('/contract-pages/products/:key',       contractPages.updateProduct);
router.delete('/contract-pages/products/:key',       contractPages.deleteProduct);
router.get   ('/contract-pages/rules',               contractPages.listRules);
router.post  ('/contract-pages/rules',               contractPages.createRule);
router.put   ('/contract-pages/rules/:id',           contractPages.updateRule);
router.delete('/contract-pages/rules/:id',           contractPages.deleteRule);

// List all files stored in Backblaze (contract_doc_names with storageUrl)
router.get   ('/contract-pages/storage',             contractPages.storageList);
// Sync local PNG pages to Backblaze — run from AWS server to populate storageUrls
router.post  ('/contract-pages/sync-to-backblaze',   contractPages.syncToBackblaze);

// Portfolio / works catalog
router.get   ('/contract-pages/portfolio',           contractPages.listPortfolio);
router.post  ('/contract-pages/portfolio',           contractPages.addPortfolio);
router.delete('/contract-pages/portfolio/:id',       contractPages.deletePortfolio);
/* Public screenshot proxy for the works-catalog cards. Uses Puppeteer
   server-side and disk-caches the result so the page loads instantly
   once a URL has been captured at least once. */
router.get   ('/contract-pages/site-screenshot',     contractPages.siteScreenshot);

// Managed clients (portfolio-manager assigned) — used by מנהלי תיק page + sidebar filter
router.get('/managed-clients', c.getManagedClients);

// Agents CRUD
router.get('/', c.getAgents);
router.post('/', c.createAgent);
router.put('/:id', c.updateAgent);
router.delete('/:id', c.deleteAgent);

module.exports = router;
