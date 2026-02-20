import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env: try cwd then same dir as server (bulletproof for Windows/Cursor)
dotenv.config({ path: path.join(process.cwd(), ".env") });
dotenv.config({ path: path.join(__dirname, ".env") });

import express from "express";
import { generateSegmentText, getAIObjectionCandidate } from "./debate-generation.js";
import { DEBATE_CONFIG } from "./debate-config.js";
import {
  buildJudgeRulingUserPrompt,
  buildCorrectionLineUserPrompt,
  JUDGE_RULING_SYSTEM,
  CORRECTION_LINE_SYSTEM,
  OBJECTION_LINE_PROMPT,
  OBJECTION_LINE_STYLE_HINTS
} from "./prompts.js";
import { generateConclusion } from "./conclusion.js";

// Support both env names; canonicalize key (strip BOM, quotes, spaces, CR/LF)
function normalizeApiKey(raw) {
  if (raw == null || typeof raw !== "string") return "";
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/\r?\n/g, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim()
    .replace(/\s/g, "");
}
const RAW = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY || "";
const OPENROUTER_API_KEY = normalizeApiKey(RAW);
/** Single model for all OpenRouter calls (stream, generateScript, conclusion). Must be set in .env. */
const OPENROUTER_MODEL = (process.env.OPENROUTER_MODEL || "").trim();
if (!OPENROUTER_MODEL) {
  throw new Error("OPENROUTER_MODEL is required. Set it in .env (e.g. OPENROUTER_MODEL=anthropic/claude-opus-4).");
}
/** Fallback models if primary returns 5xx/429. */
const OPENROUTER_MODEL_FALLBACKS = [
  "anthropic/claude-sonnet-4",
  "anthropic/claude-opus-4",
  "openai/gpt-4o"
].filter((m) => m && m !== OPENROUTER_MODEL);

/** Three-tier routing: cheap (repair/short) / mid (main) / expensive (conclusion/strict). */
const OPENROUTER_MODEL_CHEAP = (process.env.OPENROUTER_MODEL_CHEAP || "openai/gpt-4o-mini").trim();
const OPENROUTER_MODEL_MID = (process.env.OPENROUTER_MODEL_MID || "anthropic/claude-sonnet-4").trim();
const OPENROUTER_MODEL_EXPENSIVE = (process.env.OPENROUTER_MODEL_EXPENSIVE || "anthropic/claude-opus-4").trim();

/** Conclusion: aim ~3s. Default gpt-4o (best quality among models that often respond in ~3s); override with OPENROUTER_MODEL_CONCLUSION. */
const OPENROUTER_MODEL_CONCLUSION = (process.env.OPENROUTER_MODEL_CONCLUSION || "").trim() || "openai/gpt-4o";

console.log("[MODEL]", OPENROUTER_MODEL, OPENROUTER_MODEL_CONCLUSION !== OPENROUTER_MODEL ? "(conclusion: " + OPENROUTER_MODEL_CONCLUSION + ")" : "", "(tier: cheap=" + OPENROUTER_MODEL_CHEAP + " mid=" + OPENROUTER_MODEL_MID + " expensive=" + OPENROUTER_MODEL_EXPENSIVE + ")");
if (!OPENROUTER_API_KEY) {
  console.warn("[ENV] OPENROUTER_API_KEY not set. Set it in .env (see .env.example).");
}

const app = express();
const PORT = process.env.PORT || 3000;

/** @type {Map<string, { segmentId: string, resolve: (text: string) => void }>} */
const pendingUserSpeeches = new Map();
const USER_SPEECH_TIMEOUT_MS = 120000;

/** Per-stream session for AI objection state (debater vs debater). */
const streamSessions = new Map();
const SPEAKER_DISPLAY_NAMES = {
  chair: "Makima (Chair)",
  pro1: "Donald Trump (Pro 1)",
  pro2: "Light Yagami (Pro 2)",
  pro3: "Immanuel Kant (Pro 3)",
  con1: "Gus Fring (Con 1)",
  con2: "Albert Camus (Con 2)",
  con3: "Isaac Newton (Con 3)"
};
const AI_OBJECTION_TOKENS_PER_SIDE = 2;

function randomStreamId() {
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

app.use(express.json());

/** Log only /api requests (method + url). */
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) console.log("[API]", req.method, req.url);
  next();
});

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Call OpenRouter chat/completions with fallback: try OPENROUTER_MODEL first, then each fallback on 5xx/429.
 * @param {object} body - { model?, messages, max_tokens, ... }
 * @param {{ requestTimeoutMs?: number }} options - optional; requestTimeoutMs limits each single request (Node 18+ AbortSignal.timeout).
 * @returns {{ ok: boolean, data?: object, modelUsed?: string, status?: number, raw?: string }}
 */
