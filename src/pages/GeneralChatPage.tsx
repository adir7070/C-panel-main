import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type Client,
  type ChatMessage,
  type AiReplySuggestion,
  getClients,
  getMessages,
  aiSuggestReplies,
  aiSummarizeChat,
} from "../api/client";
import {
  getGlobalSocket,
  joinClientChat,
  leaveClientChat,
  sendAgentMessage,
  isSocketConnected,
} from "../hooks/useSocket";
import { useApi } from "../hooks/useApi";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useSocket } from "../hooks/useSocket";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Spinner } from "../components/ui/Spinner";
import { Input } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { useNavigate, useSearchParams } from "react-router-dom";

type Filter = "all" | "unread" | "today";

export function GeneralChatPage() {
  const { agent } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const socket = useSocket(agent?.id);

  const fetcher = useCallback(() => getClients(), []);
  const { data: clientsData, loading: clientsLoading, reload: reloadClients } = useApi(fetcher, [fetcher]);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  /* ?phone= (e.g. the dashboard's unanswered-chats list) opens that conversation. */
  const [searchParams] = useSearchParams();
  const [activePhone, setActivePhone] = useState<string | null>(() => searchParams.get("phone"));
  const [unread, setUnread] = useState<Record<string, boolean>>({});

  const clients: Client[] = clientsData ?? [];

  // Promote the first client into the right pane on first load — also when the
  // requested ?phone isn't one of this manager's clients
  useEffect(() => {
    if (clients.length > 0 && !clients.some(c => c.phone === activePhone)) {
      setActivePhone(clients[0].phone);
    }
  }, [clients, activePhone]);

  // Listen for new messages → mark unread
  useEffect(() => {
    if (!socket) return;
    const onNewMsg = (data: { userId: string; phone: string }) => {
      if (data.phone !== activePhone) {
        setUnread(p => ({ ...p, [data.phone]: true }));
      }
    };
    socket.on("new_client_message", onNewMsg);
    return () => { socket.off("new_client_message", onNewMsg); };
  }, [socket, activePhone]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients.filter(c => {
      if (q && !(c.name?.toLowerCase().includes(q) || c.phone.includes(q))) return false;
      if (filter === "unread" && !(unread[c.phone] || c.unread)) return false;
      if (filter === "today") {
        if (!c.lastActive) return false;
        const t = new Date(c.lastActive).getTime();
        return Date.now() - t < 86_400_000;
      }
      return true;
    });
  }, [clients, search, filter, unread]);

  const counts = useMemo(() => ({
    all:    clients.length,
    unread: clients.filter(c => unread[c.phone] || c.unread).length,
    today:  clients.filter(c => c.lastActive && Date.now() - new Date(c.lastActive).getTime() < 86_400_000).length,
  }), [clients, unread]);

  function selectClient(c: Client) {
    setUnread(p => { const n = { ...p }; delete n[c.phone]; return n; });
    setActivePhone(c.phone);
  }

  const activeClient = clients.find(c => c.phone === activePhone) ?? null;

  return (
    <Layout
      header={
        <Header
          eyebrow="צ'אט כללי"
          title="תיבת הודעות אחידה"
          meta={`${counts.all.toLocaleString("he-IL")} שיחות · ${counts.unread} שלא נקראו`}
          trailing={<Button variant="ghost" size="sm" onClick={reloadClients}>רענן</Button>}
        />
      }
    >
      <div style={{
        display: "grid",
        gridTemplateColumns: "minmax(320px, 380px) 1fr",
        gap: "var(--s-4)",
        height: "calc(100vh - 200px)",
        minHeight: 600,
      }}>
        {/* ── Left pane — conversations list ── */}
        <div className="card" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "var(--s-4) var(--s-4) var(--s-3)", borderBottom: "1px solid var(--rule)" }}>
            <Input
              placeholder="חפש בשיחות..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <div style={{ display: "flex", gap: 6, marginTop: "var(--s-3)" }}>
              <FilterPill active={filter === "all"}    onClick={() => setFilter("all")}>הכל · {counts.all}</FilterPill>
              <FilterPill active={filter === "unread"} onClick={() => setFilter("unread")} color="negative">חדשות · {counts.unread}</FilterPill>
              <FilterPill active={filter === "today"}  onClick={() => setFilter("today")}>היום · {counts.today}</FilterPill>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {clientsLoading ? (
              <Spinner label="טוען" />
            ) : filtered.length === 0 ? (
              <div style={{ padding: "var(--s-5)" }}>
                <EmptyState title="אין שיחות" meta={search ? "נסה חיפוש אחר" : "טרם נפתחו שיחות"} />
              </div>
            ) : (
              filtered.map(c => (
                <ConvRow
                  key={c.id}
                  client={c}
                  active={c.phone === activePhone}
                  hasUnread={Boolean(unread[c.phone] || c.unread)}
                  onClick={() => selectClient(c)}
                />
              ))
            )}
          </div>
        </div>

        {/* ── Right pane — conversation ── */}
        <div className="card" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {activeClient ? (
            <ConversationPane
              client={activeClient}
              agentName={agent?.nickname || agent?.name || "מנהל"}
              onOpenClient={() => navigate(`/clients/${encodeURIComponent(activeClient.phone)}`)}
              onMessage={() => {
                // re-sort list if we like — for now just refresh recency by reloading
              }}
              onError={msg => toast.error(msg)}
            />
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--s-7)" }}>
              <EmptyState title="בחר שיחה" meta="לחץ על שיחה משמאל כדי לפתוח אותה כאן" />
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Conversation Row (left list)
   ───────────────────────────────────────────────────────────────────── */
function ConvRow({
  client, active, hasUnread, onClick,
}: {
  client: Client;
  active: boolean;
  hasUnread: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr auto",
        alignItems: "center",
        gap: "var(--s-3)",
        width: "100%",
        textAlign: "right",
        padding: "var(--s-3) var(--s-4)",
        background: active ? "var(--blue-soft)" : "transparent",
        border: 0,
        borderBottom: "1px solid var(--rule)",
        cursor: "pointer",
        transition: "background 100ms ease",
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = "var(--bg-tint)"; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = "transparent"; }}
    >
      <div className={`chip ${hasUnread ? "chip-red" : "chip-blue"}`} style={{
        width: 38, height: 38, borderRadius: "50%", fontWeight: 700, fontSize: 14,
      }}>
        {(client.name || "?").charAt(0).toUpperCase()}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <span style={{
            fontSize: "var(--t-sm)",
            fontWeight: hasUnread ? 800 : 700,
            color: "var(--ink)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {client.name || "ללא שם"}
          </span>
          {client.lastActive && (
            <span className="row-meta tabular" style={{ flexShrink: 0, fontSize: 11 }}>
              {relativeTime(client.lastActive)}
            </span>
          )}
        </div>
        <div className="row-meta tabular" dir="ltr" style={{ marginTop: 2 }}>
          {client.phone}
        </div>
      </div>
      {hasUnread && (
        <span style={{
          width: 10, height: 10,
          borderRadius: "50%",
          background: "var(--negative)",
          flexShrink: 0,
        }} />
      )}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Right pane — full conversation with AI Copilot
   ───────────────────────────────────────────────────────────────────── */
function ConversationPane({
  client, agentName, onOpenClient, onMessage, onError,
}: {
  client: Client;
  agentName: string;
  onOpenClient: () => void;
  onMessage: () => void;
  onError: (msg: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(isSocketConnected());
  const bottomRef = useRef<HTMLDivElement>(null);

  // AI state
  const [suggestions, setSuggestions] = useState<AiReplySuggestion[]>([]);
  const [summary, setSummary] = useState<{ summary: string; sentiment: string; intents: string[] } | null>(null);
  const [aiBusy, setAiBusy] = useState<"reply" | "summary" | null>(null);

  // Reset state when client changes
  useEffect(() => {
    setMessages([]);
    setChatId(null);
    setText("");
    setSuggestions([]);
    setSummary(null);
    setLoading(true);

    let cancelled = false;
    getMessages(client.phone)
      .then(res => {
        if (cancelled) return;
        setMessages(res.messages ?? []);
        if (res.chatId) setChatId(res.chatId);
      })
      .catch(err => onError(err instanceof Error ? err.message : "שגיאה בטעינת הודעות"))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client.phone, onError]);

  // Socket join/leave + listener
  useEffect(() => {
    if (!chatId) return;
    joinClientChat(chatId);
    const socket = getGlobalSocket();
    if (!socket) return;
    const onConnect    = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    setConnected(socket.connected);

    const handler = (msg: ChatMessage & { userId?: string; clientTempId?: string | number }) => {
      const msgChatId = msg.userId || chatId;
      if (msgChatId !== chatId) return;
      setMessages(prev => {
        if (prev.some(m => String(m._id) === String(msg._id))) return prev;
        if (msg.clientTempId != null) {
          const idx = prev.findIndex(m => String(m._id) === String(msg.clientTempId));
          if (idx >= 0) {
            const next = prev.slice();
            next[idx] = msg;
            return next;
          }
        }
        return [...prev, msg];
      });
      onMessage();
    };
    socket.on("receive_message", handler);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("receive_message", handler);
      leaveClientChat(chatId);
    };
  }, [chatId, onMessage]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  function send() {
    const t = text.trim();
    if (!t || !chatId || sending) return;
    setSending(true);
    const tempId = `temp-${Date.now()}`;
    setMessages(prev => [...prev, {
      _id: tempId,
      text: t,
      type: "text",
      fromRole: "agent",
      createdAt: new Date().toISOString(),
      user: { _id: "me", name: agentName },
    } as ChatMessage]);
    try {
      sendAgentMessage(chatId, t, agentName);
      setText("");
    } catch (err) {
      setMessages(prev => prev.filter(m => m._id !== tempId));
      onError(err instanceof Error ? err.message : "שגיאה בשליחה");
    } finally {
      setSending(false);
    }
  }

  async function aiSuggest() {
    setAiBusy("reply");
    try {
      const res = await aiSuggestReplies(client.phone, 12);
      setSuggestions(res.suggestions);
    } catch (err) {
      onError(err instanceof Error ? `AI לא זמין: ${err.message}` : "AI לא זמין");
    } finally { setAiBusy(null); }
  }

  async function aiSummarize() {
    setAiBusy("summary");
    try {
      const res = await aiSummarizeChat(client.phone);
      setSummary(res);
    } catch (err) {
      onError(err instanceof Error ? `AI לא זמין: ${err.message}` : "AI לא זמין");
    } finally { setAiBusy(null); }
  }

  return (
    <>
      {/* Header strip */}
      <div style={{
        padding: "var(--s-4) var(--s-5)",
        borderBottom: "1px solid var(--rule)",
        display: "flex",
        alignItems: "center",
        gap: "var(--s-4)",
        flexShrink: 0,
      }}>
        <div className="chip chip-blue" style={{ width: 44, height: 44, borderRadius: "50%", fontWeight: 700, fontSize: 16 }}>
          {(client.name || "?").charAt(0).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: "var(--t-md)", fontWeight: 700, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {client.name || "ללא שם"}
          </p>
          <p className="t-meta tabular" dir="ltr" style={{ marginTop: 2 }}>{client.phone}</p>
        </div>
        <Badge variant={connected ? "positive" : "negative"} dot>{connected ? "מחובר" : "מנותק"}</Badge>
        <Button size="sm" variant="ghost" onClick={onOpenClient}>פתח לקוח ›</Button>
      </div>

      {/* AI Copilot bar */}
      <div style={{
        padding: "var(--s-3) var(--s-5)",
        borderBottom: "1px solid var(--rule)",
        background: "var(--blue-soft)",
        display: "flex",
        alignItems: "center",
        gap: "var(--s-3)",
        flexShrink: 0,
      }}>
        <span className="chip chip-violet" style={{ width: 28, height: 28 }}>
          <SvgSparkle />
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--blue)", letterSpacing: "0.02em" }}>AI Copilot</span>
        <div style={{ flex: 1 }} />
        <Button size="sm" variant="ghost" onClick={aiSuggest} loading={aiBusy === "reply"}>הצע תשובה</Button>
        <Button size="sm" variant="ghost" onClick={aiSummarize} loading={aiBusy === "summary"}>סכם שיחה</Button>
      </div>

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div style={{
          padding: "var(--s-3) var(--s-5)",
          borderBottom: "1px solid var(--rule)",
          display: "flex", flexDirection: "column", gap: "var(--s-2)",
          flexShrink: 0,
        }}>
          {suggestions.map((s, i) => (
            <button
              key={i}
              onClick={() => { setText(s.text); setSuggestions([]); }}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "var(--s-3)",
                padding: "var(--s-2) var(--s-3)",
                background: "var(--surface)",
                border: "1px solid var(--rule)",
                borderRadius: "var(--r-2)",
                cursor: "pointer",
                textAlign: "right",
              }}
            >
              <Badge variant="clay">{toneLabel(s.tone)}</Badge>
              <span style={{ flex: 1, fontSize: 13, lineHeight: 1.55 }}>{s.text}</span>
              <span style={{ color: "var(--blue)", fontWeight: 700, fontSize: 12 }}>בחר ›</span>
            </button>
          ))}
        </div>
      )}

      {/* Summary */}
      {summary && (
        <div style={{
          padding: "var(--s-4) var(--s-5)",
          borderBottom: "1px solid var(--rule)",
          background: "var(--surface)",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <span className="t-eyebrow">סיכום</span>
            <div style={{ display: "flex", gap: 4 }}>
              <Badge variant={summary.sentiment === "positive" ? "positive" : summary.sentiment === "negative" ? "negative" : "warning"}>
                {summary.sentiment === "positive" ? "חיובי" : summary.sentiment === "negative" ? "שלילי" : "ניטרלי"}
              </Badge>
              {summary.intents.slice(0, 3).map((it, i) => <Badge key={i}>{it}</Badge>)}
            </div>
          </div>
          <p className="t-body" style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{summary.summary}</p>
        </div>
      )}

      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: "auto",
        padding: "var(--s-5)",
        background: "var(--bg)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-3)",
        minHeight: 0,
      }}>
        {loading ? (
          <Spinner label="טוען הודעות" />
        ) : !chatId ? (
          <EmptyState title="הלקוח לא פתח שיחה" meta="כשהלקוח ישלח הודעה ראשונה היא תופיע כאן" />
        ) : messages.length === 0 ? (
          <p className="t-meta" style={{ textAlign: "center", padding: "var(--s-7) 0" }}>אין הודעות עדיין</p>
        ) : (
          messages.map((msg, i) => <Bubble key={`${msg._id}-${i}`} msg={msg} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      {chatId && (
        <div style={{
          padding: "var(--s-4) var(--s-5)",
          borderTop: "1px solid var(--rule)",
          background: "var(--surface)",
          display: "flex",
          gap: "var(--s-3)",
          alignItems: "flex-end",
          flexShrink: 0,
        }}>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="כתוב הודעה ללקוח..."
            rows={2}
            className="input"
            style={{ flex: 1, minHeight: 44 }}
          />
          <Button onClick={send} disabled={!text.trim() || !connected} loading={sending}>
            שלח
          </Button>
        </div>
      )}
    </>
  );
}

function Bubble({ msg }: { msg: ChatMessage }) {
  const isAgent = msg.fromRole === "agent";
  return (
    <div style={{ display: "flex", justifyContent: isAgent ? "flex-end" : "flex-start" }}>
      <div style={{
        maxWidth: "78%",
        padding: "10px 14px",
        background: isAgent ? "var(--blue)" : "var(--surface)",
        color: isAgent ? "#fff" : "var(--ink)",
        border: isAgent ? "1px solid var(--blue)" : "1px solid var(--rule)",
        borderRadius: 16,
        borderBottomLeftRadius: !isAgent ? 4 : 16,
        borderBottomRightRadius: isAgent ? 4 : 16,
        boxShadow: "0 1px 2px rgba(11,20,48,0.06)",
      }}>
        {msg.type === "image" && msg.imageUrl ? (
          <img src={msg.imageUrl} alt="" style={{ maxWidth: "100%", display: "block", borderRadius: 8 }} />
        ) : (
          <p style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "inherit" }}>
            {msg.text}
          </p>
        )}
        <p className="tabular" dir="ltr" style={{
          fontSize: 11,
          marginTop: 4,
          opacity: 0.7,
          color: "inherit",
          textAlign: isAgent ? "left" : "right",
        }}>
          {formatTime(msg.createdAt)}
        </p>
      </div>
    </div>
  );
}

/* ── Helpers ───────────────────────────────────────────────────────── */

function FilterPill({ active, color, onClick, children }: {
  active: boolean;
  color?: "negative";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const bg = active
    ? "var(--blue)"
    : color === "negative" ? "var(--negative-bg)" : "var(--bg-tint)";
  const fg = active
    ? "#fff"
    : color === "negative" ? "var(--negative)" : "var(--ink-2)";
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 12px",
        borderRadius: 999,
        background: bg,
        color: fg,
        border: 0,
        fontSize: 11,
        fontWeight: 700,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000)     return "עכשיו";
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}ד'`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}ש'`;
  return new Date(iso).toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" });
}

function formatTime(ts: string | number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
}

function toneLabel(t: AiReplySuggestion["tone"]): string {
  return t === "warm" ? "חמים" : t === "professional" ? "מקצועי" : "תמציתי";
}

function SvgSparkle() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L9 9l-7 1 5 5-1 7 6-3 6 3-1-7 5-5-7-1z"/>
    </svg>
  );
}
