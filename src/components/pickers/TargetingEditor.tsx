import { useEffect, useMemo, useState } from "react";
import type { FbTargeting, FbLocation, FbInterest, FbGender } from "../../api/client";
import {
  FB_LANGUAGES,
  ISRAEL_REGIONS,
  ISRAEL_CITIES,
  FB_TARGETING_OPTIONS,
  FB_TARGETING_CATEGORIES,
  toFbInterest,
  type FbTargetingOption,
} from "../../data/fb-targeting";
import { Modal } from "../ui/Modal";
import { IcoCheck, IcoXMark } from "../icons/BrandIcons";
import { Field } from "../ui/Field";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";

interface Props {
  open: boolean;
  serviceTitle?: string;
  value?: FbTargeting;
  onClose: () => void;
  onSave: (t: FbTargeting) => void;
}

const DEFAULT_TARGETING: FbTargeting = {
  ageMin: 18,
  ageMax: 65,
  genders: ["all"],
  languages: [],
  locations: [{ type: "country", name: "ישראל", key: "IL", include: true }],
  detailed: [],
  customInterests: [],
  connection: "any",
  customAudiences: [],
};

const KIND_LABEL: Record<FbInterest["kind"], string> = {
  interest:    "תחום עניין",
  behavior:    "התנהגות",
  demographic: "דמוגרפי",
};

const KIND_COLOR: Record<FbInterest["kind"], string> = {
  interest:    "#1E3A8A",
  behavior:    "#7C3AED",
  demographic: "#0891B2",
};

export function TargetingEditor({ open, serviceTitle, value, onClose, onSave }: Props) {
  const [t, setT] = useState<FbTargeting>(DEFAULT_TARGETING);

  useEffect(() => {
    if (!open) return;
    setT({ ...DEFAULT_TARGETING, ...(value ?? {}) });
  }, [open, value]);

  function patch<K extends keyof FbTargeting>(k: K, v: FbTargeting[K]) {
    setT(prev => ({ ...prev, [k]: v }));
  }

  function handleSave() { onSave(t); onClose(); }

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Audience"
      title={serviceTitle ? `טירגוט פייסבוק — ${serviceTitle}` : "טירגוט פייסבוק"}
      size="xl"
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--s-3)" }}>
          <Button variant="ghost" onClick={onClose}>בטל</Button>
          <Button onClick={handleSave}>שמור טירגוט</Button>
        </div>
      }
    >
      <div style={{ display: "grid", gap: "var(--s-6)", paddingBottom: "var(--s-3)" }}>

        {/* — Demographics — */}
        <Section title="פרטים דמוגרפיים" subtitle="גיל, מגדר ושפות">
          <AgeRange
            min={t.ageMin ?? 18}
            max={t.ageMax ?? 65}
            onChange={(min, max) => { patch("ageMin", min); patch("ageMax", max); }}
          />
          <GenderPicker
            value={t.genders ?? ["all"]}
            onChange={(g) => patch("genders", g)}
          />
          <LanguagesPicker
            value={t.languages ?? []}
            onChange={(l) => patch("languages", l)}
          />
        </Section>

        {/* — Location — */}
        <Section title="מיקום גיאוגרפי" subtitle="ערים, מחוזות וכתובות עם רדיוס">
          <LocationPicker
            value={t.locations ?? []}
            onChange={(loc) => patch("locations", loc)}
          />
        </Section>

        {/* — Detailed Targeting — */}
        <Section title="טירגוט מפורט" subtitle="תחומי עניין, התנהגויות ודמוגרפיה">
          <DetailedTargeting
            selected={t.detailed ?? []}
            onChange={(d) => patch("detailed", d)}
            customInterests={t.customInterests ?? []}
            onChangeCustom={(c) => patch("customInterests", c)}
          />
        </Section>

        {/* — Connections — */}
        <Section title="חיבורים" subtitle="מקושרים לעמוד / חברים של מקושרים / לא מקושרים">
          <ConnectionPicker
            value={t.connection ?? "any"}
            onChange={(c) => patch("connection", c)}
          />
        </Section>

        {/* — Custom Audiences placeholder — */}
        <Section title="קהלים מותאמים אישית" subtitle="ייובאו אוטומטית מחשבון הפייסבוק של הלקוח">
          <p className="t-meta" style={{ fontSize: 12 }}>
            כשהלקוח יחבר את חשבון הפרסום שלו, נטען כאן את כל ה-Custom Audiences וה-Lookalikes שלו.
          </p>
        </Section>

      </div>
    </Modal>
  );
}

