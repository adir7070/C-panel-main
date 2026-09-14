const PEER_URL = process.env.PEER_SERVER_URL;
const SECRET = process.env.INTERNAL_SECRET;
const SYNC_PATH = '/api/internal/db-sync';

/**
 * Sync a DB write to the peer server (fire-and-forget).
 * operations: push_message | push_merged_messages | set_status | update_fields
 */
function syncToPeer(operation, chatId, data) {
  if (!PEER_URL || !SECRET) return;
  fetch(`${PEER_URL}${SYNC_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-relay-secret': SECRET },
    body: JSON.stringify({ operation, chatId, data }),
    signal: AbortSignal.timeout(5000),
  }).catch(err => console.error('[DB-Sync] peer unreachable:', err.message));
}

module.exports = { syncToPeer };
