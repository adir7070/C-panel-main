import { useEffect, useState } from "react";
import type { AvatarConfig } from "../../api/client";
import { Modal } from "../ui/Modal";
import { Field } from "../ui/Field";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { AvatarStyleIcon } from "../icons/BrandIcons";

interface Props {
  open: boolean;
  value?: AvatarConfig;
  onClose: () => void;
  onSave: (cfg: AvatarConfig) => void;
}

const VISUAL_STYLES: { id: NonNullable<AvatarConfig["visualStyle"]>; label: string; emoji: string }[] = [
  { id: "caricature", label: "קריקטורה",  emoji: "🎨" },
  { id: "realistic",  label: "ריאליסטי",  emoji: "📸" },
  { id: "semiReal",   label: "חצי ריאל",  emoji: "🖼" },
  { id: "3d",         label: "תלת מימד",  emoji: "🧊" },
  { id: "vector",     label: "וקטור",     emoji: "✏️" },
  { id: "anime",      label: "אנימה",     emoji: "🌸" },
  { id: "pixel",      label: "פיקסל",     emoji: "👾" },
  { id: "mascot",     label: "מסקוט",     emoji: "🐻" },
  { id: "myPhoto",    label: "תמונה שלי", emoji: "📷" },
];

const DESCRIPTIONS: { id: NonNullable<AvatarConfig["description"]>; label: string; hint: string }[] = [
  { id: "preciseMe",    label: "עליי במדויק",   hint: "דמות זהה לבעל העסק" },
  { id: "upgradedMe",   label: "גרסה משודרגת",   hint: "אני, רק יותר טוב" },
  { id: "fictional",    label: "דמות פיקטיבית", hint: "המצאה מלאה" },
  { id: "professional", label: "מקצועית",        hint: "פרזנטור גנרי" },
];

const GENDERS: { id: NonNullable<AvatarConfig["gender"]>; label: string }[] = [
  { id: "male",   label: "זכר" },
  { id: "female", label: "נקבה" },
  { id: "other",  label: "אחר" },
];

const ENERGIES: { id: NonNullable<AvatarConfig["energy"]>; label: string }[] = [
  { id: "calm",          label: "רגועה" },
  { id: "energetic",     label: "אנרגטית" },
  { id: "authoritative", label: "סמכותית" },
  { id: "smiling",       label: "חייכנית" },
  { id: "mysterious",    label: "מסתורית" },
  { id: "light",         label: "קלילה" },
];

const DRESSES: { id: NonNullable<AvatarConfig["dress"]>; label: string }[] = [
  { id: "formal",       label: "רשמי" },
  { id: "casual",       label: "קז'ואל" },
  { id: "sport",        label: "ספורטיבי" },
  { id: "luxury",       label: "יוקרתי" },
  { id: "futuristic",   label: "עתידני" },
  { id: "professional", label: "מקצועי" },
];

const SKIN_TONES = ["#F8D5B0", "#E8B998", "#C99670", "#A87253", "#7D4F37", "#4F2E1E"];
const HAIR_COLORS = ["שחור", "חום כהה", "חום בהיר", "בלונד", "אדום", "אפור", "לבן", "צבעוני", "קרח"];

