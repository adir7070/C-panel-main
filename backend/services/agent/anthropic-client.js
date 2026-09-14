'use strict';

/**
 * Agent LLM client — now GEMINI-backed.
 *
 * Historically this returned an Anthropic (Claude) client. The whole agent
 * stack (loop.js + 6 helper services) calls `getClient().messages.create(...)`
 * with the Anthropic Messages shape (system / messages / tools with
 * input_schema / tool_use + tool_result content blocks) and reads back
 * `resp.content[]`, `resp.stop_reason`, `resp.usage`.
 *
 * To move the agent to Gemini WITHOUT rewriting all 7 files, `getClient()` now
 * returns a thin ADAPTER that implements the same `.messages.create()` surface
 * on top of @google/genai `generateContent`. It translates:
 *   request:  system→systemInstruction, messages(text/image/tool_use/tool_result)
 *             →contents(text/inlineData/functionCall/functionResponse),
 *             tools(input_schema)→functionDeclarations(parameters)
 *   response: Gemini candidate parts → Anthropic-shaped content blocks
 *             ({type:"text"} / {type:"tool_use",id,name,input}), stop_reason,
 *             usage {input_tokens,output_tokens}.
 *
 * Lazy client — never construct at module load (a missing key must not crash
 * the whole server at startup).
 */

const { GoogleGenAI } = require("@google/genai");

let _genai = null;
function genai() {
  if (_genai) return _genai;
  const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_AI_API_KEY is not configured");
  _genai = new GoogleGenAI({ apiKey });
  return _genai;
}

/**
 * Model tiers (overridable via env). Claude tiers → Gemini tiers:
 *   loop     — the agentic tool-use loop
 *   strategy — hard strategic reasoning
 *   triage   — cheap inbound classification / suggestions
 */
const MODELS = {
  loop:     process.env.AGENT_MODEL        || "gemini-3.6-flash",
  strategy: process.env.AGENT_MODEL_HEAVY  || "gemini-3.6-flash",
  triage:   process.env.AGENT_MODEL_TRIAGE || "gemini-3.6-flash",
};

/* Thinking-token reserve. Gemini's internal "thinking" is billed against
   maxOutputTokens; left unbounded on flash models it can eat the WHOLE budget →
   empty/truncated replies (bad with a big tool catalog). We (a) cap it to this
   reserve and (b) add the reserve ON TOP of the caller's requested tokens so the
   answer always has room. A bounded POSITIVE budget works across gemini-2.5 /
   3.5 / 3.6-flash — unlike thinkingBudget:0, which the 3.6 generation rejects. */
const THINK_RESERVE = parseInt(process.env.AGENT_THINK_RESERVE, 10) || 1024;

/* ── schema sanitizing ─────────────────────────────────────────────────────
   Anthropic tool input_schema is full JSON Schema. Gemini functionDeclaration
   `parameters` accepts only an OpenAPI-subset Schema — unknown keywords make it
   400. Keep the supported keys, drop the rest, recurse into properties/items. */
const SCHEMA_KEEP = new Set([
  "type", "description", "enum", "items", "properties", "required",
  "nullable", "format", "minItems", "maxItems", "anyOf",
]);
function sanitizeSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!SCHEMA_KEEP.has(k)) continue;
    if (k === "properties" && v && typeof v === "object") {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = sanitizeSchema(pv);
    } else if (k === "items") {
      out.items = sanitizeSchema(v);
    } else if (k === "anyOf") {
      out.anyOf = Array.isArray(v) ? v.map(sanitizeSchema) : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function toSystemInstruction(system) {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map(s => (typeof s === "string" ? s : s?.text || "")).filter(Boolean).join("\n\n");
  return undefined;
}

function toGeminiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return [{ functionDeclarations: tools.map(t => {
    const decl = { name: t.name, description: t.description || "" };
    const params = sanitizeSchema(t.input_schema);
    if (params && params.type) decl.parameters = params;
    return decl;
  }) }];
}

/* Resolve a tool_result's tool_use_id back to the tool NAME by scanning the
   assistant tool_use blocks earlier in the same conversation (Gemini's
   functionResponse keys on name, Anthropic keys on id). */
function nameForToolUseId(messages, id) {
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b?.type === "tool_use" && b.id === id) return b.name;
  }
  return null;
}