async function fetchOpenRouterWithFallback(body, options = {}) {
  const { requestTimeoutMs, primaryModel } = options;
  const first = primaryModel || OPENROUTER_MODEL;
  const modelsToTry = [
    first,
    ...OPENROUTER_MODEL_FALLBACKS.filter((m) => m && m !== first)
  ];
  let lastStatus = 0;
  let lastRaw = "";
  for (const model of modelsToTry) {
    const b = { ...body, model };
    const fetchOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "debate-sim"
      },
      body: JSON.stringify(b)
    };
    let timeoutId = null;
    if (typeof requestTimeoutMs === "number" && requestTimeoutMs > 0) {
      const ac = new AbortController();
      timeoutId = setTimeout(() => ac.abort(), requestTimeoutMs);
      fetchOptions.signal = ac.signal;
    }
    let response;
    try {
      response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, fetchOptions);
    } finally {
      if (timeoutId != null) clearTimeout(timeoutId);
    }
    lastStatus = response.status;
    lastRaw = await response.text();
    if (response.ok) {
      const data = JSON.parse(lastRaw);
      return { ok: true, data, modelUsed: model };
    }
    if (response.status < 500 && response.status !== 429) break;
    console.warn("[OpenRouter] model", model, "failed", response.status, "trying fallback");
  }
  return { ok: false, status: lastStatus, raw: lastRaw };
}

/** GET /api/ping — health check; frontend can verify backend is reachable. */
app.get("/api/ping", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.json({ ok: true, serverTime: Date.now() });
});

/** POST /api/start — frontend expects this; avoid 404. */
app.post("/api/start", (req, res) => {
  res.json({ ok: true });
});

/** GET /api/diag/openrouter — prove server sees the key (no full key). Local dev only. */
app.get("/api/diag/openrouter", (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ error: "Not available in production" });
  }
  res.json({
    ok: true,
    keyExists: !!OPENROUTER_API_KEY,
    keyLen: OPENROUTER_API_KEY.length,
    keyPrefix: OPENROUTER_API_KEY.slice(0, 8),
    model: OPENROUTER_MODEL,
    chosenModel: OPENROUTER_MODEL,
    modelFallbacks: OPENROUTER_MODEL_FALLBACKS,
    baseUrl: OPENROUTER_BASE_URL
  });
});

/** POST /api/diag/openrouter-test — tiny OpenRouter call to confirm no 401. */
app.post("/api/diag/openrouter-test", async (req, res) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ error: "Not available in production" });
  }
  try {
    const result = await fetchOpenRouterWithFallback({
      max_tokens: 16,
      messages: [{ role: "user", content: "ping" }]
    });
    if (result.ok) {
      return res.json({ ok: true, status: 200, modelUsed: result.modelUsed });
    }
    res.status(200).json({
      ok: false,
      status: result.status ?? 0,
      rawErrorSnippet: (result.raw || "").slice(0, 300)
    });
  } catch (err) {
    res.status(200).json({
      ok: false,
      status: 0,
      rawErrorSnippet: (err.message || String(err)).slice(0, 300)
    });
  }
});

