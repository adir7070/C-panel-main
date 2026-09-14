/**
 * Shared Hebcal holiday utility.
 * Cache חגים בזיכרון לפי "YYYY-M" — משותף לכל השירותים בתהליך.
 */
const axios = require('axios')

const holidayCache = new Map() // "YYYY-M" → Map<"YYYY-MM-DD", string (hebrew name)>
// גרסת ה-cache — שנה כשמשנים לוגיקת סינון כדי לאלץ רענון
const CACHE_VERSION = 2

/**
 * מחזיר Map של תאריכים ("YYYY-MM-DD" → שם החג בעברית) בחודש נתון.
 */
async function getHolidayDatesForMonth(year, month) {
  const key = `v${CACHE_VERSION}-${year}-${month}`
  if (holidayCache.has(key)) return holidayCache.get(key)

  const url = `https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&year=${year}&month=${month}&lg=s&i=off`
  const { data } = await axios.get(url, { timeout: 5000 })

  const dateMap = new Map()
  for (const e of (data.items || [])) {
    if (e.category !== 'holiday') continue
    // חול המועד פתוח לקביעת פגישות — לא חוסמים אותו
    const isCholHamoed =
      e.subcat === 'cholhamoed' ||
      (e.title  && e.title.toLowerCase().includes('chol ha-moed')) ||
      (e.hebrew && (e.hebrew.includes('חול המועד') || e.hebrew.includes('חוה"מ') || e.hebrew.includes('חוה״מ')))
    if (!isCholHamoed) {
      dateMap.set(e.date.slice(0, 10), e.hebrew || e.title || 'חג')
    }
  }

  holidayCache.set(key, dateMap)
  return dateMap
}

/**
 * בודק אם תאריך נתון (Date object) הוא חג יהודי.
 * במקרה של כשל API — מחזיר false (fail-open).
 */
async function isJewishHoliday(date) {
  const year  = date.getFullYear()
  const month = date.getMonth() + 1
  const dd    = String(date.getDate()).padStart(2, '0')
  const mm    = String(month).padStart(2, '0')
  const dateStr = `${year}-${mm}-${dd}`

  try {
    const holidays = await getHolidayDatesForMonth(year, month)
    return holidays.has(dateStr)
  } catch (err) {
    console.warn('[Hebcal] API fetch failed, treating as non-holiday:', err.message)
    return false
  }
}

/**
 * מחזיר את שם החג לתאריך נתון, או null אם אינו חג.
 * @param {Date} date
 * @returns {Promise<string|null>}
 */
async function getHolidayNameForDate(date) {
  const year  = date.getFullYear()
  const month = date.getMonth() + 1
  const dd    = String(date.getDate()).padStart(2, '0')
  const mm    = String(month).padStart(2, '0')
  const dateStr = `${year}-${mm}-${dd}`

  try {
    const holidays = await getHolidayDatesForMonth(year, month)
    return holidays.get(dateStr) || null
  } catch (err) {
    console.warn('[Hebcal] API fetch failed, treating as non-holiday:', err.message)
    return null
  }
}

/**
 * מסנן רשימת תאריכים והסיר חגים יהודיים.
 * @param {Date[]} dates
 * @returns {Promise<Date[]>}
 */
async function filterOutHolidays(dates) {
  const results = await Promise.all(
    dates.map(async d => ({ d, holiday: await isJewishHoliday(d) }))
  )
  return results.filter(r => !r.holiday).map(r => r.d)
}

module.exports = { isJewishHoliday, filterOutHolidays, getHolidayDatesForMonth, getHolidayNameForDate }
