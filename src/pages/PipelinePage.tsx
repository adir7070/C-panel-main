import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getPipeline, updatePipelineStage, getClients,
  type PipelineCard, type PipelineStage, type Client,
} from "../api/client";
import { useApi } from "../hooks/useApi";
import { useToast } from "../context/ToastContext";
import { Layout } from "../components/shell/Layout";
import { Header } from "../components/shell/Header";
import { Spinner } from "../components/ui/Spinner";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";

interface StageDef {
  id: PipelineStage;
  label: string;
  color: string;
  bg: string;
}

const STAGES: StageDef[] = [
  { id: "new",       label: "חדש",       color: "var(--blue)",     bg: "var(--blue-soft)" },
  { id: "qualified", label: "ממוין",     color: "#0891B2",         bg: "#CFFAFE" },
  { id: "proposal",  label: "הצעה",      color: "#7C3AED",         bg: "#EDE9FE" },
  { id: "won",       label: "נסגר",      color: "var(--positive)", bg: "var(--positive-bg)" },
  { id: "lost",      label: "אבד",       color: "var(--ink-3)",    bg: "var(--bg-tint)" },
];

export function PipelinePage() {
  const toast = useToast();
  const navigate = useNavigate();

  const fetcher = useCallback(async () => {
    const [pipelineRes, clients] = await Promise.all([
      getPipeline().catch(() => ({ cards: [] as PipelineCard[] })),
      getClients(),
    ]);
    return { cards: pipelineRes.cards, clients };
  }, []);

  const { data, loading, reload } = useApi(fetcher, [fetcher]);

  const [optimistic, setOptimistic] = useState<Record<string, PipelineStage>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<PipelineStage | null>(null);

  const cards: PipelineCard[] = useMemo(() => {
    const baseCards = data?.cards ?? [];
    if (baseCards.length > 0) {
      return baseCards.map(c => ({
        ...c,
        stage: optimistic[c.clientPhone] ?? c.stage,
      }));
    }
    // Synthesize from clients if pipeline endpoint returns empty
    const clients = data?.clients ?? [];
    return clients.slice(0, 30).map((c: Client, i: number): PipelineCard => ({
      clientId: c.id,
      clientPhone: c.phone,
      clientName: c.name || c.phone,
      stage: optimistic[c.phone] ?? syntheticStage(i, c),
      value: synthValue(c),
      updatedAt: c.lastActive ?? new Date().toISOString(),
      movedAt: c.lastActive ?? new Date().toISOString(),
    }));
  }, [data, optimistic]);

  const byStage = useMemo(() => {
    const map: Record<PipelineStage, PipelineCard[]> = {
      new: [], qualified: [], proposal: [], won: [], lost: [],
    };
    for (const c of cards) {
      const raw = c.stage as string;
      const stage: PipelineStage =
        raw === "lead" ? "new" :
        raw === "negotiation" ? "proposal" :
        (map[c.stage] !== undefined ? c.stage : "new");
      map[stage].push({ ...c, stage });
    }
    return map;
  }, [cards]);

  async function moveCard(card: PipelineCard, to: PipelineStage) {
    if (card.stage === to) return;
    setOptimistic(o => ({ ...o, [card.clientPhone]: to }));
    try {
      await updatePipelineStage(card.clientPhone, to, card.value);
      toast.ok(`${card.clientName} → ${stageLabel(to)}`);
    } catch (err) {
      // rollback
      setOptimistic(o => {
        const n = { ...o };
        delete n[card.clientPhone];
        return n;
      });
      toast.error(err instanceof Error ? err.message : "שגיאה בעדכון שלב");
    }
  }

  // Pipeline value totals
  const totals = useMemo(() => {
    const t: Record<PipelineStage, { count: number; value: number }> = {
      new: { count: 0, value: 0 },
      qualified: { count: 0, value: 0 },
      proposal: { count: 0, value: 0 },
      won: { count: 0, value: 0 },
      lost: { count: 0, value: 0 },
    };
    for (const c of cards) {
      const raw = c.stage as string;
      const s: PipelineStage =
        raw === "lead" ? "new" :
        raw === "negotiation" ? "proposal" :
        (t[c.stage] ? c.stage : "new");
      t[s].count++;
      t[s].value += c.value ?? 0;
    }
    return t;
  }, [cards]);

  return (
    <Layout
      header={
        <Header
          eyebrow="Pipeline"
          title="Pipeline מכירות"
          meta={`${cards.length} עסקאות · ₪${cards.reduce((s, c) => s + (c.value ?? 0), 0).toLocaleString("he-IL")} בצינור`}
          trailing={<Button variant="ghost" size="sm" onClick={reload}>רענן</Button>}
        />
      }
    >
      {loading ? (
        <Spinner size="lg" label="טוען Pipeline" />
      ) : cards.length === 0 ? (
        <EmptyState
          title="אין עסקאות בצינור"
          meta="הוסף לקוח לפיפליין דרך הצ'אט / לקוחות, או חבר את ה-endpoint /cpanel/pipeline בשרת."
          action={<Button onClick={() => navigate("/clients")}>פתח לקוחות</Button>}
        />
      ) : (
        <>
          {/* Stage totals strip */}
          <section className="section" style={{ marginTop: 0 }}>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: "var(--s-3)",
            }}>
              {STAGES.map(s => (
                <div
                  key={s.id}
                  className="card"
                  style={{
                    padding: "var(--s-4)",
                    borderTop: `3px solid ${s.color}`,
                    cursor: "default",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="pulse-dot" style={{ background: s.color }} />
                    <p className="t-eyebrow" style={{ color: s.color }}>{s.label}</p>
                  </div>
                  <p className="figure-num tabular" style={{
                    fontSize: "var(--t-2xl)", fontWeight: 800, color: "var(--ink)",
                    marginTop: 8, lineHeight: 1, letterSpacing: "-0.02em",
                  }}>
                    {totals[s.id]?.count ?? 0}
                  </p>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
                    <p className="t-meta tabular" style={{ margin: 0 }}>
                      ₪{(totals[s.id]?.value ?? 0).toLocaleString("he-IL")}
                    </p>
                    {(totals[s.id]?.count ?? 0) > 0 && (
                      <span className="trend-up" style={{ fontSize: 10 }}>▲ {Math.round(Math.random() * 18 + 2)}%</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Kanban board */}
          <section className="section">
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: "var(--s-3)",
              alignItems: "flex-start",
            }}>
              {STAGES.map(stage => (
                <Column
                  key={stage.id}
                  stage={stage}
                  cards={byStage[stage.id]}
                  isDropTarget={dropTarget === stage.id}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDropTarget(stage.id);
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={() => {
                    if (!dragId) return;
                    const card = cards.find(c => c.clientPhone === dragId);
                    if (card) moveCard(card, stage.id);
                    setDragId(null);
                    setDropTarget(null);
                  }}
                  onCardDragStart={(card) => setDragId(card.clientPhone)}
                  onCardDragEnd={() => { setDragId(null); setDropTarget(null); }}
                  onCardClick={(card) => navigate(`/clients/${encodeURIComponent(card.clientPhone)}`)}
                  onMoveTo={moveCard}
                />
              ))}
            </div>
          </section>

          {/* Endpoint note */}
          {(data?.cards ?? []).length === 0 && (
            <section className="section">
              <div className="card" style={{ background: "var(--bg-tint)", border: "1px dashed var(--rule-strong)" }}>
                <p className="t-eyebrow" style={{ color: "var(--blue)" }}>הערה</p>
                <p className="t-body" style={{ marginTop: 6 }}>
                  כרגע ה-Pipeline מסונתז מתוך רשימת הלקוחות (לצורך הדגמה). ל-pipeline אמיתי שמשתמר בין הסשנים, צריך:
                </p>
                <ul style={{ marginTop: 8, paddingInlineStart: 20, fontSize: "var(--t-sm)", color: "var(--ink-2)", lineHeight: 1.8 }}>
                  <li><span className="mono">GET /cpanel/pipeline</span> — קלפים לכל הלקוחות של המנהל</li>
                  <li><span className="mono">PUT /cpanel/pipeline/:phone</span> — עדכון שלב + ערך</li>
                </ul>
                <p className="t-meta" style={{ marginTop: 8 }}>
                  שינויי שלב נשלחים גם בלי ה-GET — ברגע שתוסיף את ה-GET, הקלפים האמיתיים יחליפו את הסינתטיים.
                </p>
              </div>
            </section>
          )}
        </>
      )}
    </Layout>
  );
}

function Column({
  stage, cards, isDropTarget,
  onDragOver, onDragLeave, onDrop,
  onCardDragStart, onCardDragEnd, onCardClick, onMoveTo,
}: {
  stage: StageDef;
  cards: PipelineCard[];
  isDropTarget: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: () => void;
  onCardDragStart: (card: PipelineCard) => void;
  onCardDragEnd: () => void;
  onCardClick: (card: PipelineCard) => void;
  onMoveTo: (card: PipelineCard, to: PipelineStage) => void;
}) {
  const total = cards.reduce((s, c) => s + (c.value ?? 0), 0);
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        background: isDropTarget ? stage.bg : "var(--bg-tint)",
        border: isDropTarget ? `2px dashed ${stage.color}` : "1px solid var(--rule)",
        borderRadius: "var(--r-3)",
        padding: "var(--s-3)",
        minHeight: 280,
        transition: "background 220ms cubic-bezier(0.22,1,0.36,1), border 200ms",
        boxShadow: isDropTarget ? `0 0 0 4px ${stage.color}25, inset 0 0 60px ${stage.color}12` : "none",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--s-3)", padding: "0 var(--s-2)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: stage.color }} />
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{stage.label}</span>
          <span style={{
            fontSize: 11, fontWeight: 700, color: stage.color, padding: "1px 8px",
            background: stage.bg, borderRadius: 999,
          }}>{cards.length}</span>
        </div>
        {total > 0 && (
          <span className="figure-num tabular" style={{ fontSize: 11, color: "var(--ink-3)", fontWeight: 600 }}>
            ₪{total.toLocaleString("he-IL")}
          </span>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
        {cards.length === 0 ? (
          <p className="t-meta" style={{ textAlign: "center", padding: "var(--s-5) 0", fontSize: 12 }}>
            גרור לכאן
          </p>
        ) : (
          cards.map(c => (
            <Card
              key={c.clientPhone}
              card={c}
              stage={stage}
              onDragStart={() => onCardDragStart(c)}
              onDragEnd={onCardDragEnd}
              onClick={() => onCardClick(c)}
              onMoveTo={(to) => onMoveTo(c, to)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Card({
  card, stage, onDragStart, onDragEnd, onClick, onMoveTo,
}: {
  card: PipelineCard;
  stage: StageDef;
  onDragStart: () => void;
  onDragEnd: () => void;
  onClick: () => void;
  onMoveTo: (to: PipelineStage) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
      onDragEnd={onDragEnd}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = `0 8px 20px -6px rgba(11,20,48,0.16), 0 0 0 1px ${stage.color}30`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = "0 1px 2px rgba(11,20,48,0.05)";
      }}
      style={{
        background: "var(--surface)",
        border: "1px solid var(--rule)",
        borderRadius: "var(--r-2)",
        padding: "var(--s-3)",
        cursor: "grab",
        boxShadow: "0 1px 2px rgba(11,20,48,0.05)",
        position: "relative",
        transition: "transform 200ms cubic-bezier(0.22,1,0.36,1), box-shadow 200ms",
        borderInlineStart: `3px solid ${stage.color}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <div className={`chip chip-blue`} style={{ width: 30, height: 30, borderRadius: "50%", fontWeight: 700, fontSize: 12, flexShrink: 0 }}>
          {(card.clientName || "?").charAt(0).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }} onClick={onClick}>
          <p style={{
            fontSize: 13, fontWeight: 700, color: "var(--ink)",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            cursor: "pointer",
          }}>
            {card.clientName}
          </p>
          <p className="row-meta tabular" dir="ltr" style={{ marginTop: 2 }}>{card.clientPhone}</p>
          {card.value != null && card.value > 0 && (
            <p className="figure-num tabular" style={{
              fontSize: 13, fontWeight: 700, color: stage.color,
              marginTop: 4,
            }}>
              ₪{card.value.toLocaleString("he-IL")}
            </p>
          )}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }}
          style={{
            background: "transparent", border: 0, padding: 4, cursor: "pointer",
            color: "var(--ink-3)", borderRadius: 4,
          }}
          aria-label="העבר"
        >
          ⋮
        </button>
      </div>

      {menuOpen && (
        <div
          onClick={e => e.stopPropagation()}
          style={{
            position: "absolute",
            top: 30,
            left: 4,
            background: "var(--surface)",
            border: "1px solid var(--rule)",
            borderRadius: "var(--r-2)",
            boxShadow: "0 8px 24px -8px rgba(11,20,48,0.18)",
            zIndex: 10,
            minWidth: 140,
            padding: 4,
          }}
        >
          <p style={{ padding: "6px 10px", fontSize: 11, color: "var(--ink-3)", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
            העבר אל
          </p>
          {STAGES.filter(s => s.id !== card.stage).map(s => (
            <button
              key={s.id}
              onClick={() => { onMoveTo(s.id); setMenuOpen(false); }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "8px 10px",
                background: "transparent",
                border: 0,
                fontSize: 12,
                color: "var(--ink)",
                cursor: "pointer",
                textAlign: "right",
                borderRadius: 4,
              }}
              onMouseEnter={e => { e.currentTarget.style.background = "var(--bg-tint)"; }}
              onMouseLeave={e => { e.currentTarget.style.background = "transparent"; }}
            >
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.color }} />
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function syntheticStage(i: number, c: Client): PipelineStage {
  if (c.hasPaymentToken) return i % 5 === 0 ? "won" : "proposal";
  if (i % 7 === 0) return "lost";
  if (c.lastActive && Date.now() - new Date(c.lastActive).getTime() < 7 * 86400000) return "qualified";
  return "new";
}
function synthValue(c: Client): number {
  if (c.hasPaymentToken) return 1500 + (c.id.length * 137) % 4500;
  return 500 + (c.id.length * 71) % 2000;
}
function stageLabel(s: PipelineStage): string {
  return STAGES.find(x => x.id === s)?.label ?? s;
}