const bannedPatterns = [
  /as an\s+ai[^.!?]*[.!?]?/gi,
  /as a language model[^.!?]*[.!?]?/gi,
  /i am just an ai[^.!?]*[.!?]?/gi,
  /this is a simulation[^.!?]*[.!?]?/gi,
  /simulated (dialogue|conversation)[^.!?]*[.!?]?/gi,
  /as an artificial intelligence[^.!?]*[.!?]?/gi,
  /i (cannot|can't) (do|provide)[^.!?]*[.!?]?/gi
];

function sanitizeText(text) {
  if (!text) return "";
  let result = text;
  for (const pattern of bannedPatterns) {
    result = result.replace(pattern, "");
  }
  return result;
}

/** Call OpenRouter for judge ruling. Returns { ruling, reason, penalty }. */
async function callJudgeRuling(topic, objectionType, excerpt, roleSubType, speakerSide, raisedBySide) {
  const userPrompt = buildJudgeRulingUserPrompt(topic, objectionType, excerpt, roleSubType, speakerSide, raisedBySide);
  const result = await fetchOpenRouterWithFallback({
    max_tokens: 120,
    messages: [
      { role: "system", content: JUDGE_RULING_SYSTEM },
      { role: "user", content: userPrompt }
    ]
  });
  if (!result.ok) {
    console.warn("[objection] Judge ruling API error", result.status);
    return { ruling: "OVERRULED", reason: "Ruling unavailable.", penalty: { sentenceCut: 0, forceCorrection: false } };
  }
  const data = result.data;
  const content = (data.choices?.[0]?.message?.content || "").trim().replace(/^```\w*\n?|\n?```$/g, "");
  try {
    const parsed = JSON.parse(content);
    const ruling = parsed.ruling === "SUSTAINED" ? "SUSTAINED" : "OVERRULED";
    const reason = typeof parsed.reason === "string" ? parsed.reason : "No reason given.";
    let penalty = parsed.penalty;
    if (ruling === "OVERRULED" || penalty == null) {
      penalty = { sentenceCut: 0, forceCorrection: false };
    } else {
      penalty = {
        sentenceCut: typeof penalty.sentenceCut === "number" ? Math.min(1, Math.max(0, penalty.sentenceCut)) : 1,
        forceCorrection: !!penalty.forceCorrection
      };
    }
    return { ruling, reason, penalty };
  } catch {
    return { ruling: "OVERRULED", reason: "Invalid ruling format.", penalty: { sentenceCut: 0, forceCorrection: false } };
  }
}

/** Call OpenRouter for one in-character correction line after SUSTAINED. */
async function callCorrectionLine(topic, segment, objectionType, excerpt) {
  const speakerLabel = SPEAKER_DISPLAY_NAMES[segment.speakerId] || segment.label || segment.speakerId;
  const side = segment.speakerId && segment.speakerId.startsWith("pro") ? "PRO" : "CON";
  const userPrompt = buildCorrectionLineUserPrompt(topic, speakerLabel, side, objectionType, excerpt);
  const result = await fetchOpenRouterWithFallback({
    max_tokens: 48,
    messages: [
      { role: "system", content: CORRECTION_LINE_SYSTEM },
      { role: "user", content: userPrompt }
    ]
  });
  if (!result.ok) return null;
  const data = result.data;
  const line = (data.choices?.[0]?.message?.content || "").trim().slice(0, 100);
  return line || null;
}

/** Call OpenRouter for one in-character objection line. */
async function callAIObjectionLine(speakerId, objectionType) {
  const styleHint = OBJECTION_LINE_STYLE_HINTS[speakerId] || "One short objection line, in character.";
  const result = await fetchOpenRouterWithFallback({
    max_tokens: 48,
    messages: [
      { role: "system", content: OBJECTION_LINE_PROMPT + "\n\n" + styleHint },
      { role: "user", content: `Objection type: ${objectionType}. Output ONLY the objection line.` }
    ]
  });
  if (!result.ok) return "Objection.";
  const data = result.data;
  const line = (data.choices?.[0]?.message?.content || "Objection.").trim().slice(0, 100);
  return line || "Objection.";
}

const BASE_SEGMENTS = [
  { id: "chair_opening", speakerId: "chair", label: "Chair", roleType: "chair", roleSubType: "openingChair" },
  { id: "pro1_statement", speakerId: "pro1", label: "Pro 1", roleType: "debater", roleSubType: "pro_statement" },
  { id: "chair_to_con1", speakerId: "chair", label: "Chair", roleType: "chair", roleSubType: "transition" },
  { id: "con1_statement", speakerId: "con1", label: "Con 1", roleType: "debater", roleSubType: "con_statement" },
  { id: "chair_to_pro2", speakerId: "chair", label: "Chair", roleType: "chair", roleSubType: "transition" },
  { id: "pro2_rebuttal", speakerId: "pro2", label: "Pro 2", roleType: "debater", roleSubType: "pro_rebuttal" },
  { id: "chair_to_con2", speakerId: "chair", label: "Chair", roleType: "chair", roleSubType: "transition" },
  { id: "con2_rebuttal", speakerId: "con2", label: "Con 2", roleType: "debater", roleSubType: "con_rebuttal" },
  { id: "chair_to_pro3", speakerId: "chair", label: "Chair", roleType: "chair", roleSubType: "transition" },
  { id: "pro3_summary", speakerId: "pro3", label: "Pro 3", roleType: "debater", roleSubType: "pro_summary" },
  { id: "chair_to_con3", speakerId: "chair", label: "Chair", roleType: "chair", roleSubType: "transition" },
  { id: "con3_summary", speakerId: "con3", label: "Con 3", roleType: "debater", roleSubType: "con_summary" },
  { id: "chair_closing", speakerId: "chair", label: "Chair", roleType: "chair", roleSubType: "closingChair" }
];

const INTERJECTION_SLOTS = [
  { afterSegmentId: "pro1_statement", interjectors: [{ speakerId: "con2", label: "Con 2" }, { speakerId: "con3", label: "Con 3" }] },
  { afterSegmentId: "con1_statement", interjectors: [{ speakerId: "pro2", label: "Pro 2" }, { speakerId: "pro3", label: "Pro 3" }] },
  { afterSegmentId: "pro2_rebuttal", interjectors: [{ speakerId: "con2", label: "Con 2" }, { speakerId: "con3", label: "Con 3" }] },
  { afterSegmentId: "con2_rebuttal", interjectors: [{ speakerId: "pro2", label: "Pro 2" }, { speakerId: "pro3", label: "Pro 3" }] }
];

/** 14-turn micro flow (base order; will be shuffled for drama). Chair open/close fixed; middle order varies. */
const MICRO_TURN_SEGMENTS = [
  { id: "chair_opening", speakerId: "chair", label: "Chair", roleType: "chair", roleSubType: "openingChair" },
  { id: "pro1_statement", speakerId: "pro1", label: "Pro 1", roleType: "debater", roleSubType: "pro_statement" },
  { id: "con3_statement", speakerId: "con3", label: "Con 3", roleType: "debater", roleSubType: "con_statement" },
  { id: "pro2_rebuttal", speakerId: "pro2", label: "Pro 2", roleType: "debater", roleSubType: "pro_rebuttal" },
  { id: "con1_statement", speakerId: "con1", label: "Con 1", roleType: "debater", roleSubType: "con_statement" },
  { id: "pro3_summary", speakerId: "pro3", label: "Pro 3", roleType: "debater", roleSubType: "pro_summary" },
  { id: "con2_rebuttal", speakerId: "con2", label: "Con 2", roleType: "debater", roleSubType: "con_rebuttal" },
  { id: "pro1_2", speakerId: "pro1", label: "Pro 1", roleType: "debater", roleSubType: "pro_rebuttal" },
  { id: "con3_2", speakerId: "con3", label: "Con 3", roleType: "debater", roleSubType: "con_rebuttal" },
  { id: "pro2_2", speakerId: "pro2", label: "Pro 2", roleType: "debater", roleSubType: "pro_rebuttal" },
  { id: "con1_2", speakerId: "con1", label: "Con 1", roleType: "debater", roleSubType: "con_rebuttal" },
  { id: "pro3_2", speakerId: "pro3", label: "Pro 3", roleType: "debater", roleSubType: "pro_summary" },
  { id: "con2_2", speakerId: "con2", label: "Con 2", roleType: "debater", roleSubType: "con_rebuttal" },
  { id: "chair_closing", speakerId: "chair", label: "Chair", roleType: "chair", roleSubType: "closingChair" }
];

/**
 * Shuffle middle segments so the same speaker never speaks twice in a row.
 * Keeps first segment (chair open) and last segment (chair close) fixed for structure.
 * Order of debaters in between is randomized for drama/variety—no fixed template.
 */
function shuffleMiddleSegments(segments) {
  if (segments.length <= 2) return segments;
  const first = segments[0];
  const last = segments[segments.length - 1];
  const middle = segments.slice(1, -1);
  const result = [];
  let remaining = middle.map((s, i) => ({ ...s, _idx: i }));
  let lastSpeakerId = first.speakerId;

  while (remaining.length > 0) {
    const candidates = remaining.filter((s) => s.speakerId !== lastSpeakerId);
    const pool = candidates.length > 0 ? candidates : remaining;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const pickIndex = remaining.findIndex((s) => s._idx === pick._idx);
    remaining.splice(pickIndex, 1);
    const { _idx, ...seg } = pick;
    result.push(seg);
    lastSpeakerId = pick.speakerId;
  }

  return [first, ...result, last];
}

function buildDebateSegments() {
  const flowMode = (DEBATE_CONFIG.flowMode || "classic").toLowerCase();
  let segments;
  if (flowMode === "micro") {
    segments = MICRO_TURN_SEGMENTS.map((s) => ({ ...s }));
  } else {
    segments = [];
    const slotDecisions = INTERJECTION_SLOTS.map(() => Math.random() < 0.3);
    let interjectionCount = slotDecisions.filter(Boolean).length;
    const minInterjections = 2;
    for (let i = 0; i < INTERJECTION_SLOTS.length && interjectionCount < minInterjections; i++) {
      if (!slotDecisions[i]) {
        slotDecisions[i] = true;
        interjectionCount++;
      }
    }
    for (const seg of BASE_SEGMENTS) {
      segments.push({ ...seg });
      const slotIndex = INTERJECTION_SLOTS.findIndex((s) => s.afterSegmentId === seg.id);
      if (slotIndex !== -1 && slotDecisions[slotIndex]) {
        const slot = INTERJECTION_SLOTS[slotIndex];
        const pick = slot.interjectors[Math.floor(Math.random() * slot.interjectors.length)];
        segments.push(
          { id: `interject_${seg.id}`, speakerId: pick.speakerId, label: pick.label, roleType: "debater", roleSubType: "interjection" },
          { id: `rebuke_${seg.id}`, speakerId: "chair", label: "Chair", roleType: "chair", roleSubType: "reprimand" }
        );
      }
    }
  }
  if (DEBATE_CONFIG.shuffleSegmentOrder) {
    return shuffleMiddleSegments(segments);
  }
  return segments;
}

/**
 * Generate segment text via debate-generation (single OpenRouter client).
 * Throws on API error (e.g. 401); server must not return thrown message as dialogue.
 */
async function generateSegmentTextServer(topic, segment, context = {}) {
  const opts = {
    apiKey: OPENROUTER_API_KEY,
    model: OPENROUTER_MODEL,
    modelFallbacks: OPENROUTER_MODEL_FALLBACKS,
    sanitizeOutput: DEBATE_CONFIG.sanitizeOutputForbidden,
    logPromptSpeakers: DEBATE_CONFIG.logPromptForSpeakers
  };
  if (DEBATE_CONFIG.useQualityLadder && OPENROUTER_MODEL_CHEAP && OPENROUTER_MODEL_MID && OPENROUTER_MODEL_EXPENSIVE) {
    opts.cheapModel = OPENROUTER_MODEL_CHEAP;
    opts.midModel = OPENROUTER_MODEL_MID;
    opts.expensiveModel = OPENROUTER_MODEL_EXPENSIVE;
  } else if (OPENROUTER_MODEL_CHEAP && OPENROUTER_MODEL_EXPENSIVE && OPENROUTER_MODEL_CHEAP !== OPENROUTER_MODEL_EXPENSIVE) {
    opts.cheapModel = OPENROUTER_MODEL_CHEAP;
    opts.expensiveModel = OPENROUTER_MODEL_EXPENSIVE;
  }
  const raw = await generateSegmentText(topic, segment, context, opts);
  return sanitizeText(raw);
}

const TTS_MODE = (process.env.TTS_MODE || "browser").toLowerCase();
const TTS_PROVIDER = (process.env.TTS_PROVIDER || "").trim();
const TTS_API_KEY = (process.env.TTS_API_KEY || "").trim();

/** Map speakerId → provider voice_id for character-matched TTS. Set in .env e.g. TTS_VOICE_PRO1=abc123 (ElevenLabs voice_id). */
const SPEAKER_VOICE_IDS = {
  chair: (process.env.TTS_VOICE_CHAIR || process.env.TTS_VOICE_DEFAULT || "").trim(),
  pro1: (process.env.TTS_VOICE_PRO1 || process.env.TTS_VOICE_DEFAULT || "").trim(),
  pro2: (process.env.TTS_VOICE_PRO2 || process.env.TTS_VOICE_DEFAULT || "").trim(),
  pro3: (process.env.TTS_VOICE_PRO3 || process.env.TTS_VOICE_DEFAULT || "").trim(),
  con1: (process.env.TTS_VOICE_CON1 || process.env.TTS_VOICE_DEFAULT || "").trim(),
  con2: (process.env.TTS_VOICE_CON2 || process.env.TTS_VOICE_DEFAULT || "").trim(),
  con3: (process.env.TTS_VOICE_CON3 || process.env.TTS_VOICE_DEFAULT || "").trim()
};

app.get("/api/tts/config", (req, res) => {
  res.json({
    mode: TTS_MODE === "external" && TTS_API_KEY ? "external" : "browser",
    provider: TTS_PROVIDER || null
  });
});

/** Call ElevenLabs text-to-speech. Returns Buffer or null. */
async function ttsElevenLabs(apiKey, { text, voiceId, speed = 1 }) {
  const voice_id = (voiceId && voiceId.trim()) || Object.values(SPEAKER_VOICE_IDS).find((id) => id && id.trim());
  if (!voice_id) return null;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice_id)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
      Accept: "audio/mpeg"
    },
    body: JSON.stringify({
      text: String(text).slice(0, 5000),
      model_id: process.env.TTS_ELEVEN_MODEL || "eleven_monolingual_v1",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 }
    })
  });
  if (!res.ok) {
    const err = await res.text();
    console.warn("[TTS] ElevenLabs error", res.status, err?.slice(0, 200));
    return null;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length ? buf : null;
}

