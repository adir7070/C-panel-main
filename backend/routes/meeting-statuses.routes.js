const router = require('express').Router()
const ctrl = require('../controllers/meeting-statuses.controller')

router.get('/', ctrl.getAll)
router.post('/', ctrl.create)
router.patch('/:id', ctrl.update)
router.delete('/:id', ctrl.remove)

module.exports = router
