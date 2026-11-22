import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getServiceCatalog, getQuoteDefaults, createQuote, updateQuote, computeQuoteTotals, formatIls, todayISO,
  type CatalogService, type Quote, type QuoteClient, type QuoteInput, type QuoteLine, type ServiceBilling,
  type ServiceCatalog,
} from "../../api/quotes";
import { searchServices, matchRanges } from "../../lib/serviceSearch";
import { useToast } from "../../context/ToastContext";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { EmptyState } from "../ui/EmptyState";
import { Input, Textarea } from "../ui/Input";

/**
 * QuoteBuilder — builds a quote in the Dashen format from the 64-service
 * price list. Right: the catalog with smart search, filters, category chips
 * and the kit's quick starts. Left: the quote — client, terms, the chosen
 * services (setup / monthly), "works well together" suggestions and live
 * totals. Keyboard: "/" search · ↑↓ move · Enter add/remove · Esc clear.
 */

interface LineState extends QuoteLine { uid: string }

type BillingFilter = "all" | "setup" | "monthly" | "order";

let uidSeq = 0;
const uid = () => `l${++uidSeq}`;

function lineFromService(s: CatalogService): LineState {
  return {
    uid: uid(), key: s.key, custom: false, name: s.name, description: s.description,
    billing: s.billing, onDemand: s.onDemand, price: s.price, qty: 1, category: s.category, role: s.role,
  };
}

const EMPTY_CLIENT: QuoteClient = { name: "", id: "", contact: "", role: "", phone: "", email: "", address: "" };

