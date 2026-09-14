import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type Client,
  getClients,
  addClient,
  getStats,
  assignManager,
  getAccountManagers,
  type AccountManager,
} from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useSocket } from "../hooks/useSocket";
import { useToast } from "../context/ToastContext";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Field } from "../components/ui/Field";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { TierBadge } from "../components/ui/TierBadge";
import { tierPriority } from "../data/tiers";

type SortKey = "tier" | "name" | "phone" | "lastActive" | "manager" | "status";
type SortDir = "asc" | "desc";
type GroupBy = "none" | "status" | "manager" | "tier" | "card";
type FilterChip = "all" | "unread" | "withCard" | "noCard" | "noManager";

/* ── Status palette — solid bold pills, white text ───────────────────── */
const STATUS_META: Record<string, { label: string; color: string }> = {
  open:                    { label: "פעיל",          color: "#0073EA" },
  pending:                 { label: "ממתין",          color: "#FDAB3D" },
  closed:                  { label: "סגור",           color: "#676879" },
  done:                    { label: "הושלם",          color: "#00C875" },
  stuck:                   { label: "תקוע",           color: "#E2445C" },
  friend_referral:         { label: "חבר מביא חבר",  color: "#7B61FF" },
  friend_referral_approved:{ label: "הפניה - רלוונטי", color: "#FDAB3D" },
};

const GROUP_META: Record<GroupBy, { label: string; getKey: (c: Client) => string; getLabel: (k: string) => string; getColor: (k: string) => string }> = {
  none:    { label: "ללא קיבוץ",  getKey: () => "all",                          getLabel: () => "כל הלקוחות",                                              getColor: () => "#0073EA" },
  status:  { label: "לפי סטטוס",  getKey: c => c.status || "—",                 getLabel: k => STATUS_META[k]?.label ?? k,                                  getColor: k => STATUS_META[k]?.color ?? "#9699A6" },
  manager: { label: "לפי מנהל",   getKey: c => c.accountManagerName || "—",     getLabel: k => k === "—" ? "ללא מנהל" : k,                                  getColor: k => k === "—" ? "#9699A6" : "#A25DDC" },
  tier:    { label: "לפי דרג",    getKey: c => c.tier || "REGULAR",             getLabel: k => k === "VIP" ? "VIP" : k === "PREMIUM" ? "פרימיום" : "רגיל",   getColor: k => k === "VIP" ? "#FDAB3D" : k === "PREMIUM" ? "#A25DDC" : "#9699A6" },
  card:    { label: "לפי תשלום",  getKey: c => c.hasPaymentToken ? "yes" : "no", getLabel: k => k === "yes" ? "עם כרטיס" : "ללא כרטיס",                       getColor: k => k === "yes" ? "#00C875" : "#E2445C" },
};

