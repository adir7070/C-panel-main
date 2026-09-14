'use strict';

/**
 * loop — the agent's manual Claude tool-use loop. We run the loop ourselves
 * (not the SDK auto-runner) so EVERY write passes through the policy chokepoint,
 * every step is audited, and we cap iterations.
 *
 * Per turn: call Claude with the tool catalog → on `tool_use`, run reads
 * directly and route writes through policy (auto-run / queue-approval / block),
 * push tool_results, repeat → on `end_turn`, return the final Hebrew reply.
 *
 * SAFETY: phone + creds come from the session-resolved runContext, NEVER from
 * model arguments. The model only supplies campaign/ad ids + values.
 */

const { getClient, MODELS } = require("./anthropic-client");
const registry = require("./registry");
const policy = require("./policy.engine");
const approvals = require("./approvals.service");
const agentLog = require("./agent-log.service");
const { assembleContext } = require("./context");
const { buildBrainPrompt, buildContextPrompt } = require("./system-prompt");
const brainSvc = require("./brain.service");
const billing = require("./billing.service");
const lessonsSvc = require("./lessons.service");
const styleRag = require("./style-rag.service");
const { classifyDepth } = require("./context-depth");
const actionQuality = require("./action-quality");

const MAX_ITERS = parseInt(process.env.AGENT_MAX_ITERS, 10) || 8;

/* Sonnet 5 runs ADAPTIVE thinking (the model decides when/how deeply to reason
   before answering and between tool calls). We match the reasoning budget to the
   turn's depth via output_config.effort, and give max_tokens headroom because it
   now covers thinking + text (and the Sonnet 5 tokenizer is ~30% denser). */
const EFFORT_BY_DEPTH = { light: "low", medium: "medium", deep: "high" };
const MAXTOK_BY_DEPTH = { light: 2000, medium: 4000, deep: 8000 };