export function QuoteBuilder({ phone, quote, onClose, onSaved }: {
  phone: string;
  quote?: Quote | null;
  onClose: () => void;
  onSaved: (q: Quote, opts: { preview: boolean }) => void;
}) {
  const toast = useToast();
  const isEdit = !!quote;

  /* ── data ── */
  const [catalog, setCatalog] = useState<ServiceCatalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lines, setLines] = useState<LineState[]>(() => (quote?.lines ?? []).map(l => ({ ...l, uid: uid() })));
  const [client, setClient] = useState<QuoteClient>(() => ({ ...EMPTY_CLIENT, ...(quote?.client ?? {}) }));
  const [discountPct, setDiscountPct] = useState<number>(quote?.discountPct ?? 0);
  const [commitMonths, setCommitMonths] = useState<number>(quote?.commitMonths ?? 3);
  const [validDays, setValidDays] = useState<number>(quote?.validDays ?? 14);
  const [quoteDate, setQuoteDate] = useState<string>(quote?.quoteDate ?? todayISO());
  const [notes, setNotes] = useState<string>(quote?.notes ?? "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState<null | "save" | "preview">(null);
  const touch = useCallback(() => setDirty(true), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getServiceCatalog(), quote ? Promise.resolve(null) : getQuoteDefaults(phone)])
      .then(([cat, defaults]) => {
        if (cancelled) return;
        setCatalog(cat);
        if (defaults) {
          setClient(c => ({ ...c, ...defaults.client }));
          setQuoteDate(defaults.quoteDate);
          setCommitMonths(defaults.commitMonths);
          setValidDays(defaults.validDays);
        }
      })
      .catch(err => { if (!cancelled) setLoadError(err instanceof Error ? err.message : "שגיאה בטעינת המחירון"); });
    return () => { cancelled = true; };
  }, [phone, quote]);

  const maxDiscount = catalog?.quoteRules.maxDiscountPct ?? 10;
  const vatPct = quote?.vatPct ?? catalog?.quoteRules.vatPct ?? 18;
  const services = useMemo(() => catalog?.services ?? [], [catalog]);
  const serviceByKey = useMemo(() => new Map(services.map(s => [s.key, s])), [services]);
  const lineByKey = useMemo(() => new Map(lines.filter(l => l.key).map(l => [l.key as string, l])), [lines]);

  /* ── line operations ── */
  const addService = useCallback((s: CatalogService) => {
    setLines(ls => (ls.some(l => l.key === s.key) ? ls : [...ls, lineFromService(s)]));
    touch();
  }, [touch]);
  const removeKey = useCallback((key: string) => {
    setLines(ls => ls.filter(l => l.key !== key));
    touch();
  }, [touch]);
  const toggleService = useCallback((s: CatalogService) => {
    if (lineByKey.has(s.key)) removeKey(s.key);
    else addService(s);
  }, [lineByKey, addService, removeKey]);
  const setQty = (u: string, qty: number) => {
    setLines(ls => ls.map(l => (l.uid === u ? { ...l, qty: Math.max(1, Math.min(999, Math.round(qty) || 1)) } : l)));
    touch();
  };
  const removeLine = (u: string) => { setLines(ls => ls.filter(l => l.uid !== u)); touch(); };
  const patchLine = (u: string, patch: Partial<LineState>) => {
    setLines(ls => ls.map(l => (l.uid === u ? { ...l, ...patch } : l)));
    touch();
  };
  const addCustom = () => {
    setLines(ls => [...ls, { uid: uid(), key: null, custom: true, name: "", description: "", billing: "setup", price: 0, qty: 1, category: "custom" }]);
    touch();
  };
  const applyQuickStart = (keys: string[]) => {
    const add = keys.map(k => serviceByKey.get(k)).filter((s): s is CatalogService => !!s && !lineByKey.has(s.key));
    if (add.length === 0) { toast.warn("כל השירותים בתבנית כבר בהצעה"); return; }
    setLines(ls => [...ls, ...add.map(lineFromService)]);
    touch();
    toast.ok(`נוספו ${add.length} שירותים`);
  };

  /* ── search + filters ── */
  const [query, setQuery] = useState("");
  const [billingFilter, setBillingFilter] = useState<BillingFilter>("all");
  const [coreOnly, setCoreOnly] = useState(false);
  const [category, setCategory] = useState<string>("");
  const searchRef = useRef<HTMLInputElement>(null);

  const hits = useMemo(() => searchServices(services, query), [services, query]);
  const passBilling = useCallback((s: CatalogService) =>
    billingFilter === "all" ||
    (billingFilter === "monthly" && s.billing === "monthly") ||
    (billingFilter === "setup" && s.billing === "setup" && !s.onDemand) ||
    (billingFilter === "order" && s.onDemand), [billingFilter]);
  const filtered = useMemo(
    () => hits.filter(h => passBilling(h.service) && (!coreOnly || h.service.role === "core")),
    [hits, passBilling, coreOnly],
  );
  const visible = useMemo(() => filtered.filter(h => !category || h.service.category === category), [filtered, category]);
  const terms = useMemo(() => (query.trim() ? visible[0]?.terms ?? [] : []), [visible, query]);
  const matchCountByCat = useMemo(() => {
    const m = new Map<string, number>();
    filtered.forEach(h => m.set(h.service.category, (m.get(h.service.category) ?? 0) + 1));
    return m;
  }, [filtered]);
  const selectedCountByCat = useMemo(() => {
    const m = new Map<string, number>();
    lines.forEach(l => l.category && m.set(l.category, (m.get(l.category) ?? 0) + 1));
    return m;
  }, [lines]);
  const searching = query.trim().length > 0;

  /* keyboard navigation over the visible rows */
  /* changing the query or a filter puts the highlight back on the first row */
  const [activeRaw, setActive] = useState(0);
  const active = Math.min(activeRaw, Math.max(0, visible.length - 1));
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const changeQuery = (v: string) => { setQuery(v); setActive(0); };
  const changeBilling = (v: BillingFilter) => { setBillingFilter(v); setActive(0); };
  const changeCoreOnly = (v: boolean) => { setCoreOnly(v); setActive(0); };
  const changeCategory = (v: string) => { setCategory(v); setActive(0); };
  useEffect(() => {
    const key = visible[active]?.service.key;
    if (key) rowRefs.current.get(key)?.scrollIntoView({ block: "nearest" });
  }, [active, visible]);

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm("לצאת בלי לשמור? השינויים בהצעה יאבדו.")) return;
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
      if (e.key === "/" && !typing) { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === "Escape") {
        if (target === searchRef.current && query) { setQuery(""); setActive(0); return; }
        requestClose();
      }
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [query, requestClose]);

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(visible.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const h = visible[active];
      if (h) toggleService(h.service);
    }
  }

  /* ── totals + suggestions ── */
  const totals = useMemo(
    () => computeQuoteTotals(lines, { discountPct, vatPct, commitMonths, maxDiscountPct: maxDiscount }),
    [lines, discountPct, vatPct, commitMonths, maxDiscount],
  );
  const setupLines = lines.filter(l => l.billing !== "monthly");
  const monthlyLines = lines.filter(l => l.billing === "monthly");

  const suggestions = useMemo(() => {
    if (!catalog) return [];
    const have = new Set(lines.map(l => l.key).filter(Boolean) as string[]);
    const out: { service: CatalogService; solves: string }[] = [];
    const seen = new Set<string>();
    for (const combo of catalog.combos) {
      if (!combo.services.some(k => have.has(k))) continue;
      for (const k of combo.services) {
        const s = serviceByKey.get(k);
        if (s && !have.has(k) && !seen.has(k)) { seen.add(k); out.push({ service: s, solves: combo.solves }); }
      }
    }
    return out.slice(0, 4);
  }, [catalog, lines, serviceByKey]);

  /* ── save ── */
  async function save(preview: boolean) {
    if (lines.length === 0) { toast.warn("הוסף לפחות שירות אחד להצעה"); return; }
    const badCustom = lines.find(l => l.custom && !l.name.trim());
    if (badCustom) { toast.warn("לשירות מותאם חסר שם"); return; }
    if (discountPct > maxDiscount) { toast.warn(`ההנחה המרבית היא ${maxDiscount}%`); return; }
    const input: QuoteInput = {
      lines: lines.map(l => (l.custom
        ? { custom: true as const, name: l.name.trim(), description: l.description.trim(), billing: l.billing, price: Number(l.price) || 0, qty: l.qty }
        : { key: l.key as string, qty: l.qty })),
      client, discountPct, commitMonths, validDays, quoteDate, notes,
    };
    setSaving(preview ? "preview" : "save");
    try {
      const saved = quote ? await updateQuote(phone, quote._id, input) : await createQuote(phone, input);
      toast.ok(quote ? "ההצעה עודכנה" : `הצעה ${saved.quoteNo} נשמרה`);
      setDirty(false);
      onSaved(saved, { preview });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "השמירה נכשלה");
    } finally {
      setSaving(null);
    }
  }

  const setClientField = (k: keyof QuoteClient) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setClient(c => ({ ...c, [k]: e.target.value }));
    touch();
  };

  /* ── render ── */
  return (
    <div className="qb-overlay" role="dialog" aria-modal="true" aria-label="בניית הצעת מחיר">
      <div className="qb">
        <div className="qb-head">
          <div style={{ minWidth: 0 }}>
            <p className="t-eyebrow" style={{ margin: 0 }}>{isEdit ? `עריכת הצעה ${quote?.quoteNo}` : "הצעת מחיר חדשה"}</p>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "var(--ink)" }}>
              {client.name || "הצעת מחיר"}
            </h2>
          </div>
          <span className="qb-kbd-hint" style={{ marginInlineStart: "auto" }}>
            <kbd>/</kbd> חיפוש · <kbd>↑</kbd><kbd>↓</kbd> מעבר · <kbd>Enter</kbd> הוספה/הסרה
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="ghost" size="sm" onClick={requestClose} disabled={!!saving}>ביטול</Button>
            <Button size="sm" variant="ghost" onClick={() => save(false)} loading={saving === "save"} disabled={!!saving || !catalog}>שמור</Button>
            <Button size="sm" onClick={() => save(true)} loading={saving === "preview"} disabled={!!saving || !catalog}>שמור והצג הצעה</Button>
          </div>
        </div>

        {!catalog ? (
          <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
            {loadError
              ? <EmptyState title="לא ניתן לטעון את המחירון" meta={loadError} action={<Button onClick={onClose}>סגור</Button>} />
              : <Spinner label="טוען מחירון" />}
          </div>
        ) : (
          <div className="qb-body">
            {/* ═══ Catalog ═══ */}
            <section className="qb-cat" aria-label="מחירון שירותים">
              <div className="qb-cat-top">
                <div className="qb-search">
                  <SearchIcon />
                  <input
                    ref={searchRef}
                    className="input"
                    value={query}
                    onChange={e => changeQuery(e.target.value)}
                    onKeyDown={onSearchKey}
                    placeholder={`חיפוש חכם ב-${services.length} שירותים: "וואטסאפ", "סרטון", "עד 1000", "חודשי"…`}
                    aria-label="חיפוש שירות"
                    autoFocus
                  />
                  <kbd>/</kbd>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <div className="qb-seg" role="group" aria-label="סוג תשלום">
                    {([["all", "הכל"], ["setup", "הקמה"], ["monthly", "חודשי"], ["order", "לפי הזמנה"]] as [BillingFilter, string][]).map(([k, label]) => (
                      <button key={k} type="button" className={billingFilter === k ? "on" : ""} aria-pressed={billingFilter === k} onClick={() => changeBilling(k)}>{label}</button>
                    ))}
                  </div>
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "var(--ink-2)", cursor: "pointer" }}>
                    <input type="checkbox" checked={coreOnly} onChange={e => changeCoreOnly(e.target.checked)} />
                    רק שירותים מרכזיים
                  </label>
                  <span className="t-meta" style={{ fontSize: 12, marginInlineStart: "auto" }}>
                    {visible.length === services.length ? `${services.length} שירותים` : `${visible.length} מתוך ${services.length}`}
                  </span>
                </div>
                <div className="qb-chips" role="group" aria-label="תחום">
                  <button type="button" className={`qb-chip${category === "" ? " on" : ""}`} onClick={() => changeCategory("")}>
                    כל התחומים <span className="n">{filtered.length}</span>
                  </button>
                  {catalog.categories.map(c => {
                    const n = matchCountByCat.get(c.key) ?? 0;
                    const sel = selectedCountByCat.get(c.key) ?? 0;
                    if (n === 0 && category !== c.key && !sel) return null;
                    return (
                      <button key={c.key} type="button" className={`qb-chip${category === c.key ? " on" : ""}`} onClick={() => changeCategory(category === c.key ? "" : c.key)}>
                        {c.name} <span className="n">{n}</span>
                        {sel > 0 && <span className="sel" title="נבחרו בהצעה">{sel}</span>}
                      </button>
                    );
                  })}
                </div>
                {!searching && catalog.quickStarts.length > 0 && (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="t-meta" style={{ fontSize: 12, fontWeight: 700 }}>התחלה מהירה:</span>
                    {catalog.quickStarts.map(qs => (
                      <button key={qs.key} type="button" className="qb-chip" title={qs.description} onClick={() => applyQuickStart(qs.services)}>
                        + {qs.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="qb-list">
                {visible.length === 0 ? (
                  <EmptyState
                    title="לא נמצא שירות"
                    meta={`אין שירות שמתאים ל"${query}". נסו מילה אחרת, או הוסיפו שירות מותאם.`}
                    action={<Button size="sm" onClick={addCustom}>+ שירות מותאם</Button>}
                  />
                ) : searching ? (
                  visible.map((h, i) => (
                    <ServiceRow
                      key={h.service.key}
                      s={h.service}
                      terms={terms}
                      added={lineByKey.has(h.service.key)}
                      active={i === active}
                      showCategory
                      rowRef={el => { if (el) rowRefs.current.set(h.service.key, el); else rowRefs.current.delete(h.service.key); }}
                      onToggle={() => { setActive(i); toggleService(h.service); }}
                    />
                  ))
                ) : (
                  catalog.categories.map(c => {
                    const rows = visible.filter(h => h.service.category === c.key);
                    if (rows.length === 0) return null;
                    return (
                      <div key={c.key}>
                        <div className="qb-group-h">
                          <span style={{ display: "inline-flex", width: 20, height: 20, borderRadius: 99, background: "#0C2347", color: "#fff", fontSize: 11, alignItems: "center", justifyContent: "center" }}>{c.order}</span>
                          {c.name}
                          <span className="t-meta" style={{ fontWeight: 600 }}>· {rows.length}</span>
                        </div>
                        {rows.map(h => {
                          const i = visible.indexOf(h);
                          return (
                            <ServiceRow
                              key={h.service.key}
                              s={h.service}
                              terms={[]}
                              added={lineByKey.has(h.service.key)}
                              active={i === active}
                              rowRef={el => { if (el) rowRefs.current.set(h.service.key, el); else rowRefs.current.delete(h.service.key); }}
                              onToggle={() => { setActive(i); toggleService(h.service); }}
                            />
                          );
                        })}
                      </div>
                    );
                  })
                )}
                <div style={{ padding: "var(--s-4) 12px 0" }}>
                  <Button size="sm" variant="ghost" onClick={addCustom}>+ שירות מותאם (פיתוח בהתאמה אישית / לא במחירון)</Button>
                </div>
              </div>
            </section>

            {/* ═══ Quote ═══ */}
            <aside className="qb-sum" aria-label="ההצעה">
              <div className="qb-totals" aria-live="polite">
                <div className="r"><span>הקמה לפני מע"מ</span><b>{formatIls(totals.setup.net)}</b></div>
                <div className="r"><span>חודשי לפני מע"מ</span><b>{formatIls(totals.monthly.net)}</b></div>
                {totals.discountPct > 0 && (
                  <div className="r"><span>הנחה {totals.discountPct}%</span><b>-{formatIls(totals.setup.disc + totals.monthly.disc)}</b></div>
                )}
                <div className="big"><span>לתשלום בחתימה (כולל מע"מ)</span><b>{formatIls(totals.setup.total)}</b></div>
                <div className="r"><span>תשלום חודשי (כולל מע"מ)</span><b>{formatIls(totals.monthly.total)}</b></div>
                <div className="r"><span>סה"כ ל-{commitMonths} חודשים</span><b>{formatIls(totals.commitTotal)}</b></div>
              </div>

              <div className="qb-card">
                <h4>שירותי הקמה <span className="t-meta" style={{ fontWeight: 600 }}>· {setupLines.length}</span></h4>
                {setupLines.length === 0
                  ? <p className="t-meta" style={{ margin: 0, fontSize: 12 }}>לא נבחרו שירותי הקמה.</p>
                  : setupLines.map(l => <LineRow key={l.uid} l={l} onQty={q => setQty(l.uid, q)} onRemove={() => removeLine(l.uid)} onPatch={p => patchLine(l.uid, p)} />)}
              </div>

              <div className="qb-card">
                <h4>שירותים חודשיים <span className="t-meta" style={{ fontWeight: 600 }}>· {monthlyLines.length}</span></h4>
                {monthlyLines.length === 0
                  ? <p className="t-meta" style={{ margin: 0, fontSize: 12 }}>לא נבחרו שירותים חודשיים.</p>
                  : monthlyLines.map(l => <LineRow key={l.uid} l={l} onQty={q => setQty(l.uid, q)} onRemove={() => removeLine(l.uid)} onPatch={p => patchLine(l.uid, p)} />)}
              </div>

              {suggestions.length > 0 && (
                <div className="qb-card">
                  <h4>שילובים שעובדים יחד</h4>
                  {suggestions.map(({ service, solves }) => (
                    <div key={service.key} className="qb-suggest">
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{service.name}</div>
                        <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{solves}</div>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => addService(service)}>
                        + {formatIls(service.price)}{service.billing === "monthly" ? "/חודש" : ""}
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="qb-card">
                <h4>תנאים</h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <MiniField label={`הנחה % (עד ${maxDiscount})`}>
                    <div style={{ display: "flex", gap: 4 }}>
                      <Input
                        type="number" min={0} max={maxDiscount} value={discountPct}
                        onChange={e => { setDiscountPct(Math.max(0, Math.min(maxDiscount, Number(e.target.value) || 0))); touch(); }}
                        style={{ minWidth: 0 }}
                      />
                      {[0, 5, maxDiscount].filter((v, i, a) => a.indexOf(v) === i).map(v => (
                        <button key={v} type="button" className={`qb-chip${discountPct === v ? " on" : ""}`} style={{ padding: "4px 8px" }} onClick={() => { setDiscountPct(v); touch(); }}>{v}%</button>
                      ))}
                    </div>
                  </MiniField>
                  <MiniField label="התחייבות (חודשים)">
                    <Input type="number" min={1} max={36} value={commitMonths} onChange={e => { setCommitMonths(Math.max(1, Math.min(36, Number(e.target.value) || 1))); touch(); }} />
                  </MiniField>
                  <MiniField label="תאריך ההצעה">
                    <Input type="date" value={quoteDate} onChange={e => { setQuoteDate(e.target.value); touch(); }} />
                  </MiniField>
                  <MiniField label="תוקף (ימים)">
                    <Input type="number" min={1} max={90} value={validDays} onChange={e => { setValidDays(Math.max(1, Math.min(90, Number(e.target.value) || 1))); touch(); }} />
                  </MiniField>
                </div>
              </div>

              <div className="qb-card">
                <h4>הוכן עבור</h4>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <MiniField label="שם העסק / הלקוח"><Input value={client.name} onChange={setClientField("name")} /></MiniField>
                  <MiniField label="ח.פ. / ע.מ."><Input value={client.id} onChange={setClientField("id")} dir="ltr" /></MiniField>
                  <MiniField label="איש קשר"><Input value={client.contact} onChange={setClientField("contact")} /></MiniField>
                  <MiniField label="תפקיד"><Input value={client.role} onChange={setClientField("role")} /></MiniField>
                  <MiniField label="טלפון"><Input value={client.phone} onChange={setClientField("phone")} dir="ltr" inputMode="tel" /></MiniField>
                  <MiniField label='דוא"ל'><Input value={client.email} onChange={setClientField("email")} dir="ltr" type="email" /></MiniField>
                </div>
                <MiniField label="כתובת"><Input value={client.address} onChange={setClientField("address")} /></MiniField>
              </div>

              <div className="qb-card">
                <h4>הערות פנימיות <span className="t-meta" style={{ fontWeight: 500 }}>(לא מופיעות בהצעה)</span></h4>
                <Textarea rows={2} value={notes} onChange={e => { setNotes(e.target.value); touch(); }} placeholder="למשל: הלקוח ביקש לחשוב עד יום ראשון" />
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────── */

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  const ranges = matchRanges(text, terms);
  if (ranges.length === 0) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) out.push(text.slice(at, s));
    out.push(<mark key={i}>{text.slice(s, e)}</mark>);
    at = e;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

function BillingTag({ billing, onDemand }: { billing: ServiceBilling; onDemand?: boolean }) {
  if (onDemand) return <span className="qb-tag order">לפי הזמנה</span>;
  return billing === "monthly" ? <span className="qb-tag monthly">חודשי</span> : <span className="qb-tag setup">הקמה</span>;
}

function ServiceRow({ s, terms, added, active, showCategory, rowRef, onToggle }: {
  s: CatalogService;
  terms: string[];
  added: boolean;
  active: boolean;
  showCategory?: boolean;
  rowRef: (el: HTMLDivElement | null) => void;
  onToggle: () => void;
}) {
  return (
    <div
      ref={rowRef}
      role="button"
      tabIndex={-1}
      aria-pressed={added}
      className={`qb-row${added ? " added" : ""}${active ? " active" : ""}`}
      onClick={onToggle}
    >
      <span className="qb-check" aria-hidden="true">{added ? "✓" : "+"}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span className="qb-name"><Highlight text={s.name} terms={terms} /></span>
          {s.role === "core" && <span className="qb-tag core">מרכזי</span>}
          <BillingTag billing={s.billing} onDemand={s.onDemand} />
          {showCategory && <span className="t-meta" style={{ fontSize: 11 }}>{s.categoryName}</span>}
        </div>
        <div className="qb-desc"><Highlight text={s.description} terms={terms} /></div>
      </div>
      <div className="qb-price">
        {formatIls(s.price)}
        <small>{s.billing === "monthly" ? "לחודש" : s.onDemand ? "להזמנה" : "חד-פעמי"}</small>
      </div>
    </div>
  );
}

function LineRow({ l, onQty, onRemove, onPatch }: {
  l: LineState;
  onQty: (q: number) => void;
  onRemove: () => void;
  onPatch: (p: Partial<LineState>) => void;
}) {
  if (l.custom) {
    return (
      <div style={{ display: "grid", gap: 6, padding: "10px", borderRadius: "var(--r-3)", background: "var(--bg)", border: "1px dashed var(--rule-strong)" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span className="qb-tag order">מותאם</span>
          <Input value={l.name} onChange={e => onPatch({ name: e.target.value })} placeholder="שם השירות" style={{ flex: 1, minWidth: 0 }} />
          <button type="button" className="qb-x" onClick={onRemove} aria-label="הסר">×</button>
        </div>
        <Input value={l.description} onChange={e => onPatch({ description: e.target.value })} placeholder="תיאור קצר (מופיע בהצעה)" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 6, alignItems: "center" }}>
          <select className="input" value={l.billing} onChange={e => onPatch({ billing: e.target.value as ServiceBilling })}>
            <option value="setup">הקמה</option>
            <option value="monthly">חודשי</option>
          </select>
          <Input type="number" min={0} value={l.price} onChange={e => onPatch({ price: Math.max(0, Number(e.target.value) || 0) })} placeholder={'מחיר לפני מע"מ'} />
          <Qty value={l.qty} onChange={onQty} />
        </div>
      </div>
    );
  }
  return (
    <div className="qb-line">
      <div style={{ minWidth: 0 }}>
        <div className="nm">{l.name}</div>
        <div className="sub">{formatIls(l.price)}{l.billing === "monthly" ? " לחודש" : ""}{l.onDemand ? " · לפי הזמנה" : ""}</div>
      </div>
      <Qty value={l.qty} onChange={onQty} />
      <span className="tot">{formatIls(l.price * l.qty)}</span>
      <button type="button" className="qb-x" onClick={onRemove} aria-label={`הסר ${l.name}`}>×</button>
    </div>
  );
}

function Qty({ value, onChange }: { value: number; onChange: (q: number) => void }) {
  return (
    <span className="qb-qty" aria-label="כמות">
      <button type="button" onClick={() => onChange(value - 1)} disabled={value <= 1} aria-label="הפחת">−</button>
      <span>{value}</span>
      <button type="button" onClick={() => onChange(value + 1)} aria-label="הוסף">+</button>
    </span>
  );
}

function MiniField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-3)" }}>{label}</span>
      {children}
    </label>
  );
}

function SearchIcon() {
  return (
    <svg className="qb-search-ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}