export function ClientListPage() {
  const { agent } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const socket = useSocket(agent?.id);

  const canAssign = agent?.role === "admin" || agent?.role === "supervisor";

  const [clients, setClients]         = useState<Client[]>([]);
  const [search, setSearch]           = useState("");
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [unread, setUnread]           = useState<Record<string, boolean>>({});
  const [stats, setStats]             = useState<{ totalClients: number; unreadMessages: number } | null>(null);
  const [showAdd, setShowAdd]         = useState(false);
  const [sortKey, setSortKey]         = useState<SortKey>("tier");
  const [sortDir, setSortDir]         = useState<SortDir>("desc");
  const [filter, setFilter]           = useState<FilterChip>("all");
  const [groupBy, setGroupBy]         = useState<GroupBy>("status");
  const [collapsed, setCollapsed]     = useState<Set<string>>(new Set());
  const [selected, setSelected]       = useState<Set<string>>(new Set());
  const [managers, setManagers]       = useState<AccountManager[]>([]);
  const [showAssign, setShowAssign]   = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    load();
    refreshStats();
    if (canAssign) getAccountManagers().then(setManagers).catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onNewMsg = (data: { userId: string; phone: string }) => {
      const id = clients.find(c => c.phone === data.phone)?.id || data.userId;
      setUnread(p => ({ ...p, [id]: true }));
      refreshStats();
    };
    socket.on("new_client_message", onNewMsg);
    return () => { socket.off("new_client_message", onNewMsg); };
  }, [socket, clients]);

  function refreshStats() { getStats().then(setStats).catch(() => null); }

  function load(q?: string) {
    setLoading(true);
    setError(null);
    getClients(q)
      .then(setClients)
      .catch(e => setError(e.message ?? "שגיאה בטעינת לקוחות"))
      .finally(() => setLoading(false));
  }

  function onSearch(v: string) {
    setSearch(v);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => load(v.trim() || undefined), 380);
  }

  function goClient(c: Client) {
    setUnread(p => { const n = { ...p }; delete n[c.id]; return n; });
    navigate(`/clients/${encodeURIComponent(c.phone)}`, { state: { client: c } });
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir(key === "name" || key === "phone" ? "asc" : "desc"); }
  }

  function toggleSelect(id: string) {
    setSelected(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  function toggleGroupCollapse(key: string) {
    setCollapsed(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  function toggleSelectAll() {
    if (selected.size === filtered.length && filtered.length > 0) setSelected(new Set());
    else setSelected(new Set(filtered.map(c => c.id)));
  }

  async function bulkAssign(managerId: string | null) {
    setShowAssign(false);
    let ok = 0, fail = 0;
    for (const id of selected) {
      try { await assignManager(id, managerId); ok++; } catch { fail++; }
    }
    toast.ok(`שיוך הושלם · ${ok} הצליחו${fail > 0 ? `, ${fail} נכשלו` : ""}`);
    setSelected(new Set());
    load(search.trim() || undefined);
  }

  /* ── Apply filter ─────────────────────────────────────────── */
  const filtered = useMemo(() => {
    let arr = clients.slice();
    if (filter === "unread")    arr = arr.filter(c => unread[c.id] || c.unread);
    if (filter === "withCard")  arr = arr.filter(c => c.hasPaymentToken);
    if (filter === "noCard")    arr = arr.filter(c => !c.hasPaymentToken);
    if (filter === "noManager") arr = arr.filter(c => !c.accountManagerId);

    arr.sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortKey === "tier") {
        const pa = tierPriority(a.tier), pb = tierPriority(b.tier);
        if (pa !== pb) return (pb - pa) * dir;
        const at = a.lastActive ? new Date(a.lastActive).getTime() : 0;
        const bt = b.lastActive ? new Date(b.lastActive).getTime() : 0;
        return bt - at;
      }
      if (sortKey === "name")    return (a.name || "").localeCompare(b.name || "", "he") * dir;
      if (sortKey === "phone")   return (a.phone || "").localeCompare(b.phone || "") * dir;
      if (sortKey === "manager") return (a.accountManagerName || "").localeCompare(b.accountManagerName || "", "he") * dir;
      if (sortKey === "status")  return (a.status || "").localeCompare(b.status || "") * dir;
      const at = a.lastActive ? new Date(a.lastActive).getTime() : 0;
      const bt = b.lastActive ? new Date(b.lastActive).getTime() : 0;
      return (at - bt) * dir;
    });
    return arr;
  }, [clients, sortKey, sortDir, filter, unread]);

  /* ── Group rows ───────────────────────────────────────────── */
  const groups = useMemo(() => {
    const meta = GROUP_META[groupBy];
    const map = new Map<string, Client[]>();
    for (const c of filtered) {
      const k = meta.getKey(c);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(c);
    }
    return Array.from(map.entries()).map(([key, items]) => ({
      key, items,
      label: meta.getLabel(key),
      color: meta.getColor(key),
    }));
  }, [filtered, groupBy]);

  const counts = useMemo(() => ({
    all:        clients.length,
    unread:     clients.filter(c => unread[c.id] || c.unread).length,
    withCard:   clients.filter(c => c.hasPaymentToken).length,
    noCard:     clients.filter(c => !c.hasPaymentToken).length,
    noManager:  clients.filter(c => !c.accountManagerId).length,
  }), [clients, unread]);

  const localUnread = useMemo(() => Object.values(unread).filter(Boolean).length, [unread]);
  const totalUnread = (stats?.unreadMessages ?? 0) + localUnread;
  const today = new Date().toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" });

  return (
    <>
      <Layout
        header={
          <Header
            eyebrow={today}
            title="לקוחות"
            meta={`${clients.length.toLocaleString("he-IL")} לקוחות · ${totalUnread.toLocaleString("he-IL")} הודעות חדשות`}
            trailing={
              <Button onClick={() => setShowAdd(true)}>
                + לקוח חדש
              </Button>
            }
          />
        }
      >
        {/* ── Toolbar ─────────────────────────────────────────────────── */}
        <section className="section" style={{ marginTop: 0 }}>
          <div style={{
            display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
            padding: "10px 12px",
            background: "var(--paper)",
            border: "1px solid var(--rule)",
            borderRadius: "var(--r-2)",
          }}>
            <ToolbarBtn icon="🔍">
              <input
                value={search}
                onChange={e => onSearch(e.target.value)}
                placeholder="חפש שם או טלפון..."
                style={{
                  border: 0, background: "transparent", outline: "none",
                  fontSize: 13, fontWeight: 600, color: "var(--ink)", width: 180,
                }}
              />
            </ToolbarBtn>
            <ToolbarSelect label="קבץ לפי" value={groupBy} onChange={v => setGroupBy(v as GroupBy)}
              options={Object.entries(GROUP_META)
                /* "לפי מנהל" is meaningless on a manager's own list —
                   every row is theirs by construction. Admins keep it. */
                .filter(([k]) => k !== "manager" || canAssign)
                .map(([k, m]) => ({ value: k, label: m.label }))} />
            <ToolbarSelect label="מיון" value={sortKey} onChange={v => toggleSort(v as SortKey)}
              options={[
                { value: "tier", label: "דרג" },
                { value: "name", label: "שם" },
                { value: "lastActive", label: "פעילות אחרונה" },
                { value: "manager", label: "מנהל" },
                { value: "status", label: "סטטוס" },
              ]} />

            <div style={{ flex: 1 }} />

            {/* Filter chips */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <FilterChipBtn active={filter === "all"}       onClick={() => setFilter("all")}>הכל · {counts.all}</FilterChipBtn>
              <FilterChipBtn active={filter === "unread"}    onClick={() => setFilter("unread")}    color="#E2445C">חדשות · {counts.unread}</FilterChipBtn>
              {/* "ללא מנהל" only makes sense to admins/supervisors who see
                  the global pool. For an account manager every row in
                  their own list is theirs — show the chip would be a lie. */}
              {canAssign && (
                <FilterChipBtn active={filter === "noManager"} onClick={() => setFilter("noManager")} color="#FDAB3D">ללא מנהל · {counts.noManager}</FilterChipBtn>
              )}
              <FilterChipBtn active={filter === "withCard"}  onClick={() => setFilter("withCard")}  color="#00C875">עם כרטיס · {counts.withCard}</FilterChipBtn>
              <FilterChipBtn active={filter === "noCard"}    onClick={() => setFilter("noCard")}    color="#9699A6">ללא כרטיס · {counts.noCard}</FilterChipBtn>
            </div>
          </div>
        </section>

        {/* ── Bulk action bar ─────────────────────────────────────────── */}
        {selected.size > 0 && (
          <section className="section" style={{ marginTop: 8 }}>
            <div style={{
              display: "flex", gap: 12, alignItems: "center",
              background: "#0073EA",
              color: "#fff",
              padding: "10px 16px", borderRadius: "var(--r-2)",
              boxShadow: "0 4px 12px rgba(0,115,234,0.35)",
            }}>
              <span style={{ fontWeight: 800, fontSize: 14 }}>{selected.size} נבחרו</span>
              {canAssign && (
                <button onClick={() => setShowAssign(true)}
                  style={{ background: "rgba(255,255,255,0.22)", color: "#fff", border: "1px solid rgba(255,255,255,0.4)", padding: "6px 12px", borderRadius: 6, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                  שייך מנהל
                </button>
              )}
              <button onClick={() => navigate("/broadcast")}
                style={{ background: "rgba(255,255,255,0.22)", color: "#fff", border: "1px solid rgba(255,255,255,0.4)", padding: "6px 12px", borderRadius: 6, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                שלח broadcast
              </button>
              <div style={{ flex: 1 }} />
              <button onClick={() => setSelected(new Set())}
                style={{ background: "transparent", color: "#fff", border: "1px solid rgba(255,255,255,0.4)", padding: "6px 12px", borderRadius: 6, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                נקה
              </button>
            </div>
          </section>
        )}

        {/* ── Groups ──────────────────────────────────────────────────── */}
        <section className="section" style={{ marginTop: 12 }}>
          {loading ? (
            <div className="card"><Spinner label="טוען לקוחות" /></div>
          ) : error ? (
            <div className="card" style={{ padding: "var(--s-7)" }}>
              <EmptyState title="שגיאה" meta={error} action={<Button onClick={() => load()}>נסה שוב</Button>} />
            </div>
          ) : filtered.length === 0 ? (
            <div className="card" style={{ padding: "var(--s-7)" }}>
              <EmptyState
                title={search ? "לא נמצאו לקוחות" : "אין לקוחות בתצוגה"}
                meta={search ? "נסה חיפוש אחר או שנה את הסינון." : "הוסף לקוח חדש לפי טלפון."}
                action={<Button onClick={() => setShowAdd(true)}>הוסף לקוח</Button>}
              />
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {groups.map(g => (
                <GroupBlock
                  key={g.key}
                  groupKey={g.key}
                  label={g.label}
                  color={g.color}
                  items={g.items}
                  collapsed={collapsed.has(g.key)}
                  onToggleCollapse={() => toggleGroupCollapse(g.key)}
                  selected={selected}
                  onToggleSelect={toggleSelect}
                  onToggleSelectAll={toggleSelectAll}
                  unread={unread}
                  onClickRow={goClient}
                  canAssign={canAssign}
                />
              ))}
            </div>
          )}
        </section>
      </Layout>

      <AddClientModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={(name) => {
          toast.ok(`נוסף לקוח: ${name}`);
          load(); refreshStats();
        }}
      />

      <Modal open={showAssign} onClose={() => setShowAssign(false)} eyebrow="שיוך מסה" title={`שיוך ${selected.size} לקוחות למנהל`}>
        {managers.length === 0 ? (
          <p className="t-meta">לא נמצאו מנהלים זמינים.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            {managers.map(m => (
              <button key={m.id} onClick={() => bulkAssign(m.id)} className="row" style={{ background: "transparent", textAlign: "right" }}>
                <div>
                  <p className="row-title">{m.name}</p>
                  {m.phone && <p className="row-meta tabular" dir="ltr">{m.phone}</p>}
                </div>
                <span className="t-meta">›</span>
              </button>
            ))}
            <Button variant="quiet" size="sm" onClick={() => bulkAssign(null)}>הסר שיוך</Button>
          </div>
        )}
      </Modal>
    </>
  );
}

/* ── Group Block ───────────────────────────────────────────────────── */
function GroupBlock({
  label, color, items, collapsed, onToggleCollapse,
  selected, onToggleSelect, unread, onClickRow, canAssign,
}: {
  groupKey: string;
  label: string;
  color: string;
  items: Client[];
  collapsed: boolean;
  onToggleCollapse: () => void;
  selected: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  unread: Record<string, boolean>;
  onClickRow: (c: Client) => void;
  /** Determines whether the "מנהל" column is shown. Set by the parent
   *  to `agent.role === "admin" || "supervisor"`. */
  canAssign: boolean;
}) {
  /* Status distribution for footer bar */
  const dist = useMemo(() => {
    const map: Record<string, number> = {};
    for (const c of items) {
      const s = c.status || "—";
      map[s] = (map[s] ?? 0) + 1;
    }
    return Object.entries(map);
  }, [items]);

  return (
    <div style={{
      background: "var(--paper)",
      borderRadius: "var(--r-2)",
      border: "1px solid var(--rule)",
      overflow: "hidden",
      boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
    }}>
      {/* Group header */}
      <button
        onClick={onToggleCollapse}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 10,
          padding: "10px 14px",
          background: "var(--paper)",
          border: 0, borderBottom: collapsed ? "none" : `1px solid var(--rule)`,
          cursor: "pointer",
          textAlign: "right",
          position: "relative",
        }}
      >
        {/* Colored accent bar */}
        <div style={{
          position: "absolute", insetInlineStart: 0, top: 0, bottom: 0,
          width: 4, background: color,
        }} />
        <span style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 18, height: 18, color: color, fontSize: 11, fontWeight: 800,
          transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)",
          transition: "transform 150ms",
        }}>▼</span>
        <span style={{ fontSize: 14, fontWeight: 800, color }}>{label}</span>
        <span style={{
          fontSize: 11, fontWeight: 700, color: "var(--ink-3)",
          padding: "2px 8px", background: "var(--bg-tint)", borderRadius: 999,
        }}>
          {items.length}
        </span>
      </button>

      {!collapsed && (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "var(--bg-tint)", borderBottom: "1px solid var(--rule)" }}>
                  <th style={thStyle(40)}>
                    <input
                      type="checkbox"
                      checked={items.every(c => selected.has(c.id)) && items.length > 0}
                      onChange={() => {
                        const allSelected = items.every(c => selected.has(c.id));
                        items.forEach(c => {
                          if (allSelected) onToggleSelect(c.id);
                          else if (!selected.has(c.id)) onToggleSelect(c.id);
                        });
                      }}
                    />
                  </th>
                  <th style={thStyle()}>לקוח</th>
                  <th style={thStyle()}>טלפון</th>
                  <th style={thStyle()}>פעילות</th>
                  <th style={thStyle()}>סטטוס</th>
                  {/* "מנהל" only adds info for admins/supervisors. On a
                      manager's own page it'd repeat the same name on
                      every row. */}
                  {canAssign && <th style={thStyle()}>מנהל</th>}
                  <th style={thStyle()}>תשלום</th>
                  <th style={thStyle(40)} />
                </tr>
              </thead>
              <tbody>
                {items.map(c => {
                  const isSel = selected.has(c.id);
                  const isUnread = unread[c.id] || c.unread;
                  return (
                    <tr
                      key={c.id}
                      onClick={() => onClickRow(c)}
                      style={{
                        borderBottom: "1px solid var(--rule)",
                        cursor: "pointer",
                        background: isSel ? "rgba(0,115,234,0.06)" : "transparent",
                        transition: "background 120ms ease",
                      }}
                      onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = "var(--bg-tint)"; }}
                      onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = "transparent"; }}
                    >
                      <td style={tdStyle} onClick={e => { e.stopPropagation(); onToggleSelect(c.id); }}>
                        <input type="checkbox" checked={isSel} onChange={() => onToggleSelect(c.id)} />
                      </td>
                      <td style={tdStyle}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                          <Avatar name={c.name} unread={isUnread} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {c.name || "ללא שם"}
                              </span>
                              {c.tier && c.tier !== "REGULAR" && <TierBadge tier={c.tier} size="sm" />}
                              {isUnread && <span style={{
                                display: "inline-flex", alignItems: "center", gap: 3,
                                fontSize: 9, fontWeight: 800,
                                background: "#E2445C", color: "#fff",
                                padding: "1px 6px", borderRadius: 99,
                              }}>● חדש</span>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td style={{ ...tdStyle, fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-2)", direction: "ltr", textAlign: "right" }}>
                        {c.phone}
                      </td>
                      <td style={{ ...tdStyle, color: "var(--ink-2)", fontSize: 12 }}>
                        {c.lastActive ? <span className="tabular">{relativeTime(c.lastActive)}</span> : <span style={{ color: "var(--ink-4)" }}>—</span>}
                      </td>
                      <td style={tdStyle}>
                        <StatusPill status={c.status} />
                      </td>
                      {canAssign && (
                        <td style={{ ...tdStyle, fontSize: 12, color: "var(--ink-2)" }}>
                          {c.accountManagerName ? (
                            <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                              <Avatar name={c.accountManagerName} size={22} color="#A25DDC" />
                              <span>{c.accountManagerName}</span>
                            </div>
                          ) : <span style={{ color: "var(--ink-4)" }}>—</span>}
                        </td>
                      )}
                      <td style={tdStyle}>
                        {c.hasPaymentToken
                          ? <span style={{
                              display: "inline-flex", alignItems: "center", gap: 4,
                              fontSize: 11, fontWeight: 700,
                              background: "#00C875", color: "#fff",
                              padding: "3px 10px", borderRadius: 4,
                            }}>● {c.paymentLast4 ?? "כרטיס"}</span>
                          : <span style={{ color: "var(--ink-4)", fontSize: 12 }}>—</span>
                        }
                      </td>
                      <td style={{ ...tdStyle, color: "var(--ink-3)", textAlign: "left" }}>›</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Distribution footer bar */}
          {dist.length > 1 && (
            <div style={{
              display: "flex", height: 28,
              borderTop: "1px solid var(--rule)",
              background: "var(--bg-tint)",
            }}>
              {dist.map(([s, n]) => (
                <div key={s} title={`${STATUS_META[s]?.label ?? s}: ${n}`} style={{
                  flex: n,
                  background: STATUS_META[s]?.color ?? "#9699A6",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "#fff", fontSize: 10, fontWeight: 800,
                }}>
                  {n > 0 && (n / items.length) > 0.06 && n}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── Components ─────────────────────────────────────────────────────── */

const thStyle = (w?: number): React.CSSProperties => ({
  padding: "8px 12px",
  textAlign: "right",
  fontSize: 11, fontWeight: 700,
  color: "var(--ink-3)",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  width: w,
});

const tdStyle: React.CSSProperties = { padding: "8px 12px" };

function StatusPill({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { label: status || "—", color: "#9699A6" };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      minWidth: 80,
      padding: "5px 12px",
      background: meta.color, color: "#fff",
      fontSize: 11, fontWeight: 800,
      borderRadius: 4,
      letterSpacing: "0.02em",
    }}>
      {meta.label}
    </span>
  );
}

function Avatar({ name, unread, size = 30, color }: { name?: string; unread?: boolean; size?: number; color?: string }) {
  const initial = (name || "?").charAt(0).toUpperCase();
  const bg = color ?? (unread ? "#E2445C" : "#0073EA");
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: bg, color: "#fff",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      fontWeight: 800, fontSize: size * 0.42,
      flexShrink: 0,
    }}>
      {initial}
    </div>
  );
}

function ToolbarBtn({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "6px 10px",
      background: "var(--bg-tint)", borderRadius: 6,
      border: "1px solid var(--rule)",
    }}>
      <span style={{ fontSize: 12 }}>{icon}</span>
      {children}
    </div>
  );
}

function ToolbarSelect<T extends string>({ label, value, onChange, options }: {
  label: string; value: T; onChange: (v: T) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "6px 10px",
      background: "var(--bg-tint)", borderRadius: 6,
      border: "1px solid var(--rule)",
      fontSize: 12, fontWeight: 600, color: "var(--ink-2)",
    }}>
      <span style={{ color: "var(--ink-3)" }}>{label}:</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value as T)}
        style={{
          background: "transparent", border: 0, outline: "none",
          fontSize: 12, fontWeight: 700, color: "var(--ink)",
          cursor: "pointer",
        }}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function FilterChipBtn({ active, color, onClick, children }: {
  active: boolean; color?: string; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 12px",
        borderRadius: 999,
        background: active ? (color ?? "#0073EA") : "var(--bg-tint)",
        color: active ? "#fff" : "var(--ink-2)",
        border: active ? `1px solid ${color ?? "#0073EA"}` : "1px solid var(--rule)",
        fontSize: 12, fontWeight: 700,
        cursor: "pointer",
        transition: "all 120ms",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000)         return "עכשיו";
  if (diff < 3_600_000)      return `${Math.floor(diff / 60_000)} דק'`;
  if (diff < 86_400_000)     return `${Math.floor(diff / 3_600_000)} שעות`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} ימים`;
  return new Date(iso).toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit" });
}

function AddClientModal({ open, onClose, onAdded }: {
  open: boolean; onClose: () => void; onAdded: (name: string) => void;
}) {
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (!open) { setPhone(""); setError(null); setLoading(false); }
  }, [open]);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!phone.trim()) { setError("נדרש מספר טלפון"); return; }
    setLoading(true); setError(null);
    try {
      const res = await addClient(phone.trim());
      if (res.alreadyExisted) toast.warn(`לקוח קיים: ${res.name}`);
      onAdded(res.name);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "שגיאה בהוספה");
    } finally { setLoading(false); }
  }

  return (
    <Modal
      open={open} onClose={onClose}
      eyebrow="ניהול" title="הוספת לקוח חדש"
      footer={
        <>
          <Button onClick={() => submit()} loading={loading} disabled={!phone.trim()}>הוסף לקוח</Button>
          <Button variant="ghost" onClick={onClose}>ביטול</Button>
        </>
      }
    >
      <form onSubmit={submit}>
        <Field label="מספר טלפון" hint="הזן מספר ישראלי, למשל 0501234567">
          <Input value={phone} onChange={e => setPhone(e.target.value)} type="tel" dir="ltr" placeholder="0501234567" autoFocus inputMode="tel" />
        </Field>
        {error && <p className="field-error" style={{ marginTop: "var(--s-3)" }}>{error}</p>}
      </form>
    </Modal>
  );
}