function toContents(messages) {
  const contents = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts = [];
    const c = m.content;
    if (typeof c === "string") {
      if (c) parts.push({ text: c });
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (!b) continue;
        if (b.type === "text") {
          if (b.text) { const part = { text: b.text }; if (b._sig) part.thoughtSignature = b._sig; parts.push(part); }
        } else if (b.type === "image" && b.source?.type === "base64") {
          parts.push({ inlineData: { mimeType: b.source.media_type || "image/jpeg", data: b.source.data } });
        } else if (b.type === "tool_use") {
          const part = { functionCall: { name: b.name, args: b.input || {} } };
          if (b._sig) part.thoughtSignature = b._sig; // preserve Gemini-3 thought signature
          parts.push(part);
        } else if (b.type === "tool_result") {
          const name = nameForToolUseId(messages, b.tool_use_id) || "tool";
          const raw = b.content;
          const text = typeof raw === "string" ? raw
            : Array.isArray(raw) ? raw.map(x => (typeof x === "string" ? x : x?.text || "")).join("")
            : JSON.stringify(raw);
          let response;
          try { response = JSON.parse(text); } catch { response = { result: text }; }
          if (response === null || typeof response !== "object" || Array.isArray(response)) response = { result: response };
          parts.push({ functionResponse: { name, response } });
        }
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  /* Gemini is STRICTER than Anthropic about conversation shape and THROWS
     (→ whole run fails with a generic error) when it's violated:
       (a) it needs the first turn to be role "user";
       (b) it dislikes consecutive same-role turns.
     Anthropic-style history routinely breaks both — e.g. a thread that OPENS
     with an agent/proactive message starts with a "model" turn, and merged
     support/agent history can have back-to-back same-role turns. Normalize:
     merge consecutive same-role turns, then drop any leading non-user turns. */
  const merged = [];
  for (const c of contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === c.role) last.parts.push(...c.parts);
    else merged.push({ role: c.role, parts: [...c.parts] });
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  return merged;
}

let _tuCounter = 0;
function newToolUseId() { return "toolu_" + Date.now().toString(36) + (_tuCounter++).toString(36) + Math.random().toString(36).slice(2, 6); }

function fromGeminiResponse(resp) {
  const cand = resp?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const content = [];
  for (const p of parts) {
    // Gemini-3 thinking models attach an opaque thoughtSignature to parts; it
    // MUST be echoed back on the same part next turn or tool-use 400s ("missing
    // thought_signature"). We carry it on the block as `_sig` and re-attach it
    // in toContents.
    if (typeof p?.text === "string" && p.text) {
      const b = { type: "text", text: p.text };
      if (p.thoughtSignature) b._sig = p.thoughtSignature;
      content.push(b);
    } else if (p?.functionCall) {
      const b = { type: "tool_use", id: newToolUseId(), name: p.functionCall.name, input: p.functionCall.args || {} };
      if (p.thoughtSignature) b._sig = p.thoughtSignature;
      content.push(b);
    }
  }
  const hasTool = content.some(b => b.type === "tool_use");
  const um = resp?.usageMetadata || {};
  return {
    content,
    stop_reason: hasTool ? "tool_use" : "end_turn",
    usage: { input_tokens: um.promptTokenCount || 0, output_tokens: um.candidatesTokenCount || 0 },
  };
}

/* The Anthropic-compatible adapter. */
const adapter = {
  messages: {
    async create(params = {}) {
      const model = params.model || MODELS.loop;
      const wantTokens = params.max_tokens || 2000;
      const config = {};
      const sys = toSystemInstruction(params.system);
      if (sys) config.systemInstruction = sys;
      const geminiTools = toGeminiTools(params.tools);
      if (geminiTools) config.tools = geminiTools;
      /* Bound thinking + reserve output headroom (see THINK_RESERVE). The
         Anthropic-only knobs (thinking / output_config) are ignored. */
      config.thinkingConfig = { thinkingBudget: THINK_RESERVE };
      config.maxOutputTokens = wantTokens + THINK_RESERVE;

      const resp = await genai().models.generateContent({
        model,
        contents: toContents(params.messages || []),
        config,
      });
      return fromGeminiResponse(resp);
    },
  },
};

function getClient() { genai(); return adapter; } // genai() surfaces a missing-key error eagerly, like before

module.exports = { getClient, MODELS, _internal: { sanitizeSchema, toContents, toGeminiTools, fromGeminiResponse } };