/* ────────────────────────────────────────────────────────────────────
   Section wrapper
   ──────────────────────────────────────────────────────────────────── */

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: "var(--s-4)" }}>
      <div>
        <h4 style={{ font: "inherit", fontSize: 14, fontWeight: 800, color: "var(--ink)", margin: 0 }}>{title}</h4>
        {subtitle && <p className="t-meta" style={{ fontSize: 11, marginTop: 2 }}>{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   Age range — dual-handle slider
   ──────────────────────────────────────────────────────────────────── */

function AgeRange({ min, max, onChange }: { min: number; max: number; onChange: (min: number, max: number) => void }) {
  return (
    <div>
      <p className="t-eyebrow" style={{ marginBottom: 8 }}>גילאים</p>
      <div style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr 1fr auto",
        alignItems: "center",
        gap: "var(--s-3)",
        background: "var(--paper)",
        border: "1px solid var(--rule)",
        borderRadius: "var(--r-2)",
        padding: "10px 14px",
      }}>
        <span className="num" style={{ fontWeight: 800, fontSize: 16, color: "var(--blue)" }}>{min}</span>
        <input
          type="range"
          min={13}
          max={65}
          value={min}
          onChange={e => {
            const v = parseInt(e.target.value, 10);
            onChange(v, Math.max(v, max));
          }}
          style={{ accentColor: "var(--blue)" }}
        />
        <input
          type="range"
          min={13}
          max={65}
          value={max}
          onChange={e => {
            const v = parseInt(e.target.value, 10);
            onChange(Math.min(min, v), v);
          }}
          style={{ accentColor: "var(--blue)" }}
        />
        <span className="num" style={{ fontWeight: 800, fontSize: 16, color: "var(--blue)" }}>{max === 65 ? "65+" : max}</span>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   Gender picker
   ──────────────────────────────────────────────────────────────────── */

function GenderPicker({ value, onChange }: { value: FbGender[]; onChange: (v: FbGender[]) => void }) {
  const isAll = value.includes("all") || value.length === 0;
  const isMale = !isAll && value.includes("male");
  const isFemale = !isAll && value.includes("female");

  function pick(g: "all" | "male" | "female") {
    if (g === "all") return onChange(["all"]);
    if (g === "male")   return onChange(["male"]);
    if (g === "female") return onChange(["female"]);
  }

  return (
    <div>
      <p className="t-eyebrow" style={{ marginBottom: 8 }}>מגדר</p>
      <div style={{ display: "flex", gap: "var(--s-2)" }}>
        <ChipBtn active={isAll}    onClick={() => pick("all")}>כולם</ChipBtn>
        <ChipBtn active={isMale}   onClick={() => pick("male")}>גברים</ChipBtn>
        <ChipBtn active={isFemale} onClick={() => pick("female")}>נשים</ChipBtn>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   Languages picker
   ──────────────────────────────────────────────────────────────────── */

function LanguagesPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div>
      <p className="t-eyebrow" style={{ marginBottom: 8 }}>שפות (השאר ריק כדי לא להגביל)</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-2)" }}>
        {FB_LANGUAGES.map(l => {
          const active = value.includes(l.code);
          return (
            <ChipBtn
              key={l.code}
              active={active}
              onClick={() => onChange(active ? value.filter(c => c !== l.code) : [...value, l.code])}
            >{l.label}</ChipBtn>
          );
        })}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   Location picker
   ──────────────────────────────────────────────────────────────────── */

function LocationPicker({ value, onChange }: { value: FbLocation[]; onChange: (v: FbLocation[]) => void }) {
  const [tab, setTab] = useState<"city" | "region" | "address">("city");
  const [search, setSearch] = useState("");
  const [addrName, setAddrName] = useState("");
  const [addrRadius, setAddrRadius] = useState(15);

  const filtered = useMemo(() => {
    const q = search.trim();
    if (tab === "city") {
      return ISRAEL_CITIES.filter(c => !q || c.label.includes(q));
    }
    if (tab === "region") {
      return ISRAEL_REGIONS.filter(r => !q || r.label.includes(q));
    }
    return [];
  }, [tab, search]);

  function addLocation(loc: FbLocation) {
    /* Avoid duplicates by (type+key/name) */
    const dupe = value.some(v => v.type === loc.type && (v.key ? v.key === loc.key : v.name === loc.name));
    if (dupe) return;
    onChange([...value, loc]);
  }

  function toggleInclude(idx: number) {
    onChange(value.map((v, i) => i === idx ? { ...v, include: !v.include } : v));
  }
  function setRadius(idx: number, r: number) {
    onChange(value.map((v, i) => i === idx ? { ...v, radiusKm: r } : v));
  }
  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }

  return (
    <div style={{ display: "grid", gap: "var(--s-4)" }}>
      {/* Tabs */}
      <div style={{ display: "flex", gap: 4 }}>
        {(["city", "region", "address"] as const).map(k => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            style={{
              padding: "8px 14px",
              background: tab === k ? "var(--blue)" : "transparent",
              color:  tab === k ? "#fff" : "var(--ink-2)",
              border: "1px solid " + (tab === k ? "var(--blue)" : "var(--rule)"),
              borderRadius: "var(--r-2)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {k === "city" ? "ערים" : k === "region" ? "מחוזות" : "כתובת ברדיוס"}
          </button>
        ))}
      </div>

      {/* City / Region search */}
      {(tab === "city" || tab === "region") && (
        <>
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={tab === "city" ? "חפש עיר…" : "חפש מחוז…"}
          />
          <div style={{
            maxHeight: 180,
            overflowY: "auto",
            border: "1px solid var(--rule)",
            borderRadius: "var(--r-2)",
            background: "var(--paper)",
          }}>
            {filtered.map(opt => (
              <button
                key={opt.key}
                type="button"
                onClick={() => addLocation({
                  type: tab,
                  name: opt.label,
                  key:  opt.key,
                  include: true,
                  ...(tab === "city" ? { radiusKm: 15 } : {}),
                })}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "right",
                  padding: "8px 14px",
                  background: "transparent",
                  border: 0,
                  borderBottom: "1px solid var(--rule)",
                  cursor: "pointer",
                  fontSize: 13,
                  color: "var(--ink)",
                }}
              >+ {opt.label}</button>
            ))}
            {filtered.length === 0 && (
              <p className="t-meta" style={{ padding: "10px 14px" }}>לא נמצאו תוצאות</p>
            )}
          </div>
        </>
      )}

      {/* Address with radius */}
      {tab === "address" && (
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: "var(--s-3)", alignItems: "end" }}>
          <Field label="כתובת">
            <Input value={addrName} onChange={e => setAddrName(e.target.value)} placeholder="לדוגמה: דיזנגוף 123, תל אביב" />
          </Field>
          <Field label={`רדיוס: ${addrRadius} ק"מ`}>
            <input
              type="range"
              min={1}
              max={80}
              value={addrRadius}
              onChange={e => setAddrRadius(parseInt(e.target.value, 10))}
              style={{ width: "100%", accentColor: "var(--blue)" }}
            />
          </Field>
          <Button
            size="sm"
            onClick={() => {
              if (!addrName.trim()) return;
              addLocation({ type: "address", name: addrName.trim(), radiusKm: addrRadius, include: true });
              setAddrName("");
            }}
          >הוסף</Button>
        </div>
      )}

      {/* Selected locations */}
      {value.length > 0 && (
        <div style={{ display: "grid", gap: "var(--s-2)" }}>
          <p className="t-eyebrow" style={{ fontSize: 11 }}>מיקומים נבחרים ({value.length})</p>
          {value.map((loc, i) => (
            <div key={i} style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr auto auto auto",
              alignItems: "center",
              gap: "var(--s-3)",
              padding: "8px 12px",
              background: loc.include ? "var(--paper)" : "rgba(220,38,38,0.06)",
              border: "1px solid " + (loc.include ? "var(--rule)" : "rgba(220,38,38,0.3)"),
              borderRadius: "var(--r-1)",
            }}>
              <span style={{
                fontSize: 10, fontWeight: 800,
                padding: "2px 8px",
                background: loc.include ? "rgba(16,185,129,0.15)" : "rgba(220,38,38,0.15)",
                color: loc.include ? "#065f46" : "#991b1b",
                borderRadius: 999,
              }}>{loc.include ? "כלול" : "החרגה"}</span>

              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {loc.name}
                {loc.type === "address" || loc.type === "city" ? (
                  <span className="num" style={{ marginInlineStart: 8, color: "var(--ink-3)", fontSize: 11 }}>
                    +{loc.radiusKm ?? 15} ק"מ
                  </span>
                ) : null}
              </span>

              {(loc.type === "city" || loc.type === "address") && (
                <input
                  type="range"
                  min={1}
                  max={80}
                  value={loc.radiusKm ?? 15}
                  onChange={e => setRadius(i, parseInt(e.target.value, 10))}
                  style={{ width: 100, accentColor: "var(--blue)" }}
                />
              )}

              <button
                type="button"
                onClick={() => toggleInclude(i)}
                title="כלול / החרגה"
                style={{
                  padding: "4px 10px",
                  fontSize: 11,
                  fontWeight: 700,
                  background: "transparent",
                  border: "1px solid var(--rule-strong)",
                  borderRadius: "var(--r-1)",
                  cursor: "pointer",
                }}
              >{loc.include ? "החרג" : "כלול"}</button>

              <button
                type="button"
                onClick={() => remove(i)}
                title="הסר"
                style={{
                  width: 26, height: 26,
                  borderRadius: "50%",
                  background: "rgba(0,0,0,0.06)",
                  border: 0,
                  cursor: "pointer",
                  fontSize: 16,
                }}><IcoXMark size={12} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   Detailed targeting (interests + behaviors + demographics merged)
   ──────────────────────────────────────────────────────────────────── */

function DetailedTargeting({
  selected, onChange, customInterests, onChangeCustom,
}: {
  selected: FbInterest[];
  onChange: (v: FbInterest[]) => void;
  customInterests: string[];
  onChangeCustom: (v: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [activeCat, setActiveCat] = useState<string>(FB_TARGETING_CATEGORIES[0]);
  const [customInput, setCustomInput] = useState("");

  const matches = useMemo(() => {
    const q = search.trim();
    if (!q) return [];
    return FB_TARGETING_OPTIONS.filter(o => o.name.includes(q) || o.category.includes(q)).slice(0, 30);
  }, [search]);

  const inCategory = useMemo(() => {
    return FB_TARGETING_OPTIONS.filter(o => o.category === activeCat);
  }, [activeCat]);

  function isSelected(id: string) { return selected.some(s => s.id === id); }

  function toggle(opt: FbTargetingOption) {
    if (isSelected(opt.id)) {
      onChange(selected.filter(s => s.id !== opt.id));
    } else {
      onChange([...selected, toFbInterest(opt)]);
    }
  }

  function addCustom() {
    const t = customInput.trim();
    if (!t || customInterests.includes(t)) { setCustomInput(""); return; }
    onChangeCustom([...customInterests, t]);
    setCustomInput("");
  }

  function removeCustom(s: string) {
    onChangeCustom(customInterests.filter(x => x !== s));
  }

  return (
    <div style={{ display: "grid", gap: "var(--s-4)" }}>
      {/* Search */}
      <Input
        value={search}
        onChange={e => setSearch(e.target.value)}
        placeholder="חפש תחום עניין, התנהגות או מאפיין דמוגרפי…"
      />

      {search.trim() ? (
        /* Search results */
        <div style={{
          maxHeight: 260, overflowY: "auto",
          border: "1px solid var(--rule)",
          borderRadius: "var(--r-2)",
          background: "var(--paper)",
        }}>
          {matches.length === 0 && (
            <p className="t-meta" style={{ padding: "12px 14px" }}>
              לא נמצאו אפשרויות מובנות. תוכל להוסיף "{search.trim()}" כתחום עניין מותאם בהמשך.
            </p>
          )}
          {matches.map(opt => (
            <button
              key={opt.id}
              type="button"
              onClick={() => toggle(opt)}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                alignItems: "center",
                gap: 10,
                width: "100%",
                textAlign: "right",
                padding: "10px 14px",
                background: isSelected(opt.id) ? "rgba(30,58,138,0.06)" : "transparent",
                border: 0,
                borderBottom: "1px solid var(--rule)",
                cursor: "pointer",
                color: "var(--ink)",
              }}
            >
              <span style={{
                fontSize: 9, fontWeight: 800,
                padding: "2px 7px",
                background: KIND_COLOR[opt.kind] + "1a",
                color: KIND_COLOR[opt.kind],
                borderRadius: 999,
              }}>{KIND_LABEL[opt.kind]}</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {opt.name}
                <span className="t-meta" style={{ fontSize: 10, marginInlineStart: 8 }}>{opt.category}</span>
              </span>
              <span style={{
                width: 22, height: 22, borderRadius: "50%",
                background: isSelected(opt.id) ? "var(--blue)" : "transparent",
                color: isSelected(opt.id) ? "#fff" : "var(--ink-2)",
                border: "1px solid " + (isSelected(opt.id) ? "var(--blue)" : "var(--rule-strong)"),
                fontSize: 14, fontWeight: 800,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>{isSelected(opt.id) ? <IcoCheck size={12} color="#fff" /> : "+"}</span>
            </button>
          ))}
        </div>
      ) : (
        /* Browse by category */
        <div style={{
          display: "grid",
          gridTemplateColumns: "180px 1fr",
          gap: "var(--s-3)",
          border: "1px solid var(--rule)",
          borderRadius: "var(--r-2)",
          background: "var(--paper)",
          maxHeight: 320,
          overflow: "hidden",
        }}>
          {/* Category list */}
          <div style={{
            borderInlineEnd: "1px solid var(--rule)",
            overflowY: "auto",
          }}>
            {FB_TARGETING_CATEGORIES.map(cat => (
              <button
                key={cat}
                type="button"
                onClick={() => setActiveCat(cat)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "right",
                  padding: "10px 14px",
                  background: activeCat === cat ? "rgba(30,58,138,0.08)" : "transparent",
                  border: 0,
                  borderBottom: "1px solid var(--rule)",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: activeCat === cat ? 800 : 600,
                  color: activeCat === cat ? "var(--blue)" : "var(--ink)",
                }}
              >{cat}</button>
            ))}
          </div>

          {/* Items in active category */}
          <div style={{ overflowY: "auto", padding: "10px 14px" }}>
            {inCategory.map(opt => (
              <button
                key={opt.id}
                type="button"
                onClick={() => toggle(opt)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  textAlign: "right",
                  padding: "8px 0",
                  background: "transparent",
                  border: 0,
                  borderBottom: "1px solid var(--rule)",
                  cursor: "pointer",
                  color: "var(--ink)",
                }}
              >
                <span style={{
                  fontSize: 9, fontWeight: 800,
                  padding: "2px 7px",
                  background: KIND_COLOR[opt.kind] + "1a",
                  color: KIND_COLOR[opt.kind],
                  borderRadius: 999,
                }}>{KIND_LABEL[opt.kind]}</span>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{opt.name}</span>
                <span style={{
                  width: 22, height: 22, borderRadius: "50%",
                  background: isSelected(opt.id) ? "var(--blue)" : "transparent",
                  color: isSelected(opt.id) ? "#fff" : "var(--ink-2)",
                  border: "1px solid " + (isSelected(opt.id) ? "var(--blue)" : "var(--rule-strong)"),
                  fontSize: 14, fontWeight: 800,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>{isSelected(opt.id) ? <IcoCheck size={12} color="#fff" /> : "+"}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Selected (chips) */}
      {selected.length > 0 && (
        <div style={{ display: "grid", gap: "var(--s-2)" }}>
          <p className="t-eyebrow" style={{ fontSize: 11 }}>נבחרו ({selected.length})</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {selected.map(s => (
              <span key={s.id} style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 10px",
                background: KIND_COLOR[s.kind] + "1a",
                color: KIND_COLOR[s.kind],
                border: "1px solid " + KIND_COLOR[s.kind] + "55",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 700,
              }}>
                <span style={{ fontSize: 9, opacity: 0.8 }}>{KIND_LABEL[s.kind]}</span>
                {s.name}
                <button
                  type="button"
                  onClick={() => onChange(selected.filter(x => x.id !== s.id))}
                  style={{ background: "transparent", border: 0, cursor: "pointer", color: "inherit", fontSize: 14, padding: 0 }}
                ><IcoXMark size={12} /></button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Custom interests (free text) */}
      <div>
        <p className="t-eyebrow" style={{ marginBottom: 8 }}>תחומי עניין מותאמים (חיפוש חופשי)</p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "var(--s-3)" }}>
          <Input
            value={customInput}
            onChange={e => setCustomInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }}
            placeholder="לדוגמה: שמלות כלה, איפור עיניים, גיטרה אקוסטית"
          />
          <Button size="sm" onClick={addCustom}>הוסף</Button>
        </div>
        {customInterests.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: "var(--s-3)" }}>
            {customInterests.map(s => (
              <span key={s} style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 10px",
                background: "var(--bg-tint)",
                color: "var(--ink-2)",
                border: "1px dashed var(--rule-strong)",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 700,
              }}>
                {s}
                <button
                  type="button"
                  onClick={() => removeCustom(s)}
                  style={{ background: "transparent", border: 0, cursor: "pointer", color: "inherit", fontSize: 14, padding: 0 }}
                ><IcoXMark size={12} /></button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   Connection picker
   ──────────────────────────────────────────────────────────────────── */

function ConnectionPicker({ value, onChange }: { value: NonNullable<FbTargeting["connection"]>; onChange: (v: NonNullable<FbTargeting["connection"]>) => void }) {
  const opts: { id: NonNullable<FbTargeting["connection"]>; label: string; hint: string }[] = [
    { id: "any",           label: "כל אחד",                  hint: "ברירת מחדל — בלי הגבלת חיבור" },
    { id: "connected",     label: "מקושרים לעמוד שלי",       hint: "מי שעוקב/לייק לדף הפייסבוק" },
    { id: "not_connected", label: "לא מקושרים לעמוד שלי",     hint: "להגיע לקהל חדש שטרם נחשף" },
    { id: "friends_of",    label: "חברים של מקושרים",         hint: "תנופה מבוססת רשתות" },
  ];
  return (
    <div style={{ display: "grid", gap: "var(--s-2)" }}>
      {opts.map(o => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            alignItems: "center",
            gap: 12,
            padding: "10px 14px",
            background: value === o.id ? "rgba(30,58,138,0.06)" : "var(--paper)",
            border: "1px solid " + (value === o.id ? "var(--blue)" : "var(--rule)"),
            borderRadius: "var(--r-2)",
            cursor: "pointer",
            textAlign: "right",
          }}
        >
          <span style={{
            width: 18, height: 18, borderRadius: "50%",
            background: value === o.id ? "var(--blue)" : "transparent",
            border: "2px solid " + (value === o.id ? "var(--blue)" : "var(--rule-strong)"),
          }} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{o.label}</div>
            <div className="t-meta" style={{ fontSize: 11, marginTop: 2 }}>{o.hint}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   Small chip button
   ──────────────────────────────────────────────────────────────────── */

function ChipBtn({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "7px 14px",
        background: active ? "var(--blue)" : "var(--paper)",
        color: active ? "#fff" : "var(--ink)",
        border: "1px solid " + (active ? "var(--blue)" : "var(--rule-strong)"),
        borderRadius: 999,
        cursor: "pointer",
        fontSize: 12,
        fontWeight: 700,
      }}
    >{children}</button>
  );
}

/* ────────────────────────────────────────────────────────────────────
   Compact summary — used in the service editor to show what's saved.
   ──────────────────────────────────────────────────────────────────── */

export function targetingSummary(t: FbTargeting | undefined): string {
  if (!t) return "טרם הוגדר";
  const parts: string[] = [];
  if (t.ageMin && t.ageMax) parts.push(`גילאי ${t.ageMin}–${t.ageMax === 65 ? "65+" : t.ageMax}`);
  const g = t.genders ?? ["all"];
  if (g[0] && g[0] !== "all") parts.push(g[0] === "male" ? "גברים" : "נשים");
  if (t.locations?.length) parts.push(`${t.locations.length} מיקומים`);
  if (t.languages?.length) parts.push(`${t.languages.length} שפות`);
  if (t.detailed?.length || t.customInterests?.length) {
    const total = (t.detailed?.length || 0) + (t.customInterests?.length || 0);
    parts.push(`${total} תחומים`);
  }
  return parts.length ? parts.join(" · ") : "ברירת מחדל";
}
