const { relaySocketEvent } = require('../services/socket-relay.service');

/**
 * Emit a socket event to a room on this server AND relay it to the peer server.
 * Use everywhere instead of bare io.to(room).emit(event, data).
 *
 * The relay is fire-and-forget — if PEER_SERVER_URL is not set it's a no-op.
 */
function broadcast(io, event, room, data) {
  io.to(room).emit(event, data);
  relaySocketEvent(event, String(room), data);
}

module.exports = { broadcast };
