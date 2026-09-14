const cron = require('node-cron')
const { getDB } = require('../config/db')
const pushNotification = require('../services/push-notification.service')
const { isBusinessHours } = require('./business-hours')
const {
  REMINDER_MINUTES,
  AUTO_CLOSE_MINUTES,
  CHECK_INTERVAL_CRON,
  REMINDER_TEXT,
  PUSH_REMINDER_TITLE,
  PUSH_REMINDER_BODY,
  PUSH_CLOSE_BODY,
} = require('./auto-close.config')

const chats = () => getDB().collection('support_chats')

// ─── Phase 1: שליחת תזכורת ────────────────────────────────────────────────────
// שאילתה: פתוחות + reminderSentAt לא קיים (מסנן כבר בDB)
// אימות: ההודעה האחרונה היא של נציג (לא system) ועברו REMINDER_MINUTES
async function checkReminders(io) {
  try {
    const threshold = new Date(Date.now() - REMINDER_MINUTES * 60 * 1000)

    const candidates = await chats().find({
      status: 'open',
      reminderSentAt: { $exists: false },
      station: { $exists: false },
    }).toArray()

    for (const chat of candidates) {
      const lastMsg = chat.messages?.at(-1)

      if (!lastMsg) continue
      if (lastMsg.fromRole !== 'agent') continue
      if (lastMsg.type === 'system') continue
      if (new Date(lastMsg.createdAt) >= threshold) continue

      const reminderMsg = {
        _id: Date.now(),
        type: 'system',
        event: 'auto_reminder',
        text: REMINDER_TEXT,
        createdAt: new Date(),
      }

      // שמור הודעה + סמן reminderSentAt
      await chats().updateOne(
        { _id: chat._id },
        {
          $push: { messages: reminderMsg },
          $set: { reminderSentAt: new Date(), updated_at: new Date() },
        }
      )

      io.to(chat._id).emit('receive_message', reminderMsg)
      io.to('support_team').emit('receive_message', {
        ...reminderMsg,
        userId: chat._id,
        name: chat.name,
        phone: chat.phone,
      })

      try {
        await pushNotification.notifyUser(chat._id, PUSH_REMINDER_TITLE, PUSH_REMINDER_BODY, { screen: 'ChatScreenAi' })
      } catch (e) {
        console.error('[AutoClose] Push reminder error:', e.message)
      }

      console.log(`[AutoClose] 🔔 Reminder sent → ${chat._id} (${chat.name})`)
    }
  } catch (err) {
    console.error('[AutoClose] checkReminders error:', err.message)
  }
}

// ─── Phase 2: סגירה אוטומטית ─────────────────────────────────────────────────
// שאילתה: פתוחות + reminderSentAt קיים ועבר AUTO_CLOSE_MINUTES (מסנן כבר בDB)
// אימות: ההודעה האחרונה היא עדיין ה-auto_reminder (הלקוח לא ענה)
async function checkAutoClose(io) {
  try {
    const threshold = new Date(Date.now() - AUTO_CLOSE_MINUTES * 60 * 1000)

    const candidates = await chats().find({
      status: 'open',
      reminderSentAt: { $exists: true, $lt: threshold },
      station: { $exists: false },
    }).toArray()

    for (const chat of candidates) {
      const lastMsg = chat.messages?.at(-1)

      // אם הלקוח ענה אחרי התזכורת — lastMsg כבר לא auto_reminder, נקה את השדה ודלג
      if (!lastMsg || lastMsg.event !== 'auto_reminder') {
        await chats().updateOne({ _id: chat._id }, { $unset: { reminderSentAt: '' } })
        console.log(`[AutoClose] ↩ Customer replied after reminder, reset → ${chat._id}`)
        continue
      }

      const closeMsg = {
        _id: Date.now(),
        type: 'system',
        event: 'ticket_closed',
        text: 'הפנייה נסגרה אוטומטית',
        createdAt: new Date(),
      }

      await chats().updateOne(
        { _id: chat._id },
        {
          $set: { status: 'closed', updated_at: new Date() },
          $unset: { station: '', reminderSentAt: '' },
          $push: { messages: closeMsg },
        }
      )

      io.to(chat._id).emit('ticket_status_changed', 'closed')
      io.to(chat._id).emit('receive_message', closeMsg)
      io.to('support_team').emit('ticket_closed_confirmed', { userId: chat._id, stationCleared: true })
      io.to('support_team').emit('ticket_auto_closed', { userId: chat._id, name: chat.name })

      try {
        await pushNotification.notifyUser(chat._id, PUSH_REMINDER_TITLE, PUSH_CLOSE_BODY, { screen: 'ChatScreenAi' })
      } catch (e) {
        console.error('[AutoClose] Push close error:', e.message)
      }

      console.log(`[AutoClose] 🔒 Auto-closed → ${chat._id} (${chat.name})`)
    }
  } catch (err) {
    console.error('[AutoClose] checkAutoClose error:', err.message)
  }
}

// ─── הפעלת ה-cron ─────────────────────────────────────────────────────────────
module.exports = function startAutoCloseJob(io) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[AutoClose] ⏭ סביבת פיתוח — Job לא הופעל')
    return
  }
  cron.schedule(CHECK_INTERVAL_CRON, async () => {
    const now = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' })
    if (!(await isBusinessHours())) {
      console.log(`[AutoClose] ⏸ ${now} — מחוץ לשעות עבודה / חג, מדלג`)
      return
    }
    console.log(`[AutoClose] ⏱ tick ${now} — checking reminders & auto-close`)
    await checkReminders(io)
    await checkAutoClose(io)
  })
  console.log(`[AutoClose] ✅ Job started — reminder after ${REMINDER_MINUTES}min, close after ${AUTO_CLOSE_MINUTES}min`)
}
