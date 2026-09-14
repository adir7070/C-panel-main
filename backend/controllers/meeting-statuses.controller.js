const svc = require('../services/meeting-statuses.service')

exports.getAll = async (req, res) => {
  try {
    const data = await svc.getAllStatuses()
    res.json({ success: true, data })
  } catch (error) {
    console.error('[MeetingStatuses] getAll error:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
}

exports.create = async (req, res) => {
  try {
    const { label, color, order } = req.body
    if (!label) return res.status(400).json({ success: false, error: 'label is required' })
    const status = await svc.createStatus({ label, color, order })
    res.json({ success: true, data: status })
  } catch (error) {
    console.error('[MeetingStatuses] create error:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
}

exports.update = async (req, res) => {
  try {
    const updated = await svc.updateStatus(req.params.id, req.body)
    if (!updated) return res.status(404).json({ success: false, error: 'Status not found' })
    res.json({ success: true, data: updated })
  } catch (error) {
    console.error('[MeetingStatuses] update error:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
}

exports.remove = async (req, res) => {
  try {
    await svc.deleteStatus(req.params.id)
    res.json({ success: true })
  } catch (error) {
    console.error('[MeetingStatuses] remove error:', error.message)
    res.status(500).json({ success: false, error: error.message })
  }
}