export function AvatarDesigner({ open, value, onClose, onSave }: Props) {
  const [cfg, setCfg] = useState<AvatarConfig>({});

  useEffect(() => { if (open) setCfg(value ?? {}); }, [open, value]);

  function patch<K extends keyof AvatarConfig>(k: K, v: AvatarConfig[K]) {
    setCfg(c => ({ ...c, [k]: v }));
  }

  function handleSave() { onSave(cfg); onClose(); }

  return (
    <Modal open={open} onClose={onClose} eyebrow="AI Presenter" title="עיצוב אווטר" size="xl"
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--s-3)" }}>
          <Button variant="ghost" onClick={onClose}>בטל</Button>
          <Button onClick={handleSave}>שמור אווטר</Button>
        </div>
      }
    >
      <div style={{ display: "grid", gap: "var(--s-6)", paddingBottom: "var(--s-4)" }}>

        <Group label="סגנון ויזואלי">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--s-2)" }}>
            {VISUAL_STYLES.map(s => (
              <Chip key={s.id} active={cfg.visualStyle === s.id} onClick={() => patch("visualStyle", s.id)}>
                <AvatarStyleIcon styleKey={s.id} size={18} /> {s.label}
              </Chip>
            ))}
          </div>
        </Group>

        <Group label="תיאור הדמות">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "var(--s-2)" }}>
            {DESCRIPTIONS.map(d => (
              <Chip key={d.id} active={cfg.description === d.id} onClick={() => patch("description", d.id)} block>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                  <span style={{ fontWeight: 700 }}>{d.label}</span>
                  <span style={{ fontSize: 11, opacity: 0.7 }}>{d.hint}</span>
                </div>
              </Chip>
            ))}
          </div>
        </Group>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--s-5)" }}>
          <Group label="מגדר">
            <div style={{ display: "flex", gap: "var(--s-2)" }}>
              {GENDERS.map(g => (
                <Chip key={g.id} active={cfg.gender === g.id} onClick={() => patch("gender", g.id)}>{g.label}</Chip>
              ))}
            </div>
          </Group>
          <Field label="גיל">
            <Input value={cfg.age ?? ""} onChange={e => patch("age", e.target.value)} placeholder="לדוגמה: 32" />
          </Field>
        </div>

        <Group label="צבע עור">
          <div style={{ display: "flex", gap: "var(--s-2)" }}>
            {SKIN_TONES.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => patch("skinTone", c)}
                title={c}
                style={{
                  width: 48, height: 48,
                  background: c,
                  border: cfg.skinTone === c ? "3px solid var(--blue)" : "1px solid var(--rule-strong)",
                  borderRadius: "50%",
                  cursor: "pointer",
                  padding: 0,
                }}
              />
            ))}
          </div>
        </Group>

        <Group label="שיער">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-2)" }}>
            {HAIR_COLORS.map(h => (
              <Chip key={h} active={cfg.hair === h} onClick={() => patch("hair", h)}>{h}</Chip>
            ))}
          </div>
        </Group>

        <Field label="פרטים נוספים" hint="זקן, משקפיים, קעקועים, עגיל…">
          <Input value={cfg.extras ?? ""} onChange={e => patch("extras", e.target.value)} placeholder="לדוגמה: זקן קצר ומשקפיים שחורים" />
        </Field>

        <Group label="אנרגיה">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-2)" }}>
            {ENERGIES.map(e => (
              <Chip key={e.id} active={cfg.energy === e.id} onClick={() => patch("energy", e.id)}>{e.label}</Chip>
            ))}
          </div>
        </Group>

        <Group label="לבוש">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s-2)" }}>
            {DRESSES.map(d => (
              <Chip key={d.id} active={cfg.dress === d.id} onClick={() => patch("dress", d.id)}>{d.label}</Chip>
            ))}
          </div>
        </Group>

        <Field label="תמונת השראה" hint="קישור לתמונה (אופציונלי)">
          <Input dir="ltr" value={cfg.inspirationUrl ?? ""} onChange={e => patch("inspirationUrl", e.target.value)} placeholder="https://…" />
        </Field>

      </div>
    </Modal>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="t-eyebrow" style={{ marginBottom: "var(--s-3)" }}>{label}</p>
      {children}
    </div>
  );
}

function Chip({ active, onClick, block, children }: { active?: boolean; onClick: () => void; block?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "8px 14px",
        background: active ? "var(--blue)" : "var(--paper)",
        color: active ? "#fff" : "var(--ink)",
        border: "1px solid " + (active ? "var(--blue)" : "var(--rule-strong)"),
        borderRadius: "var(--r-2)",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: 600,
        width: block ? "100%" : "auto",
        justifyContent: block ? "flex-start" : "center",
        textAlign: "right",
      }}
    >
      {children}
    </button>
  );
}