app.post("/api/tts", async (req, res) => {
  if (TTS_MODE !== "external" || !TTS_API_KEY) {
    return res.status(501).json({ error: "External TTS not configured; use browser TTS." });
  }
  const { text, speakerId, voice, speed } = req.body || {};
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "Missing text" });
  }
  const voiceId = (speakerId && SPEAKER_VOICE_IDS[speakerId]) || SPEAKER_VOICE_IDS.pro1 || "";
  if (TTS_PROVIDER === "elevenlabs" && voiceId) {
    try {
      const audioBuffer = await ttsElevenLabs(TTS_API_KEY, {
        text,
        voiceId,
        speed: typeof speed === "number" ? speed : 0.95
      });
      if (audioBuffer) {
        res.set("Content-Type", "audio/mpeg").send(audioBuffer);
        return;
      }
    } catch (e) {
      console.warn("[TTS] ElevenLabs failed", e?.message);
    }
  }
  res.status(501).set("Content-Type", "application/json").json({
    error: "External TTS not implemented or missing voice IDs. Set TTS_PROVIDER=elevenlabs, TTS_API_KEY, and TTS_VOICE_PRO1 etc. in .env (see VOICE_SETUP.md)."
  });
});

/**
 * Generate full debate script in one go (same segments as stream, no user slots).
 * Used by frontend "Full Script" mode to show transcript instantly before live stream.
 * Keeps token budgets; allows longer in detailMode.
 */
