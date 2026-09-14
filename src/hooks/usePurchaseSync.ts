import { useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import { getGlobalSocket, useSocket } from "./useSocket";

/* Payment sync across screens. A completed charge reaches open screens two
   ways: the backend's socket broadcast (cpanel_new_purchase_admin, emitted
   for every purchase) and a same-browser BroadcastChannel ping from the
   window that confirmed it — which still works when the socket is down. */
const CHANNEL = "dashen-payments";

export interface PurchaseEvent { phone?: string }

export function announcePurchase(ev: PurchaseEvent) {
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage(ev);
    ch.close();
  } catch { /* no BroadcastChannel — the socket broadcast still covers it */ }
}

/** Calls onPurchase whenever a client's purchase completes. Socket and
 *  channel usually both fire for one purchase, so calls are coalesced;
 *  when two different clients coalesce, the phone is dropped so
 *  phone-filtered listeners still refresh. */
export function usePurchaseSync(onPurchase: (ev: PurchaseEvent) => void) {
  const { agent } = useAuth();
  const agentId = agent?.id;
  useSocket(agentId);
  const cb = useRef(onPurchase);
  useEffect(() => { cb.current = onPurchase; });

  useEffect(() => {
    let timer: number | undefined;
    let pending: PurchaseEvent | null = null;
    const fire = (ev: PurchaseEvent | undefined) => {
      const next = ev ?? {};
      pending = pending && pending.phone !== next.phone ? {} : next;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const out = pending ?? {};
        pending = null;
        cb.current(out);
      }, 400);
    };
    const socket = getGlobalSocket();
    socket?.on("cpanel_new_purchase_admin", fire);
    let ch: BroadcastChannel | null = null;
    try {
      ch = new BroadcastChannel(CHANNEL);
      ch.onmessage = e => fire(e.data as PurchaseEvent);
    } catch { ch = null; }
    return () => {
      window.clearTimeout(timer);
      socket?.off("cpanel_new_purchase_admin", fire);
      ch?.close();
    };
  }, [agentId]);
}