function newRunId() {
  return "run_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* Cheap follow-up chips: 2-3 short next messages the CLIENT might tap. Best-effort
   (never breaks the run), on a cheap model, based on the agent's last reply. */
async function generateSuggestions(client, assistantText, userMessage) {
  if (!assistantText) return [];
  try {
    const resp = await client.messages.create({
      model: MODELS.triage,
      max_tokens: 200,
      system: `הצע 3 תגובות קצרות שבעל העסק (הלקוח) עשוי לרצות לשלוח בהמשך למנהל הפרסום שלו, על סמך ההודעה האחרונה של המנהל. כל הצעה: עד 5 מילים, עברית תקנית וברורה, בגוף ראשון של הלקוח, מעשית (אישור/בקשת פעולה/שאלה טבעית). חובה עברית נכונה ומובנת — אסור מילים משובשות, שגיאות כתיב, או ביטויים לא-הגיוניים (למשל "כמה זמן עד השיקום?" במקום "כמה זמן עד ההשקה?"). כל הצעה חייבת להיקרא טבעי כמו משפט שאדם אמיתי היה שולח. החזר JSON בלבד ותו לא: {"suggestions":["...","...","..."]}.`,
      messages: [{ role: "user", content: `הודעת הלקוח האחרונה: "${(userMessage || "").slice(0, 300)}"\n\nההודעה האחרונה של מנהל ה-AI:\n"${assistantText.slice(0, 900)}"` }],
    });
    const txt = resp.content.filter(c => c.type === "text").map(c => c.text).join("");
    const m = txt.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(m ? m[0] : txt);
    return Array.isArray(parsed.suggestions)
      ? parsed.suggestions.filter(s => typeof s === "string" && s.trim()).slice(0, 3)
      : [];
  } catch (_) { return []; }
}

/**
 * runAgent({ phone, userMessage, history, mode, trigger, model })
 *   mode    ∈ "chat" | "proactive" | "readonly"
 *   trigger ∈ "client_message" | "proactive_cron" | "manager_invoked"
 * → { runId, text, actions, usage }
 */
async function runAgent({ phone, userMessage, history = [], mode = "chat", trigger = "client_message", model, noWrites = false, image = null, imageUrl = null } = {}) {
  if (!phone) throw new Error("runAgent: phone is required");
  const runId = newRunId();

  // ── kill switch up front (don't even spend tokens if disabled for writes) ──
  const enabled = await policy.isAgentEnabled();

  // Deterministic context budgeting: a "תודה" doesn't need two live FB calls +
  // style retrieval; a data/action intent gets everything (context-depth.js).
  const depth = classifyDepth({ userMessage, history, mode, hasImage: !!(image?.base64 || imageUrl) });

  const [ctx, learnedBrain, lessonsText, styleBlock] = await Promise.all([
    assembleContext(phone, { depth }),
    brainSvc.getActiveBrainText().catch(() => null),
    lessonsSvc.getStableLessonsText().catch(() => null),
    depth === "light" ? Promise.resolve(null) : styleRag.getStyleBlock(userMessage).catch(() => null),
  ]);
  // pendingImageUrl = an image the client just uploaded, for the image-filing tools
  const rc = { phone, creds: ctx.creds, view: ctx.view, campaigns: ctx.campaigns, media: [], pendingImageUrl: imageUrl };

  // Internal benchmarks: persist today's per-client performance row from the
  // context we already fetched (daily-deduped upsert; zero extra FB calls).
  try { require("./benchmarks.service").recordSnapshot(ctx.view).catch(() => {}); } catch (_) {}

  const system = [
    // stable block (brain + learned playbook + live lessons) → prompt-cached;
    // lessons change ~daily so the cache stays hot between changes
    { type: "text", text: buildBrainPrompt({ mode, learnedBrain, lessonsText }), cache_control: { type: "ephemeral" } },
    { type: "text", text: buildContextPrompt(ctx.view) },
  ];
  if (styleBlock) system.push({ type: "text", text: styleBlock });
  const tools = registry.toolDefs({ includeWrites: !noWrites && mode !== "readonly" && enabled });

  const messages = [...history];
  if (userMessage) {
    // attach the uploaded image as a vision block so Claude can see + analyze it
    const content = image?.base64
      ? [{ type: "text", text: String(userMessage) },
         { type: "image", source: { type: "base64", media_type: image.mediaType || "image/jpeg", data: image.base64 } }]
      : String(userMessage);
    messages.push({ role: "user", content });
  }

  const client = getClient();
  const usedModel = model || MODELS.loop;
  const actions = [];
  let finalText = "";
  let lastUsage = null;

  // NB: pushing resp.content back verbatim (below) preserves the thinking blocks
  // across tool_result turns — required for adaptive thinking with tool use.
  const effort = EFFORT_BY_DEPTH[depth] || "high";
  const maxTokens = MAXTOK_BY_DEPTH[depth] || 4000;

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let resp;
    try {
      resp = await client.messages.create({
        model: usedModel, max_tokens: maxTokens,
        thinking: { type: "adaptive" }, output_config: { effort },
        system, tools, messages,
      });
    } catch (e) {
      await agentLog.record({ agentRunId: runId, clientPhone: phone, trigger, step: iter, type: "reasoning", status: "failed", result: { error: e.message }, model: usedModel });
      throw e;
    }
    lastUsage = resp.usage;
    const textParts = resp.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    if (textParts) finalText = textParts;
    await agentLog.record({ agentRunId: runId, clientPhone: phone, trigger, step: iter, type: "reasoning", status: "executed", model: usedModel, tokens: resp.usage,
      result: { stopReason: resp.stop_reason, blockTypes: resp.content.map(c => c.type), textLen: textParts.length } });

    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason !== "tool_use") break;

    const toolResults = [];
    for (const tu of resp.content.filter(c => c.type === "tool_use")) {
      const payload = await runTool(tu, { runId, phone, trigger, iter, rc, ctx, actions });
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(payload) });
    }
    messages.push({ role: "user", content: toolResults });
  }

  // The loop can end without a textual reply — it spent its last turn on a tool
  // call, hit the iteration cap mid-tool-use, or finished on a tool-only turn.
  // Force ONE no-tools pass so the client ALWAYS gets a real answer (never the
  // empty fallback) summarizing what was found / done.
  if (!finalText) {
    if (messages[messages.length - 1]?.role === "assistant") {
      messages.push({ role: "user", content: "סכם בבקשה בקצרה ללקוח: מה מצאת, ומה ההמלצה או הפעולה שביצעת/מציע." });
    }
    try {
      const fin = await client.messages.create({
        model: usedModel, max_tokens: 2000,
        thinking: { type: "adaptive" }, output_config: { effort: "low" },
        system, messages,
      });
      const t = fin.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
      if (t) finalText = t;
      lastUsage = fin.usage;
      await agentLog.record({ agentRunId: runId, clientPhone: phone, trigger, step: MAX_ITERS, type: "reasoning", status: "executed", model: usedModel, tokens: fin.usage, result: { forcedFinal: true, textLen: t.length } });
    } catch (e) {
      await agentLog.record({ agentRunId: runId, clientPhone: phone, trigger, type: "reasoning", status: "failed", result: { forcedFinal: true, error: e.message } });
    }
  }

  const suggestions = await generateSuggestions(client, finalText, userMessage);
  return { runId, text: finalText, actions, media: rc.media.slice(0, 12), suggestions, usage: lastUsage };
}

