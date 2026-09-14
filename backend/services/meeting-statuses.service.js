const { getDB } = require('../config/db')
const { ObjectId } = require('mongodb')

const COLLECTION = 'meeting_statuses'
const DB = () => getDB().collection(COLLECTION)

async function getAllStatuses() {
  return DB().find({}).sort({ order: 1 }).toArray()
}

async function getStatusById(id) {
  try {
    return DB().findOne({ _id: new ObjectId(id) })
  } catch {
    return null
  }
}

async function createStatus({ label, color, order, sendMessage, messageTemplate }) {
  const doc = {
    label,
    color: color || 'gray',
    order: order ?? 99,
    sendMessage: sendMessage === true,
    messageTemplate: messageTemplate || '',
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  const result = await DB().insertOne(doc)
  return { ...doc, _id: result.insertedId }
}

async function updateStatus(id, { label, color, order, sendMessage, messageTemplate }) {
  const set = { updatedAt: new Date() }
  if (label !== undefined) set.label = label
  if (color !== undefined) set.color = color
  if (order !== undefined) set.order = order
  if (sendMessage !== undefined) set.sendMessage = sendMessage === true
  if (messageTemplate !== undefined) set.messageTemplate = messageTemplate
  return DB().findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: set },
    { returnDocument: 'after' }
  )
}

async function deleteStatus(id) {
  return DB().deleteOne({ _id: new ObjectId(id) })
}

async function seedDefaultStatuses() {
  const count = await DB().countDocuments()
  if (count > 0) return
  const defaults = [
    { label: 'ממתין לחיוג',        color: 'gray',   order: 1,  sendMessage: false, messageTemplate: '' },
    { label: 'שיחה בוצעה',         color: 'green',  order: 2,  sendMessage: false, messageTemplate: '' },
    { label: 'לא נענה',            color: 'yellow', order: 3,  sendMessage: true,  messageTemplate: 'שלום, ניסינו ליצור איתך קשר לגבי הפגישה שלנו אך לא הצלחנו להשיג אותך. אנא צור קשר כדי לתאם מחדש.' },
    { label: 'תפוס',               color: 'orange', order: 4,  sendMessage: true,  messageTemplate: 'שלום, ניסינו להתקשר אליך אך הקו היה תפוס. ניצור קשר שוב בהקדם.' },
    { label: 'ביטל פגישה',         color: 'red',    order: 5,  sendMessage: false, messageTemplate: '' },
    { label: 'לא רלוונטי',         color: 'gray',   order: 6,  sendMessage: false, messageTemplate: '' },
    { label: 'מעוניין - עוקב',      color: 'blue',   order: 7,  sendMessage: false, messageTemplate: '' },
    { label: 'נדחה לתאריך אחר',     color: 'purple', order: 8,  sendMessage: true,  messageTemplate: 'שלום, הפגישה שלנו נדחתה. ניצור קשר בקרוב לתאם תאריך חדש.' },
    { label: 'הסכים לפגישה',        color: 'green',  order: 9,  sendMessage: false, messageTemplate: '' },
    { label: 'דחה הצעה',           color: 'red',    order: 10, sendMessage: false, messageTemplate: '' },
    { label: 'בקשת מידע נוסף',      color: 'blue',   order: 11, sendMessage: false, messageTemplate: '' },
    { label: 'הפנה לאדם אחר',       color: 'indigo', order: 12, sendMessage: false, messageTemplate: '' },
    { label: 'לא בתחום',           color: 'gray',   order: 13, sendMessage: false, messageTemplate: '' },
    { label: 'לקוח חדש',           color: 'teal',   order: 14, sendMessage: false, messageTemplate: '' },
    { label: 'עניין חלקי',          color: 'yellow', order: 15, sendMessage: false, messageTemplate: '' },
    { label: 'ממתין לאישור',        color: 'orange', order: 16, sendMessage: false, messageTemplate: '' },
    { label: 'הותנה בתנאי',         color: 'purple', order: 17, sendMessage: false, messageTemplate: '' },
    { label: 'בתהליך משא ומתן',     color: 'blue',   order: 18, sendMessage: false, messageTemplate: '' },
    { label: 'הצעת מחיר נשלחה',     color: 'indigo', order: 19, sendMessage: false, messageTemplate: '' },
    { label: 'נסגרה עסקה',         color: 'green',  order: 20, sendMessage: false, messageTemplate: '' },
  ]
  const now = new Date()
  await DB().insertMany(defaults.map(d => ({ ...d, createdAt: now, updatedAt: now })))
  console.log('[MeetingStatuses] Seeded 20 default statuses')
}

module.exports = { getAllStatuses, getStatusById, createStatus, updateStatus, deleteStatus, seedDefaultStatuses }