app.post("/api/generateScript", async (req, res) => {
  const topic = (req.body?.topic || "").toString().trim();
  const detailMode = !!(req.body?.detailMode);

  if (!topic) {
    res.status(400).json({ error: "Missing topic" });
    return;
  }

  /** Single source of truth for this request: one motion, never mixed with other requests. */
  const motionForThisDebate = topic;

  const segments = buildDebateSegments();
  let lastProText = "";
  let lastConText = "";
  let lastSpeakerText = "";
  const scriptTurns = [];
  const fullTextParts = [];

  try {
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isChair = segment.roleType === "chair";
      const isPro = segment.speakerId && segment.speakerId.startsWith("pro");
      const opponentOrLastText = isChair ? lastSpeakerText : isPro ? lastConText : lastProText;
      const recentTurns = scriptTurns.slice(-3).map((t) => ({ speakerId: t.speakerId, label: t.speakerLabel, text: t.text }));
      const sameSideTurns =
        !isChair && segment.roleType === "debater"
          ? scriptTurns
              .filter((t) => t.speakerId.startsWith("pro") === isPro)
              .slice(-3)
              .map((t) => ({ speakerId: t.speakerId, label: t.speakerLabel, text: t.text }))
          : [];
      const context = { previousOpponentText: opponentOrLastText || undefined, detailMode, recentTurns, sameSideTurns };

      const text = await generateSegmentTextServer(motionForThisDebate, segment, context);

      if (segment.roleType === "debater") {
        if (isPro) lastProText = text;
        else lastConText = text;
        lastSpeakerText = text;
      }

      const side = segment.speakerId && segment.speakerId.startsWith("pro") ? "PRO" : segment.speakerId && segment.speakerId.startsWith("con") ? "CON" : "CHAIR";
      scriptTurns.push({
        turnIndex: i + 1,
        speakerId: segment.speakerId,
        speakerLabel: segment.label,
        side,
        text,
        roleType: segment.roleType,
        roleSubType: segment.roleSubType
      });
      if (text) fullTextParts.push(text);
    }

    const fullText = fullTextParts.join("\n\n");
    res.json({ turns: scriptTurns, fullText });
  } catch (err) {
    console.error("Error generating script:", err);
    const code = err.code || 500;
    res.status(code).json({
      error: {
        code,
        message: err.message || "Script generation failed",
        raw: err.raw
      }
    });
  }
});

