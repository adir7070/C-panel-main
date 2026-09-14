import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  IcoSearch, IcoUsers, IcoChat, IcoTarget, IcoCalendar, IcoTasks,
  IcoBarChart, IcoBroadcast, IcoPipeline, IcoActivity, IcoDigest, IcoHome,
  IcoPlus, IcoSettings,
} from "../icons/Icons";

interface CmdItem {
  id: string;
  label: string;
  hint?: string;
  group: string;
  icon: React.ReactNode;
  kbd?: string;
  action: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: Props) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items: CmdItem[] = useMemo(() => [
    /* Navigation */
    { id: "nav-home",      label: "דף הבית",          group: "ניווט", icon: <IcoHome size={16} />,      kbd: "G H", action: () => { navigate("/"); onClose(); } },
    { id: "nav-clients",   label: "לקוחות",            group: "ניווט", icon: <IcoUsers size={16} />,     kbd: "G C", action: () => { navigate("/clients"); onClose(); } },
    { id: "nav-chat",      label: "צ'אט כללי",        group: "ניווט", icon: <IcoChat size={16} />,      kbd: "G T", action: () => { navigate("/chat"); onClose(); } },
    { id: "nav-leads",     label: "לידים",             group: "ניווט", icon: <IcoTarget size={16} />,    kbd: "G L", action: () => { navigate("/leads"); onClose(); } },
    { id: "nav-pipeline",  label: "פייפליין",          group: "ניווט", icon: <IcoPipeline size={16} />,  kbd: "G P", action: () => { navigate("/pipeline"); onClose(); } },
    { id: "nav-tasks",     label: "משימות",             group: "ניווט", icon: <IcoTasks size={16} />,     kbd: "G M", action: () => { navigate("/tasks"); onClose(); } },
    { id: "nav-appts",     label: "פגישות",             group: "ניווט", icon: <IcoCalendar size={16} />,  kbd: "G A", action: () => { navigate("/appointments"); onClose(); } },
    { id: "nav-camp",      label: "קמפיינים",           group: "ניווט", icon: <IcoBarChart size={16} />,  kbd: "G K", action: () => { navigate("/campaigns"); onClose(); } },
    { id: "nav-broadcast", label: "שליחה רחבה",        group: "ניווט", icon: <IcoBroadcast size={16} />, action: () => { navigate("/broadcast"); onClose(); } },
    { id: "nav-digest",    label: "דייג'סט AI",        group: "ניווט", icon: <IcoDigest size={16} />,    action: () => { navigate("/digest"); onClose(); } },
    { id: "nav-logs",      label: "לוגים",              group: "ניווט", icon: <IcoActivity size={16} />,  action: () => { navigate("/logs"); onClose(); } },

    /* Quick actions */
    { id: "act-new-client",   label: "הוסף לקוח חדש",          hint: "פתיחת מודל יצירת לקוח", group: "פעולות מהירות", icon: <IcoPlus size={16} />, action: () => { navigate("/clients?new=1"); onClose(); } },
    { id: "act-broadcast",    label: "שלח הודעה רחבה",         hint: "Broadcast",                 group: "פעולות מהירות", icon: <IcoBroadcast size={16} />, action: () => { navigate("/broadcast"); onClose(); } },
    { id: "act-digest-now",   label: "הרץ דייג'סט AI עכשיו",   hint: "סיכום יומי",                 group: "פעולות מהירות", icon: <IcoDigest size={16} />, action: () => { navigate("/digest?run=1"); onClose(); } },

    /* Settings */
    { id: "settings",         label: "הגדרות",                  group: "מערכת", icon: <IcoSettings size={16} />, action: () => { onClose(); } },
  ], [navigate, onClose]);

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter(i => i.label.toLowerCase().includes(q) || i.hint?.toLowerCase().includes(q));
  }, [items, query]);

  /* Group items by group */
  const grouped = useMemo(() => {
    const map = new Map<string, CmdItem[]>();
    filtered.forEach(item => {
      const list = map.get(item.group) ?? [];
      list.push(item);
      map.set(item.group, list);
    });
    return Array.from(map.entries());
  }, [filtered]);

  /* Reset state on open */
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  /* Keep activeIdx in bounds */
  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(0);
  }, [filtered.length, activeIdx]);

  /* Keyboard navigation */
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => (i + 1) % filtered.length); }
      if (e.key === "ArrowUp")   { e.preventDefault(); setActiveIdx(i => (i - 1 + filtered.length) % filtered.length); }
      if (e.key === "Enter")     { e.preventDefault(); filtered[activeIdx]?.action(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, filtered, activeIdx, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="spotlight-overlay" onClick={onClose} />
      <div className="spotlight" role="dialog" aria-modal="true">
        <div style={{ display: "flex", alignItems: "center", padding: "0 18px", borderBottom: "1px solid var(--rule)" }}>
          <IcoSearch size={18} color="var(--ink-3)" />
          <input
            ref={inputRef}
            className="spotlight-input"
            placeholder="חפש לקוח, פעולה, ניווט..."
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <span className="spotlight-kbd">ESC</span>
        </div>

        <div style={{ maxHeight: "50vh", overflowY: "auto", padding: "8px 0" }}>
          {filtered.length === 0 ? (
            <div style={{ padding: "32px", textAlign: "center", color: "var(--ink-3)", fontSize: "var(--t-sm)" }}>
              לא נמצאו תוצאות עבור "{query}"
            </div>
          ) : (
            grouped.map(([groupName, groupItems]) => (
              <div key={groupName}>
                <div className="spotlight-section-label">{groupName}</div>
                {groupItems.map(item => {
                  const idx = filtered.indexOf(item);
                  return (
                    <div
                      key={item.id}
                      className={`spotlight-item${idx === activeIdx ? " active" : ""}`}
                      onClick={item.action}
                      onMouseEnter={() => setActiveIdx(idx)}
                    >
                      <span className="spotlight-item-icon">{item.icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "var(--t-sm)", fontWeight: 600, color: "var(--ink)" }}>{item.label}</div>
                        {item.hint && (
                          <div style={{ fontSize: "var(--t-xs)", color: "var(--ink-3)", marginTop: 2 }}>{item.hint}</div>
                        )}
                      </div>
                      {item.kbd && <span className="spotlight-kbd">{item.kbd}</span>}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div style={{
          padding: "10px 18px",
          borderTop: "1px solid var(--rule)",
          display: "flex",
          alignItems: "center",
          gap: "12px",
          fontSize: "11px",
          color: "var(--ink-3)",
          background: "var(--bg-tint)",
        }}>
          <span><kbd className="spotlight-kbd">↑↓</kbd> ניווט</span>
          <span><kbd className="spotlight-kbd">↵</kbd> בחר</span>
          <span><kbd className="spotlight-kbd">ESC</kbd> סגור</span>
          <span style={{ marginInlineStart: "auto", fontWeight: 700 }}>DASHEN ⌘K</span>
        </div>
      </div>
    </>
  );
}
