const PEER_URL = process.env.PEER_SERVER_URL;
const SECRET = process.env.INTERNAL_SECRET;
const RELAY_PATH = "/api/internal/socket-relay";

/**
 * Relay a socket event to the peer server (fire-and-forget).
 * The peer will emit the event to its locally connected clients.
 * @param {string} event  - Socket event name (e.g. "receive_message")
 * @param {string} room   - Socket room (userId or "support_team")
 * @param {Object} data   - Event payload
 */
function relaySocketEvent(event, room, data) {
  return;
  if (!PEER_URL || !SECRET) return;
  fetch(`${PEER_URL}${RELAY_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-relay-secret": SECRET },
    body: JSON.stringify({ event, room, data: { ...data, _fromPeer: true } }),
    signal: AbortSignal.timeout(4000),
  }).catch((err) =>
    console.error("[Relay] failed to reach peer:", err.message),
  );
}

module.exports = { relaySocketEvent };