app.post("/api/user-speech", (req, res) => {
  const { streamId, segmentId, text } = req.body || {};
  if (!streamId || !segmentId) {
    res.status(400).json({ error: "Missing streamId or segmentId" });
    return;
  }
  const pending = pendingUserSpeeches.get(streamId);
  if (!pending || pending.segmentId !== segmentId) {
    res.status(404).json({ error: "No pending turn for this stream/segment" });
    return;
  }
  pendingUserSpeeches.delete(streamId);
  const safeText = sanitizeText((text || "").trim()) || "(No speech received.)";
  pending.resolve(safeText);
  res.json({ ok: true });
});

app.get("/api/stream", async (req, res) => {
  const topic = (req.query.topic || "").toString().trim();
  const userSlot = (req.query.userSlot || "").toString().trim().toLowerCase();
  const validSlots = ["pro1", "pro2", "pro3", "con1", "con2", "con3"];
  const slot = validSlots.includes(userSlot) ? userSlot : null;

  if (!topic) {
    res.status(400).end("Missing topic");
    return;
  }

  /** Single source of truth for this stream: one motion, never overwritten or mixed with other sessions. */
  const motionForThisDebate = topic;

  const streamId = randomStreamId();

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent({ type: "status", message: "debate_started", streamId });

  streamSessions.set(streamId, {
    currentSegmentId: null,
    aiObjectionTokensPro: AI_OBJECTION_TOKENS_PER_SIDE,
    aiObjectionTokensCon: AI_OBJECTION_TOKENS_PER_SIDE,
    segmentHadObjection: false,
    emittedSentencesInSegment: []
  });

  const debateSegments = buildDebateSegments();
  /** Request-scoped only: no cross-request or cross-topic state. New debate = fresh context. */
  let lastProText = "";
  let lastConText = "";
  let lastSpeakerText = "";
  const recentTurnsList = [];

  try {
    for (let i = 0; i < debateSegments.length; i++) {
      const segment = debateSegments[i];
      const session = streamSessions.get(streamId);

      if (session) {
        session.currentSegmentId = segment.id;
        session.segmentHadObjection = false;
        session.emittedSentencesInSegment = [];
      }
      let safeText;

      if (slot && segment.speakerId === slot && segment.roleType === "debater") {
        sendEvent({
          type: "your_turn",
          speakerId: segment.speakerId,
          speakerLabel: segment.label,
          segmentId: segment.id,
          roleType: segment.roleType,
          roleSubType: segment.roleSubType
        });
        safeText = await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            if (pendingUserSpeeches.get(streamId)?.segmentId === segment.id) {
              pendingUserSpeeches.delete(streamId);
              resolve("(User did not speak in time.)");
            }
          }, USER_SPEECH_TIMEOUT_MS);
          pendingUserSpeeches.set(streamId, {
            segmentId: segment.id,
            resolve: (text) => {
              clearTimeout(timeout);
              resolve(text);
            }
          });
        });
      } else {
        const isChair = segment.roleType === "chair";
        const isOpeningChair = isChair && segment.roleSubType === "openingChair";
        if (i === 0 && isOpeningChair) {
          safeText = `The motion for this round is: ${motionForThisDebate}. First speaker.`;
        } else {
          const isPro = segment.speakerId && segment.speakerId.startsWith("pro");
          const opponentOrLastText = isChair ? lastSpeakerText : isPro ? lastConText : lastProText;
          const recentTurns = recentTurnsList.slice(-3);
          const sameSideTurns =
            !isChair && segment.roleType === "debater"
              ? recentTurnsList.filter((t) => t.speakerId.startsWith("pro") === isPro).slice(-3)
              : [];
          const previousSegment = i > 0 ? debateSegments[i - 1] : null;
          const previousTurnWasUser = !!(
            slot &&
            previousSegment &&
            previousSegment.roleType === "debater" &&
            previousSegment.speakerId === slot
          );
          const context = {
            previousOpponentText: opponentOrLastText || undefined,
            recentTurns,
            sameSideTurns,
            previousTurnWasUser,
            streamMode: true
          };
          safeText = await generateSegmentTextServer(motionForThisDebate, segment, context);
        }
      }

      if (segment.roleType === "chair" && segment.roleSubType === "closingChair") {
        const looksLikeOpening =
          /\b(definition|First speaker|I ask for)\b/i.test(safeText) ||
          (/\bmotion\s+for\s+this\s+debate\b/i.test(safeText) && safeText.length > 60);
        if (looksLikeOpening) safeText = "This round is closed.";
      }
      if (segment.roleType === "debater") {
        const isPro = segment.speakerId && segment.speakerId.startsWith("pro");
        if (isPro) lastProText = safeText;
        else lastConText = safeText;
        lastSpeakerText = safeText;
      }
      recentTurnsList.push({ speakerId: segment.speakerId, label: segment.label, text: safeText });

      // Split on full-width 。！？, half-width !?, and newline only (not on .) so streamed chunks stay longer.
      const sentences = safeText
        .split(/(?<=[。！？!？\n])/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      if (sentences.length === 0) {
        continue;
      }

      let skipNextSentence = false;
      const heatLevel = (DEBATE_CONFIG.heatLevel || "high").toLowerCase();
      const isMediumOrHigh = heatLevel === "medium" || heatLevel === "high";

      for (let si = 0; si < sentences.length; si++) {
        if (skipNextSentence) {
          skipNextSentence = false;
          continue;
        }
        const sentence = sentences[si];
        const payload = {
          type: "speech",
          speakerId: segment.speakerId,
          speakerLabel: segment.label,
          roleType: segment.roleType,
          roleSubType: segment.roleSubType,
          segmentId: segment.id,
          segmentIndex: i,
          text: sentence,
          fullText: safeText,
          isFirstSentence: si === 0,
          isLastSentence: si === sentences.length - 1
        };
        sendEvent(payload);
        await new Promise((resolve) => setTimeout(resolve, 100));

        const sess = streamSessions.get(streamId);
        if (sess) sess.emittedSentencesInSegment.push(sentence);

        if (
          sess &&
          segment.roleType === "debater" &&
          !sess.segmentHadObjection &&
          isMediumOrHigh &&
          /rebuttal|statement/.test(segment.roleSubType || "")
        ) {
          const speakerSide = segment.speakerId && segment.speakerId.startsWith("pro") ? "PRO" : "CON";
          const opponentSide = speakerSide === "PRO" ? "CON" : "PRO";
          const aiTokens = opponentSide === "PRO" ? sess.aiObjectionTokensPro : sess.aiObjectionTokensCon;
          if (aiTokens > 0) {
            const excerpt = (sess.emittedSentencesInSegment || []).slice(-4).join(" ").trim();
            const candidate = getAIObjectionCandidate(excerpt);
            if (candidate.shouldObject && candidate.objectionType) {
              const objectorId =
                opponentSide === "PRO"
                  ? Math.random() < 0.5
                    ? "pro1"
                    : "pro2"
                  : Math.random() < 0.5
                    ? "con3"
                    : "con1";
              const justification = await callAIObjectionLine(objectorId, candidate.objectionType);
              sendEvent({
                type: "objection",
                speakerId: objectorId,
                speakerLabel: SPEAKER_DISPLAY_NAMES[objectorId],
                side: opponentSide === "PRO" ? "pro" : "con",
                objectionType: candidate.objectionType,
                justification,
                segmentId: segment.id,
                raisedBy: "ai"
              });
              const ruling = await callJudgeRuling(
                motionForThisDebate,
                candidate.objectionType,
                excerpt,
                segment.roleSubType,
                speakerSide,
                opponentSide
              );
              sendEvent({
                type: "ruling",
                speakerId: "chair",
                speakerLabel: SPEAKER_DISPLAY_NAMES.chair,
                ruling: ruling.ruling,
                reason: ruling.reason,
                penalty: ruling.penalty,
                segmentId: segment.id
              });
              if (ruling.ruling === "SUSTAINED") {
                if (ruling.penalty && ruling.penalty.forceCorrection) {
                  const correctionLine = await callCorrectionLine(
                    motionForThisDebate,
                    segment,
                    candidate.objectionType,
                    excerpt
                  );
                  if (correctionLine) {
                    sendEvent({
                      type: "speech",
                      speakerId: segment.speakerId,
                      speakerLabel: segment.label,
                      roleType: segment.roleType,
                      roleSubType: segment.roleSubType,
                      segmentId: segment.id,
                      segmentIndex: i,
                      text: correctionLine,
                      fullText: correctionLine,
                      isFirstSentence: false,
                      isLastSentence: false,
                      isCorrection: true
                    });
                    await new Promise((resolve) => setTimeout(resolve, 200));
                  }
                }
                if (ruling.penalty && ruling.penalty.sentenceCut > 0) skipNextSentence = true;
              }
              sess.segmentHadObjection = true;
              if (opponentSide === "PRO") sess.aiObjectionTokensPro--;
              else sess.aiObjectionTokensCon--;
            }
          }
        }
      }
    }

    sendEvent({ type: "status", message: "debate_finished" });
    streamSessions.delete(streamId);
    res.end();
  } catch (err) {
    console.error("Error during debate stream:", err);
    pendingUserSpeeches.delete(streamId);
    streamSessions.delete(streamId);
    const code = err.code || 500;
    if (code === 401) {
      console.warn("[OpenRouter 401] Key rejected. Go to https://openrouter.ai/keys → create a new key, copy it into .env as OPENROUTER_API_KEY=..., then restart server.");
    }
    const message = code === 401 ? "OpenRouter auth failed" : (err.message || "internal_error");
    try {
      sendEvent({ type: "error", code, message });
      sendEvent({ type: "status", message: "debate_finished" });
    } catch {
      // ignore
    }
    res.end();
  }
});

