import { useEffect, useRef } from "react";
import { io, Socket } from "socket.io-client";

// Same origin as the page by default — the backend serves the SPA and the
// socket from one process. VITE_SOCKET_URL only overrides that.
const SOCKET_URL = (import.meta.env.VITE_SOCKET_URL as string | undefined) || undefined;

let globalSocket: Socket | null = null;
/* Manager room to re-join after every reconnect — the server drops rooms. */
let joinedAgentId: string | null = null;

type ManagerState = { _readyState?: string; _reconnecting?: boolean };

/* Restart the SAME socket once its manager has fully stopped (it gave up
   after reconnectionAttempts). Never while it is opening or waiting for the
   namespace CONNECT ack — a second CONNECT makes the server drop the
   connection. Replacing the socket instead would orphan every listener other
   components registered on it. */
function restartIfStopped() {
  const sock = globalSocket;
  if (!sock || sock.connected) return;
  const mgr = sock.io as unknown as ManagerState;
  if (mgr._readyState === "closed" && !mgr._reconnecting) sock.connect();
}

function ensureSocket(): Socket {
  if (!globalSocket) {
    /* Try WebSocket first; if the upgrade fails (Heroku idle dyno / proxy
       eating the upgrade / corporate firewall blocking ws:), socket.io
       falls back to long-polling instead of spamming the console with
       failed-WS errors. */
    const opts = {
      transports: ["websocket", "polling"],
      upgrade: true,
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 1000,
    };
    const sock = SOCKET_URL ? io(SOCKET_URL, opts) : io(opts);
    sock.on("connect", () => {
      if (joinedAgentId) sock.emit("join_account_manager", joinedAgentId);
    });
    /* socket.io stops for good after its attempts — keep retrying slowly, and
       when the network or the tab comes back, so screens left open recover
       without a navigation. */
    sock.io.on("reconnect_failed", () => { window.setTimeout(restartIfStopped, 15000); });
    window.addEventListener("online", restartIfStopped);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") restartIfStopped();
    });
    globalSocket = sock;
  } else {
    restartIfStopped();
  }
  return globalSocket;
}

export function useSocket(agentId: string | undefined) {
  const ref = useRef<Socket | null>(null);

  useEffect(() => {
    if (!agentId) return;
    const sock = ensureSocket();
    ref.current = sock;
    joinedAgentId = agentId;
    sock.emit("join_account_manager", agentId);
    return () => {
      // global socket persists across mounts — only clear ref
      ref.current = null;
    };
  }, [agentId]);

  return ref.current ?? globalSocket;
}

export function joinClientChat(chatId: string) {
  globalSocket?.emit("join_client_chat", chatId);
}

export function leaveClientChat(chatId: string) {
  globalSocket?.emit("leave_client_chat", chatId);
}

/**
 * `clientMessageId` is the optimistic temp id the UI assigned before the
 * server's response came back. Passing it through means the server uses
 * it as the message's _id, so when the broadcast echoes back to the
 * agent (who's also joined to the client's room), the echo arrives with
 * the same _id as the optimistic message and ChatTab's dedupe-by-_id
 * matches — no double-render. Without it, the optimistic message and
 * the server echo had different ids and both ended up rendered.
 */
export function sendAgentMessage(
  targetUserId: string,
  text: string,
  senderLabel: string,
  clientMessageId?: string,
  customerPhone?: string,
) {
  globalSocket?.emit("send_message_from_agent", {
    targetUserId, text, senderLabel,
    ...(clientMessageId ? { clientMessageId } : {}),
    ...(customerPhone ? { customerPhone } : {}),
  });
}

export function getGlobalSocket(): Socket | null {
  return globalSocket;
}

export function isSocketConnected(): boolean {
  return Boolean(globalSocket?.connected);
}
