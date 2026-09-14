import { useEffect, useRef, useState } from "react";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Spinner } from "../components/ui/Spinner";
import { PersonalCatalogTab } from "../components/tabs/PersonalCatalogTab";
import { getClients, type Client } from "../api/client";
import { listAdminClients } from "../api/admin";
import { useAuth } from "../context/AuthContext";

export function PersonalCatalogPage() {
  const { agent }                  = useAuth();
  const isAdmin                    = agent?.role === "admin";

  const [query, setQuery]         = useState("");
  const [results, setResults]     = useState<{ phone: string; name: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected]   = useState<{ phone: string; name: string } | null>(null);
  const [open, setOpen]           = useState(false);
  const debounceRef               = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef                   = useRef<HTMLDivElement>(null);

  /* Search debounce */
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) { setResults([]); setOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        let clients: { phone: string; name: string }[];
        if (isAdmin) {
          const res = await listAdminClients({ search: query.trim(), limit: 8 });
          clients = (res.clients ?? []).map(c => ({ phone: c.phone, name: c.name }));
        } else {
          const list: Client[] = await getClients(query.trim());
          clients = list.slice(0, 8).map(c => ({ phone: c.phone, name: c.name || c.phone }));
        }
        setResults(clients);
        setOpen(clients.length > 0);
      } catch { setResults([]); }
      finally { setSearching(false); }
    }, 280);
  }, [query, isAdmin]);

  /* Close dropdown on outside click */
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  function pick(client: { phone: string; name: string }) {
    setSelected(client);
    setQuery(client.name || client.phone);
    setOpen(false);
    setResults([]);
  }

  function clear() {
    setSelected(null);
    setQuery("");
    setResults([]);
    setOpen(false);
  }

  return (
    <Layout
      header={
        <Header
          eyebrow="כלים"
          title="קטלוג אישי"
          meta="בנה חבילות מותאמות אישית ללקוחות"
        />
      }
    >
      {/* Client search */}
      <section className="section" style={{ marginTop: 0 }}>
        <div className="card" style={{ padding: "var(--s-4) var(--s-5)" }}>
          <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: "var(--ink-2)", marginBottom: 6 }}>
            בחר לקוח
          </label>
          <div ref={wrapRef} style={{ position: "relative", maxWidth: 420 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                value={query}
                onChange={e => { setQuery(e.target.value); if (selected) setSelected(null); }}
                placeholder="חפש לפי שם או טלפון…"
                style={{
                  flex: 1, padding: "7px 12px", borderRadius: 8,
                  border: "1px solid var(--rule)", background: "var(--paper)",
                  fontSize: 13, color: "var(--ink)",
                }}
              />
              {searching && <Spinner size="sm" />}
              {selected && (
                <button
                  onClick={clear}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--ink-3)", fontSize: 18, lineHeight: 1 }}
                  title="נקה בחירה"
                >×</button>
              )}
            </div>

            {/* No results hint */}
            {!searching && query.trim().length > 1 && results.length === 0 && !selected && (
              <div style={{
                position: "absolute", top: "calc(100% + 4px)", right: 0, left: 0,
                background: "var(--paper)", border: "1px solid var(--rule)",
                borderRadius: 8, padding: "10px 14px",
                fontSize: 12, color: "var(--ink-3)",
                boxShadow: "0 4px 16px rgba(0,0,0,.08)", zIndex: 50,
              }}>
                לא נמצאו לקוחות עבור "{query}"
              </div>
            )}

            {open && results.length > 0 && (
              <div style={{
                position: "absolute", top: "calc(100% + 4px)", right: 0, left: 0,
                background: "var(--paper)", border: "1px solid var(--rule)",
                borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,.12)",
                zIndex: 50, overflow: "hidden",
              }}>
                {results.map(c => (
                  <button
                    key={c.phone}
                    onClick={() => pick(c)}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      width: "100%", padding: "9px 14px", background: "none",
                      border: "none", cursor: "pointer", textAlign: "right",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-tint)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "none")}
                  >
                    <div style={{
                      width: 30, height: 30, borderRadius: "50%",
                      background: "var(--blue)", color: "#fff",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 12, fontWeight: 700, flexShrink: 0,
                    }}>
                      {(c.name || c.phone).charAt(0)}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{c.name || "—"}</div>
                      <div className="t-meta" style={{ fontSize: 11 }} dir="ltr">{c.phone}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {selected && (
            <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--positive)", fontWeight: 700 }}>✓</span>
              <span style={{ fontSize: 12 }}>{selected.name}</span>
              <span className="t-meta" style={{ fontSize: 11 }} dir="ltr">{selected.phone}</span>
            </div>
          )}
        </div>
      </section>

      {/* Catalog tab — only when a client is selected */}
      {selected ? (
        <PersonalCatalogTab phone={selected.phone} />
      ) : (
        !query && (
          <div style={{ textAlign: "center", padding: "var(--s-7) 0", color: "var(--ink-3)" }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🎁</div>
            <p style={{ fontSize: 13 }}>חפש לקוח כדי לנהל את הקטלוג האישי שלו</p>
          </div>
        )
      )}
    </Layout>
  );
}