/** Conclusion: hope for ~3s; do not abort early — keep loading until response or long timeout (60s). */
const CONCLUSION_TIMEOUT_MS = 60000;
const CONCLUSION_REQUEST_TIMEOUT_MS = 55000;

/** POST /api/conclusion — Topic-only deep analysis (no transcript). Single-call, good model for quality. */
app.post("/api/conclusion", async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const motion = (req.body?.motion || "").toString().trim();

  if (!motion) {
    return res.status(400).json({ ok: false, error: { code: 400, message: "Missing motion" } });
  }

  const fetchOpenRouter = async (body) => {
    const result = await fetchOpenRouterWithFallback(body, {
      requestTimeoutMs: CONCLUSION_REQUEST_TIMEOUT_MS,
      primaryModel: OPENROUTER_MODEL_CONCLUSION
    });
    if (result.ok) return { ok: true, data: result.data, modelUsed: result.modelUsed };
    return { ok: false, message: (result.raw || "").slice(0, 200) };
  };

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Conclusion timed out")), CONCLUSION_TIMEOUT_MS)
  );

  try {
    const json = await Promise.race([
      generateConclusion({ topic: motion, fetchOpenRouter, model: OPENROUTER_MODEL_CONCLUSION }),
      timeoutPromise
    ]);
    return res.json(json);
  } catch (err) {
    console.error("[conclusion]", err?.message || err);
    const isTimeout = err?.name === "AbortError" || /timeout|aborted/i.test(String(err?.message || ""));
    const msg = String(err?.message || "Conclusion failed");
    const invalidJson = /not valid JSON/i.test(msg);
    const message = isTimeout ? "Conclusion timed out" : msg;
    let hint = "";
    if (isTimeout) {
      hint = " Conclusion request timed out. Try again or use a faster model in OPENROUTER_MODEL_CONCLUSION.";
    } else if (invalidJson) {
      hint = " The model returned text that wasn’t valid JSON. Try again or set OPENROUTER_MODEL_CONCLUSION=openai/gpt-4o in .env.";
    } else {
      hint = " Check OPENROUTER_API_KEY and OPENROUTER_MODEL in .env.";
    }
    return res.status(200).json({
      ok: false,
      error: { code: isTimeout ? 408 : 500, message: message + hint }
    });
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