/* Execute one tool_use block → returns the JSON payload to feed back as tool_result. */
async function runTool(tu, { runId, phone, trigger, iter, rc, ctx, actions }) {
  const tool = registry.getTool(tu.name);
  const args = tu.input || {};
  if (!tool || !tool.run) {
    await agentLog.record({ agentRunId: runId, clientPhone: phone, trigger, step: iter, type: "tool_call", tool: tu.name, args, status: "failed", result: { error: "unknown tool" } });
    return { error: `unknown tool ${tu.name}` };
  }

  // ── READ tools: run directly ──
  if (!tool.write) {
    try {
      const out = await tool.run(args, rc);
      // Collect ad images so the app can render them visually (not just text).
      const pushImg = (url, caption) => { if (url && !rc.media.some(m => m.url === url)) rc.media.push({ url, caption: caption || "" }); };
      if (tu.name === "get_campaign_ads" && Array.isArray(out.ads)) {
        for (const ad of out.ads) pushImg(ad.creative?.imageUrl, ad.creative?.title || ad.name);
      }
      if (tu.name === "analyze_campaign") {
        if (out.winner) pushImg(out.winner.imageUrl, `🏆 ${out.winner.headline || out.winner.name || "המנצחת"}`);
        for (const l of out.laggards || []) pushImg(l.imageUrl, l.headline || l.name);
      }
      await agentLog.record({ agentRunId: runId, clientPhone: phone, trigger, step: iter, type: "tool_call", tool: tu.name, args, status: "executed", policyDecision: "auto", result: out });
      return out;
    } catch (e) {
      const error = e.response?.data?.error?.message || e.message;
      await agentLog.record({ agentRunId: runId, clientPhone: phone, trigger, step: iter, type: "tool_call", tool: tu.name, args, status: "failed", result: { error } });
      return { error };
    }
  }

  // ── WRITE tools: deterministic quality gate FIRST (vague/placeholder args
  // never reach FB or billing — the model is told what to clarify instead) ──
  const quality = actionQuality.check(tu.name, args, rc);
  if (!quality.ok) {
    actions.push({ tool: tu.name, status: "needs_clarification", summary: tool.summarize ? tool.summarize(args) : tu.name });
    await agentLog.record({ agentRunId: runId, clientPhone: phone, trigger, step: iter, type: "tool_call", tool: tu.name, args, status: "blocked", policyDecision: "quality_gate", result: { ask: quality.ask } });
    return { status: "needs_clarification", note: `הפעולה לא בוצעה — הפרטים עמומים/חסרים: ${quality.ask} אל תריץ שוב עם אותם ערכים; קודם השג את המידע.` };
  }

  // ── policy chokepoint ──
  const decision = await policy.classify(tu.name, args, { phone, campaigns: ctx.campaigns, monthSpend: ctx.monthSpend });
  const summary = tool.summarize ? tool.summarize(args) : tu.name;
  const { cost } = await billing.priceFor(tu.name, args).catch(() => ({ cost: 0 }));
  const base = { agentRunId: runId, clientPhone: phone, trigger, step: iter, type: "tool_call", tool: tu.name, args, policyDecision: decision.decision, policyReasons: decision.reasons };

  if (decision.decision === "auto") {
    try {
      // billed execution: precheck balance → deduct → run → refund on failure
      const out = await billing.runBilled({ phone, toolName: tu.name, args, run: () => tool.run(args, rc) });
      if (out.status === "insufficient_coins") {
        // Coins are hidden — this is a monthly-quota block, surfaced to the
        // client as "upgrade your subscription", never as tokens.
        actions.push({ tool: tu.name, status: "insufficient_coins", summary, cost: out.cost, shortfall: out.shortfall });
        await agentLog.record({ ...base, status: "blocked", result: out });
        return { status: "insufficient_coins",
          note: `הפעולה נחסמה — מכסת היצירה החודשית של המנוי נוצלה. אל תזכיר טוקנים/מטבעות/עלות ואל תציע לטעון. אמור ללקוח בנועם שכדי להמשיך ליצור תוכן חדש צריך לשדרג את המנוי ("כדי להמשיך ליצור תוכן חדש צריך לשדרג את המנוי שלך 🙂"), והצע להעביר למנהל אם צריך.` };
      }
      // Strip coin fields from the model-facing result — the agent must never
      // see or relay a balance/charge (kept only in internal logs above).
      const { coinBalance, coinsCharged, ...safeOut } = out;
      actions.push({ tool: tu.name, status: "executed", summary, result: out, coinsCharged });
      await agentLog.record({ ...base, status: "executed", result: out });
      return { status: "executed", summary, ...safeOut };
    } catch (e) {
      const error = e.response?.data?.error?.message || e.message;
      await agentLog.record({ ...base, status: "failed", result: { error } });
      return { status: "failed", error };
    }
  }

  if (decision.decision === "approval") {
    const { approvalId, expiresAt } = await approvals.create({ agentRunId: runId, phone, tool: tu.name, args, summary, policyReasons: decision.reasons, cost });
    actions.push({ tool: tu.name, status: "awaiting_approval", approvalId, summary, reason: args.reason || null, reasons: decision.reasons, cost });
    await agentLog.record({ ...base, status: "awaiting_approval", approvalId });
    return { status: "awaiting_approval", approvalId, summary, reasons: decision.reasons,
      note: `הפעולה לא בוצעה — ממתינה לאישור הלקוח. הצג ללקוח את ההצעה והנימוק (בלי להזכיר טוקנים/מטבעות/עלות) ובקש שיאשר.` };
  }

  // block
  actions.push({ tool: tu.name, status: "blocked", summary, reasons: decision.reasons });
  await agentLog.record({ ...base, status: "blocked" });
  return { status: "blocked", reasons: decision.reasons,
    note: "הפעולה נחסמה ע\"י כללי הבטיחות. הסבר ללקוח שאינך יכול לבצע אותה אוטומטית ומדוע." };
}

module.exports = { runAgent };
