const { isJewishHoliday } = require('../utils/hebcal')
const { WORK_HOUR_START, WORK_HOUR_END, TIMEZONE } = require('./auto-close.config')

// ─── שעון ירושלים ─────────────────────────────────────────────────────────────
function getJerusalemNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }))
}

// ─── בדיקת יום ושעה ───────────────────────────────────────────────────────────
function isWithinWorkingHours() {
  const now  = getJerusalemNow()
  const day  = now.getDay()    // 0=ראשון, 5=שישי, 6=שבת
  const hour = now.getHours()

  if (day === 5 || day === 6) return false
  if (hour < WORK_HOUR_START || hour >= WORK_HOUR_END) return false
  return true
}

// ─── פונקציה ראשית ────────────────────────────────────────────────────────────
async function isBusinessHours() {
  if (!isWithinWorkingHours()) return false
  if (await isJewishHoliday(getJerusalemNow())) return false
  return true
}

module.exports = { isBusinessHours }
