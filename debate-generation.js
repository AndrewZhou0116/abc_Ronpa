/**
 * Debate segment generation. Single prompting path via prompts.js.
 * Character backgrounds (SPEAKER_BACKGROUNDS) injected by speakerId.
 */
import { SPEAKER_BACKGROUNDS } from "./character-backgrounds.js";
import { DEBATE_CONFIG, TOKEN_BUDGETS, MODEL_CONFIG } from "./debate-config.js";
import {
  buildPrompt,
  getSystemMessage,
  getCompressionUserPrompt,
  FORBIDDEN_PHRASES,
  SIDE_FLIP_RETRY_INSTRUCTION,
  BANNED_STEM_REGEXES,
  ABSTRACT_NOUNS,
  CONCRETIZERS,
  TEMPLATE_REWRITE_PROMPT,
  MULTI_QUESTION_REWRITE_PROMPT,
  VOICEPRINT_CHECKLIST,
  VOICEPRINT_REWRITE_PROMPT,
  ANTI_HOMOGENIZATION_BANLIST,
  buildPersonaRewriteUserPrompt
} from "./prompts.js";
import { routeSegment } from "./budget-router.js";
import { validateOutput } from "./segment-validator.js";
import {
  selectModelAndBudget,
  segmentBudget,
  buildValidatorContract,
  buildRepairPrompt,
  getRepairParams,
  shouldUpgradeImmediately,
  getStageKeyForSegment
} from "./quality-ladder.js";
import { buildLadderPrompt } from "./prompt-builder-ladder.js";

/** Count sentences (split on . ! ?). */
function countSentences(text) {
  if (!text || typeof text !== "string") return 0;
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

/**
 * Cheap heuristic: should we consider an AI objection for this excerpt?
 * Returns { shouldObject: boolean, objectionType?: "hearsay"|"relevance"|"assumption" }.
 * Caller should still gate by heatLevel, roleSubType, and per-side tokens.
 * Order: relevance and assumption checked first (more specific); hearsay last (narrowed) so types stay balanced.
 */
export function getAIObjectionCandidate(excerpt) {
  if (!excerpt || typeof excerpt !== "string") return { shouldObject: false };
  const t = excerpt.trim();
  if (t.length < 20) return { shouldObject: false };
  const lower = t.toLowerCase();
  const hasSupport = /\b(because|since|as|evidence|data|show|proof|study|according to)\b/i.test(lower);

  // Relevance first: topic-drift, filler, or explicit irrelevance (common in debate)
  if (/\b(anyway|moving on|that (reminds me|brings me)|off (topic|point)|besides the point|irrelevant|not the point|missing the point|that'?s not (the )?(issue|what we'?re debating)|straw man)\b/i.test(lower)) {
    return { shouldObject: true, objectionType: "relevance" };
  }
  // Assumption: unsupported "obviously", "clearly", "everyone knows", "the fact is", "certainly", or universal claims
  if (!hasSupport && (/\b(obviously|clearly|everyone knows|we all know|it'?s (clear|obvious)|of course|without (a )?doubt|undoubtedly|the fact is|certainly|naturally|simply put|it goes without saying)\b/i.test(lower) ||
      /\b(everyone|no one|nobody|everybody)\s+(knows|agrees|believes|thinks)\b/i.test(lower))) {
    return { shouldObject: true, objectionType: "assumption" };
  }
  // Hearsay last (narrowed): specific stats or "studies/show" only when no clear attribution in excerpt
  const hasAttribution = /\baccording to [a-z]+|et al\.|\(20\d{2}\)|published in|source:\s*\w/i.test(lower);
  if (!hasAttribution && (/\d+%|\b(studies|research|evidence)\s+show(s)?\b|\b(experts|many people|scholars)\s+(say|believe|argue)\b|it is (well )?known that/i.test(lower))) {
    return { shouldObject: true, objectionType: "hearsay" };
  }
  return { shouldObject: false };
}

/** Split into sentences (with trailing punctuation) and return word count per sentence. */
function getSentencesAndWordCounts(text) {
  if (!text || typeof text !== "string") return { sentences: [], wordCounts: [] };
  const sentences = (text.match(/[^.!?]*[.!?]+/g) || []).map((s) => s.trim()).filter(Boolean);
  const wordCounts = sentences.map((s) => s.split(/\s+/).filter(Boolean).length);
  return { sentences, wordCounts };
}

/** Post-generation gate: default 1–6 sentences (compress only when >6); detail 3–6; interjection 1. Each sentence ≤30 words. */
function needsDebaterSentenceGate(text, segment, detailMode) {
  const { sentences, wordCounts } = getSentencesAndWordCounts(text);
  const maxSentences = detailMode ? 6 : (segment?.roleSubType === "interjection" ? 1 : 6);
  const minSentences = detailMode ? 3 : (segment?.roleSubType === "interjection" ? 1 : 1);
  if (sentences.length < minSentences || sentences.length > maxSentences) return true;
  return wordCounts.some((c) => c > 30);
}

/** Count question marks in text (max 1 per turn enforced by validator). */
function countQuestions(text) {
  if (!text || typeof text !== "string") return 0;
  return (text.match(/\?/g) || []).length;
}

/** Post-gen validator: max 1 question per turn, max 3 sentences when !detailMode. Log violations; return true if rewrite needed. */
const MAX_QUESTIONS_PER_TURN = 1;
const MAX_SENTENCES_NON_DETAIL = 6;

function runPacingValidator(text, segment, detailMode) {
  if (!text || segment?.roleType !== "debater") return { questionsOk: true, sentencesOk: true };
  const qCount = countQuestions(text);
  const sCount = countSentences(text);
  const questionsOk = qCount <= MAX_QUESTIONS_PER_TURN;
  const sentencesOk = detailMode || segment?.roleSubType === "interjection" || sCount <= MAX_SENTENCES_NON_DETAIL;
  if (!questionsOk) {
    console.log(`[DEBATE] violation: speaker=${segment.speakerId} questions=${qCount} max=${MAX_QUESTIONS_PER_TURN}`);
  }
  if (!sentencesOk) {
    console.log(`[DEBATE] violation: speaker=${segment.speakerId} sentences=${sCount} max=${MAX_SENTENCES_NON_DETAIL} (non-detail)`);
  }
  return { questionsOk, sentencesOk, questionCount: qCount };
}

/** Template detector: banned stems (how can you, what evidence, builds trust, fosters, etc.). */
function detectBannedStem(text) {
  if (!text || typeof text !== "string") return false;
  return BANNED_STEM_REGEXES.some((re) => re.test(text));
}

/** Template detector: abstract noun salad (2+ abstract nouns, no concretizer). */
function detectAbstractNounSalad(text) {
  if (!text || typeof text !== "string") return false;
  const lower = text.toLowerCase();
  const abstractCount = ABSTRACT_NOUNS.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(lower)).length;
  const hasConcretizer = CONCRETIZERS.some((w) => new RegExp(`\\b${w.replace(/\s+/g, "\\s+")}\\b`, "i").test(lower));
  return abstractCount >= 2 && !hasConcretizer;
}

/** Question-only loop: last N turn texts all end with "?" => next should be closure. Handled in buildPrompt via context.recentTurns. */
function lastTurnsAllQuestions(recentTurnTexts = [], count = 2) {
  const last = recentTurnTexts.slice(-count);
  return last.length >= count && last.every((t) => /\?$/.test((t || "").trim()));
}

/** Run template/abstract detectors; if flagged, return true so we run rewrite pass. */
function shouldRunTemplateRewrite(text, segment) {
  if (!text || segment?.roleType === "chair") return false;
  return detectBannedStem(text) || detectAbstractNounSalad(text);
}

/** Escape special regex chars for use in RegExp. */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if text contains any term from ANTI_HOMOGENIZATION_BANLIST for speakerId (case-insensitive).
 * Multi-word phrases matched as phrase; single words as whole-word.
 * Optional: allow term if it appears only inside double-quoted segment (quoting opponent).
 */
function containsBannedTerm(text, speakerId) {
  if (!text || typeof text !== "string") return false;
  const list = ANTI_HOMOGENIZATION_BANLIST[speakerId];
  if (!Array.isArray(list) || list.length === 0) return false;
  for (const term of list) {
    const t = String(term).trim();
    if (!t) continue;
    let re;
    if (/\s/.test(t)) {
      re = new RegExp(escapeRegex(t).replace(/\s+/g, "\\s+"), "gi");
    } else {
      re = new RegExp("\\b" + escapeRegex(t) + "\\b", "gi");
    }
    let match;
    while ((match = re.exec(text)) !== null) {
      const before = text.slice(0, match.index);
      const insideQuotes = (before.match(/"/g) || []).length % 2 === 1;
      if (!insideQuotes) return true;
    }
  }
  return false;
}

/**
 * Persona validator: required voiceprint markers + sentence count + anti-homogenization banlist.
 * @param {string} text
 * @param {string} speakerId
 * @returns {{ ok: boolean }}
 */
function validatePersona(text, speakerId) {
  if (!text || typeof text !== "string") return { ok: false };
  if (containsBannedTerm(text, speakerId)) return { ok: false };
  const entry = VOICEPRINT_CHECKLIST[speakerId];
  if (!entry || !entry.markers || !Array.isArray(entry.markers)) return { ok: true };
  const sCount = countSentences(text);
  const [minS, maxS] = entry.sentenceRange || [1, 6];
  if (sCount < minS || sCount > maxS) return { ok: false };
  for (const m of entry.markers) {
    if (!m.regex || !m.regex.test(text)) return { ok: false };
  }
  return { ok: true };
}
import { EMOJI_PATTERN, NON_FACIAL_EMOJI_PATTERN } from "./debate-style.js";
import fetch from "node-fetch";

const {
  turnSentencesBySpeaker,
  logPromptForSpeakers,
  debugLogBeforeGeneration,
  logTokenBudget,
  allowFacialEmoji,
  maxFacialPerTurn,
  chairEmojis,
  enableSideFlipDetector,
  useCompressStep
} = DEBATE_CONFIG;

/**
 * Choose max_tokens for this segment/pass. Used to reduce cost (no single 16k cap).
 * @param {{ roleType: string, roleSubType?: string }} segment
 * @param {{ detailMode?: boolean }} context
 * @param {boolean} isCompressionPass
 * @returns {number}
 */
function getMaxTokensForSegment(segment, context, isCompressionPass) {
  if (isCompressionPass) return TOKEN_BUDGETS.compressionPass ?? 140;
  if (segment.roleType === "chair") return TOKEN_BUDGETS.chairMicro ?? 120;
  const detailMode = !!context.detailMode;
  if (detailMode) return TOKEN_BUDGETS.detailTurn ?? 500;
  if (segment.roleSubType === "interjection") return TOKEN_BUDGETS.interjection ?? 70;
  return TOKEN_BUDGETS.debaterMicro ?? 180;
}

function logLLMCall(speakerId, roleType, roleSubType, detailMode, maxTokens, model, pass) {
  if (!logTokenBudget) return;
  const type = roleType === "chair" ? "chair" : `${roleType}/${roleSubType || "—"}`;
  console.log(`[LLM] speaker=${speakerId} type=${type} detail=${detailMode} max_tokens=${maxTokens} model=${model} pass=${pass}`);
}

function getSentenceBudget(segment, detailMode) {
  if (detailMode) return [3, 6];
  if (segment.roleSubType === "interjection") return [1, 1];
  return [1, MAX_SENTENCES_NON_DETAIL];
}

function detectSideFlip(speakerId, text) {
  const t = text.toLowerCase();
  const isPro = /^pro\d$/.test(speakerId);
  if (isPro) {
    if (/\b(oppose|against|reject)\s+(the\s+)?motion\b/.test(t)) return true;
    if (/\bthe\s+motion\s+is\s+(wrong|flawed|harmful|bad)\b/.test(t)) return true;
    if (/\b(we're|we are|i'm|i am)\s+against\b/.test(t)) return true;
    if (/\bwe're\s+opposed\b|\bwe\s+oppose\b/.test(t)) return true;
  } else {
    if (/\b(support|in favor of|adopt)\s+(the\s+)?motion\b/.test(t)) return true;
    if (/\bthe\s+motion\s+is\s+(right|good|necessary)\b/.test(t)) return true;
  }
  return false;
}

function getSideFlipRetryInstruction(speakerId) {
  const isPro = /^pro\d$/.test(speakerId);
  return isPro
    ? SIDE_FLIP_RETRY_INSTRUCTION.replace("PRO/CON", "PRO").replace("defends/opposes", "defends")
    : SIDE_FLIP_RETRY_INSTRUCTION.replace("PRO/CON", "CON").replace("defends/opposes", "opposes");
}

/**
 * Build full user prompt: character background (from character-backgrounds.js) + prompt from prompts.js.
 */
export function buildSegmentPrompt(topic, segment, context = {}) {
  const detailMode = !!context.detailMode;
  const sentenceBudget = getSentenceBudget(segment, detailMode);
  const { system, user } = buildPrompt(topic, segment, context, {
    sentenceBudget,
    chairEmojis: chairEmojis ?? false,
    heatLevel: DEBATE_CONFIG.heatLevel ?? "high",
    allowFacialEmoji: segment.roleType === "chair" ? (chairEmojis ?? false) : (DEBATE_CONFIG.allowFacialEmoji !== false)
  });
  const background = segment.speakerId && SPEAKER_BACKGROUNDS[segment.speakerId]
    ? String(SPEAKER_BACKGROUNDS[segment.speakerId]).trim()
    : "";
  const characterBlock = background
    ? `Character background (stay in persona; shape tone and reasoning):\n"""\n${background}\n"""\n\n`
    : "";
  return { system, user: characterBlock + user };
}

export function getSystemPrompt(role = "debater") {
  return getSystemMessage(role);
}

/**
 * Sanitize output: strip forbidden phrases and enforce emoji rules.
 */
export function sanitizeDebateOutput(text, segment = {}) {
  if (!text || typeof text !== "string") return "";
  let out = text;
  for (const phrase of FORBIDDEN_PHRASES) {
    const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(re, "").replace(/\s{2,}/g, " ").trim();
  }
  const isChair = segment.roleType === "chair";
  if (isChair || !allowFacialEmoji) {
    out = out.replace(EMOJI_PATTERN, "").replace(/\s{2,}/g, " ").trim();
  } else {
    out = out.replace(NON_FACIAL_EMOJI_PATTERN, "");
    const facialRegex = /[\u{1F600}-\u{1F64F}\u{1F910}-\u{1F92F}\u{1F978}]/gu;
    const matches = [...(out.match(facialRegex) || [])];
    const maxFacial = maxFacialPerTurn ?? 1;
    if (matches.length > maxFacial) {
      let n = 0;
      out = out.replace(facialRegex, (m) => (n++ < matches.length - maxFacial ? "" : m));
    }
    out = out.replace(/\s{2,}/g, " ").trim();
  }
  return out.trim();
}

/**
 * Single OpenRouter client used by both live stream and full-script generation.
 * If opts.modelFallbacks is set, on 5xx/429 retries with next model in list.
 * Throws on non-ok response; never return error string as "text" (no dialogue leak).
 */
async function callOpenRouter(body, apiKey, opts = {}) {
  const primary = (body.model || "").trim();
  if (!primary) {
    throw new Error("OPENROUTER_MODEL is required. Set it in .env (e.g. OPENROUTER_MODEL=anthropic/claude-opus-4).");
  }
  const fallbacks = Array.isArray(opts.modelFallbacks) ? opts.modelFallbacks : [];
  const modelsToTry = [
    primary,
    ...fallbacks.filter((m) => (m || "").trim() && (m || "").trim() !== primary)
  ].filter(Boolean);

  let lastErr = null;
  for (const model of modelsToTry) {
    const b = { ...body, model };
    const maxTokens = b.max_tokens ?? "?";
    console.log("[OR] calling", model, "keyPrefix", (apiKey || "").slice(0, 8), "max_tokens", maxTokens);

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "debate-sim"
      },
      body: JSON.stringify(b)
    });
    if (response.ok) {
      const data = await response.json();
      return { text: (data.choices?.[0]?.message?.content || "").trim() };
    }
    const raw = await response.text();
    let message = raw;
    try {
      const j = JSON.parse(raw);
      message = j.error?.message || j.message || raw;
    } catch {
      // use raw
    }
    lastErr = new Error(`OpenRouter: ${message}`);
    lastErr.code = response.status;
    lastErr.raw = raw;
    lastErr.rawSnippet = raw.slice(0, 300);
    if (response.status >= 500 || response.status === 429) {
      console.warn("[OR] model", model, "failed", response.status, "trying fallback");
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

/**
 * Quality Ladder: generate with selected model (mid/cheap/expensive) → validate → repair (cheap) → upgrade (expensive) only if needed.
 * Logs: [SEGMENT], [VALIDATE], [REPAIR], [UPGRADE].
 */
async function runQualityLadder(topic, segment, context, opts) {
  const apiKey = opts.apiKey;
  const cheapModel = (opts.cheapModel || "openai/gpt-4o-mini").trim();
  const midModel = (opts.midModel || "anthropic/claude-sonnet-4").trim();
  const expensiveModel = (opts.expensiveModel || "anthropic/claude-opus-4").trim();
  const modelFallbacks = Array.isArray(opts.modelFallbacks) ? opts.modelFallbacks : [];

  const banlist = segment.speakerId && ANTI_HOMOGENIZATION_BANLIST[segment.speakerId];
  const banlist_size = Array.isArray(banlist) ? banlist.length : 0;
  const ladderContext = { ...context, banlist_size };

  const selected = selectModelAndBudget(segment, ladderContext, {
    cheap: cheapModel,
    mid: midModel,
    expensive: expensiveModel
  });
  const { model: selectedModel, max_tokens, temperature, strictness, stage } = selected;

  console.log(`[SEGMENT] id=${segment.id || segment.speakerId} stage=${stage} model=${selectedModel} max_tokens=${max_tokens} temp=${temperature}`);

  const contractOpts = {
    forbiddenPhrases: FORBIDDEN_PHRASES,
    bannedStems: BANNED_STEM_REGEXES,
    bannedWordsSpeaker: banlist || []
  };
  const contract = buildValidatorContract(segment, context, contractOpts);

  const { system, user } = buildLadderPrompt(topic, segment, context, {
    bannedWordsSpeaker: contractOpts.bannedWordsSpeaker
  });

  const callOnce = async (model, maxTok, temp) => {
    const body = { model, max_tokens: maxTok, temperature: temp, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
    const res = await callOpenRouter(body, apiKey, { modelFallbacks });
    const text = (res && res.text) ? res.text.trim() : "";
    const validation = validateOutput(text, contract);
    return { text, validation };
  };

  const repairOnce = async (currentText, failList) => {
    const repairUser = buildRepairPrompt(contract, context.previousOpponentText || "", failList || [], currentText);
    const rep = getRepairParams();
    const body = { model: cheapModel, max_tokens: rep.max_tokens, temperature: rep.temperature, messages: [{ role: "system", content: "You fix a debate turn to satisfy the contract. Output only the speech." }, { role: "user", content: repairUser }] };
    const res = await callOpenRouter(body, apiKey, { modelFallbacks });
    const repaired = (res && res.text) ? res.text.trim() : "";
    const revalid = validateOutput(repaired, contract);
    console.log(`[REPAIR] used=true model=${cheapModel} validator=${revalid.pass ? "pass" : "fail"}`);
    return { text: repaired, validation: revalid };
  };

  let validation;
  let text = "";
  let repairUsed = false;
  let upgradedToOpus = false;

  if (shouldUpgradeImmediately(segment, context, strictness)) {
    const out = await callOnce(expensiveModel, Math.min(max_tokens + 100, 900), Math.min(temperature, 0.5));
    text = out.text;
    validation = out.validation;
    console.log(`[VALIDATE] pass=${validation.pass} reasons=${validation.pass ? "[]" : JSON.stringify(validation.failures.map((f) => f.rule + ":" + (f.detail || "")))}`);
    if (!validation.pass) {
      const rep = await repairOnce(text, validation.failures);
      if (rep.validation.pass) {
        text = rep.text;
        validation = rep.validation;
        repairUsed = true;
      }
    }
    upgradedToOpus = true;
    console.log(`[UPGRADE] to_opus=true (conclusion/strict)`);
    return text;
  }

  const out = await callOnce(selectedModel, max_tokens, temperature);
  text = out.text;
  validation = out.validation;
  console.log(`[VALIDATE] pass=${validation.pass} reasons=${validation.pass ? "[]" : JSON.stringify(validation.failures.map((f) => f.rule + ":" + (f.detail || "")))}`);

  if (validation.pass) {
    console.log(`[REPAIR] used=false`);
    console.log(`[UPGRADE] to_opus=false`);
    return text;
  }

  const rep = await repairOnce(text, validation.failures);
  repairUsed = true;
  if (rep.validation.pass) {
    console.log(`[UPGRADE] to_opus=false`);
    return rep.text;
  }

  upgradedToOpus = true;
  const upgrade = await callOnce(expensiveModel, Math.min(max_tokens + 100, 900), 0.5);
  text = upgrade.text;
  validation = upgrade.validation;
  console.log(`[VALIDATE] pass=${validation.pass} reasons=${validation.pass ? "[]" : JSON.stringify(validation.failures.map((f) => f.rule + ":" + (f.detail || "")))} (after upgrade)`);
  if (!validation.pass) {
    const repOpus = await repairOnce(text, validation.failures);
    if (repOpus.validation.pass) text = repOpus.text;
  }
  console.log(`[UPGRADE] to_opus=true (mid+repair failed)`);
  return text;
}

/**
 * Generate segment text. Single prompt path via prompts.js.
 * Logs: speakerId, side, background length, first 60 chars. Prints full user prompt for Pro2/Con3 when configured.
 */
export async function generateSegmentText(topic, segment, context = {}, opts = {}) {
  const apiKey = opts.apiKey || "";
  const cheapModel = (opts.cheapModel || "").trim();
  const expensiveModel = (opts.expensiveModel || "").trim();
  const midModelOpt = (opts.midModel || "").trim();
  const useQualityLadder = DEBATE_CONFIG.useQualityLadder === true && cheapModel && midModelOpt && expensiveModel;
  const useBudgetRouter = !useQualityLadder && cheapModel && expensiveModel;
  const primaryModel = useBudgetRouter
    ? null
    : (opts.model || "").trim();
  if (!useQualityLadder && !useBudgetRouter && !primaryModel) {
    throw new Error("OPENROUTER_MODEL is required (or set cheapModel + expensiveModel for budget routing). Set it in .env.");
  }

  if (useQualityLadder) {
    const ladderText = await runQualityLadder(topic, segment, context, {
      apiKey,
      cheapModel,
      midModel: midModelOpt,
      expensiveModel,
      modelFallbacks: Array.isArray(opts.modelFallbacks) ? opts.modelFallbacks : []
    });
    if (ladderText && DEBATE_CONFIG.sanitizeOutputForbidden) {
      return sanitizeDebateOutput(ladderText, segment);
    }
    return ladderText || "";
  }

  const sanitizeOutput = opts.sanitizeOutput !== false && DEBATE_CONFIG.sanitizeOutputForbidden;

  const compressModel = MODEL_CONFIG?.cheapModelForCompression
    ? String(MODEL_CONFIG.cheapModelForCompression).trim()
    : (useBudgetRouter ? cheapModel : primaryModel);
  let modelFallbacks = Array.isArray(opts.modelFallbacks) ? opts.modelFallbacks : [];
  const logPromptSpeakers = opts.logPromptSpeakers ?? logPromptForSpeakers ?? [];
  const debugLog = opts.debugLogBeforeGeneration !== false && DEBATE_CONFIG.debugLogBeforeGeneration;
  const enableFlip = opts.enableSideFlipDetector !== false && enableSideFlipDetector;
  const detailMode = !!context.detailMode;

  if (!apiKey) {
    const err = new Error("OPENROUTER_API_KEY is not configured. Set it in .env or pass apiKey in opts.");
    err.code = 503;
    throw err;
  }

  const background =
    segment.speakerId && SPEAKER_BACKGROUNDS[segment.speakerId]
      ? String(SPEAKER_BACKGROUNDS[segment.speakerId]).trim()
      : "";
  const side =
    segment.roleType === "chair" ? "chair" : segment.speakerId?.startsWith("pro") ? "PRO" : "CON";

  if (debugLog) {
    const preview = (background.slice(0, 60) || "(none)").replace(/\n/g, " ");
    console.log(`[DEBUG] speakerId=${segment.speakerId} side=${side} backgroundLen=${background.length} backgroundPreview=${preview}`);
  }

  const { system, user } = buildSegmentPrompt(topic, segment, context);

  if (logPromptSpeakers.includes(segment.speakerId)) {
    console.log("\n" + "=".repeat(60));
    console.log(`[PROMPT LOG] speakerId=${segment.speakerId} segmentId=${segment.id} side=${side}`);
    console.log("=".repeat(60));
    console.log("--- USER PROMPT ---\n");
    console.log(user);
    console.log("\n--- END USER PROMPT ---\n");
  }

  let chosenModel = primaryModel;
  let primaryMaxTokens = getMaxTokensForSegment(segment, context, false);
  let temperature = undefined;
  if (useBudgetRouter) {
    const banlist = segment.speakerId && ANTI_HOMOGENIZATION_BANLIST[segment.speakerId];
    const banlist_size = Array.isArray(banlist) ? banlist.length : 0;
    const contextLen = (context.recentTurns && context.recentTurns.length) || 0;
    const context_length = contextLen > 12 ? "long" : contextLen > 6 ? "medium" : "short";
    const persona_complexity = background.length > 800 ? "high" : background.length > 400 ? "medium" : "low";
    const route = routeSegment(
      {
        motion: topic,
        segment,
        banlist_size,
        must_hook: /rebuttal|summary/.test(segment.roleSubType || ""),
        exact_sentence_count: segment.roleSubType === "interjection" || segment.roleSubType === "closingChair",
        persona_complexity,
        context_length,
        quality_mode: context.streamMode ? "show" : (detailMode ? "final" : "draft"),
        cheap_failures_recent: context.cheapFailuresRecent ?? 0
      },
      { cheapModel, expensiveModel }
    );
    chosenModel = route.model;
    primaryMaxTokens = route.max_tokens;
    temperature = route.temperature;
    if (route.fallback.upgrade_to_opus) {
      modelFallbacks = [route.model === cheapModel ? expensiveModel : cheapModel];
    }
    if (logTokenBudget) {
      console.log(`[BUDGET] ${segment.speakerId} ${segment.roleSubType || ""} → ${route.risk} ${chosenModel} max_tokens=${primaryMaxTokens} temp=${temperature} (${route.reason})`);
    }
  }

  logLLMCall(segment.speakerId, segment.roleType, segment.roleSubType, detailMode, primaryMaxTokens, chosenModel, "primary");

  let body = {
    model: chosenModel,
    max_tokens: primaryMaxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  };
  if (temperature != null) body.temperature = temperature;

  let result = await callOpenRouter(body, apiKey, { modelFallbacks });
  let text = result.text;
  const isDebater = segment.roleType === "debater";
  const isChair = segment.roleType === "chair";
  const [minSentencesBudget, maxSentencesBudget] = getSentenceBudget(segment, detailMode);
  const maxCompressIterations = 3;
  const compressMaxTokens = getMaxTokensForSegment(segment, context, true);
  const isStreamMode = !!context.streamMode;

  // Soft length gate: compress only when >6 sentences (preserve closure/interjection; no question template). Skip in stream mode for lower latency.
  if (!isStreamMode && useCompressStep && isDebater && text && countSentences(text) > 6) {
    const compressUser = getCompressionUserPrompt(text, false);
    logLLMCall(segment.speakerId, "debater", segment.roleSubType, detailMode, compressMaxTokens, compressModel, "compress");
    const compressResult = await callOpenRouter(
      {
        model: compressModel,
        max_tokens: compressMaxTokens,
        messages: [{ role: "system", content: getSystemMessage("debater") }, { role: "user", content: compressUser }]
      },
      apiKey,
      { modelFallbacks }
    );
    if (compressResult && compressResult.text) text = compressResult.text;
  }

  // Sentence-budget gate: compress until within [min, max] for role. In stream mode only truncate if over cap, no extra API calls.
  if (text && countSentences(text) > maxSentencesBudget) {
    const role = isChair ? "chair" : "debater";
    const cap = isChair ? 2 : maxSentencesBudget;
    if (!isStreamMode) {
      for (let i = 0; i < maxCompressIterations && countSentences(text) > cap; i++) {
        const compressUser = getCompressionUserPrompt(text, isChair);
        logLLMCall(segment.speakerId, role, segment.roleSubType, detailMode, compressMaxTokens, compressModel, "compress");
        let compressResult;
        try {
          compressResult = await callOpenRouter(
            {
              model: compressModel,
              max_tokens: compressMaxTokens,
              messages: [{ role: "system", content: getSystemMessage(role) }, { role: "user", content: compressUser }]
            },
            apiKey,
            { modelFallbacks }
          );
        } catch {
          compressResult = null;
        }
        if (!compressResult || !compressResult.text) break;
        text = compressResult.text;
      }
    }
    // Hard gate: if still over cap, truncate to first cap sentences
    if (countSentences(text) > cap) {
      const sentences = text.match(/[^.!?]*[.!?]+/g);
      if (sentences && sentences.length > cap) {
        text = sentences.slice(0, cap).map((s) => s.trim()).join(" ").trim();
      }
    }
  }

  // Final gate for debaters: sentence count and per-sentence word cap
  if (isDebater && text && needsDebaterSentenceGate(text, segment, detailMode)) {
    const compressUser = getCompressionUserPrompt(text, false);
    logLLMCall(segment.speakerId, "debater", segment.roleSubType, detailMode, compressMaxTokens, compressModel, "compress");
    try {
      const compressResult = await callOpenRouter(
        {
          model: compressModel,
          max_tokens: compressMaxTokens,
          messages: [{ role: "system", content: getSystemMessage("debater") }, { role: "user", content: compressUser }]
        },
        apiKey,
        { modelFallbacks }
      );
      if (compressResult?.text) text = compressResult.text;
    } catch {
      // keep current text
    }
  }

  if (!isStreamMode && enableFlip && isDebater && text && detectSideFlip(segment.speakerId, text)) {
    const retryInstruction = getSideFlipRetryInstruction(segment.speakerId);
    logLLMCall(segment.speakerId, segment.roleType, segment.roleSubType, detailMode, primaryMaxTokens, chosenModel, "primary");
    body = {
      model: chosenModel,
      max_tokens: primaryMaxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user + retryInstruction }
      ]
    };
    if (temperature != null) body.temperature = temperature;
    try {
      const retryResult = await callOpenRouter(body, apiKey, { modelFallbacks });
      if (retryResult?.text) text = retryResult.text;
    } catch {
      // keep current text
    }
  }

  // Code-level template enforcement: if banned stem or abstract noun salad, run rewrite pass. Skip in stream mode for latency.
  if (!isStreamMode && isDebater && text && shouldRunTemplateRewrite(text, segment)) {
    const rewriteMaxTokens = 160;
    logLLMCall(segment.speakerId, "debater", segment.roleSubType, detailMode, rewriteMaxTokens, compressModel, "template_rewrite");
    const rewriteUser = `${TEMPLATE_REWRITE_PROMPT}\n\nCurrent turn:\n"""\n${text}\n"""`;
    try {
      const rewriteResult = await callOpenRouter(
        {
          model: compressModel,
          max_tokens: rewriteMaxTokens,
          messages: [{ role: "system", content: getSystemMessage("debater") }, { role: "user", content: rewriteUser }]
        },
        apiKey,
        { modelFallbacks }
      );
      if (rewriteResult?.text) text = rewriteResult.text;
    } catch {
      // keep current text
    }
  }

  // Post-gen validator: max 1 question per turn; if >1, run merge-to-one-question rewrite. Skip in stream mode for latency.
  const pacing = isDebater && text ? runPacingValidator(text, segment, detailMode) : { questionsOk: true, sentencesOk: true, questionCount: 0 };
  if (!isStreamMode && isDebater && text && !pacing.questionsOk && pacing.questionCount > MAX_QUESTIONS_PER_TURN) {
    const rewriteMaxTokens = 160;
    logLLMCall(segment.speakerId, "debater", segment.roleSubType, detailMode, rewriteMaxTokens, compressModel, "multi_question_rewrite");
    const rewriteUser = `${MULTI_QUESTION_REWRITE_PROMPT}\n\nCurrent turn:\n"""\n${text}\n"""`;
    try {
      const rewriteResult = await callOpenRouter(
        {
          model: compressModel,
          max_tokens: rewriteMaxTokens,
          messages: [{ role: "system", content: getSystemMessage("debater") }, { role: "user", content: rewriteUser }]
        },
        apiKey,
        { modelFallbacks }
      );
      if (rewriteResult?.text) text = rewriteResult.text;
    } catch {
      // keep current text
    }
  }

  // Persona voiceprint + banlist: if validation fails, one rewrite with explicit prompt (remove banned terms, add markers). Skip in stream mode for latency.
  const personaValid = (isDebater || isChair) && text ? validatePersona(text, segment.speakerId) : { ok: true };
  if (!isStreamMode && !personaValid.ok && text) {
    const rewriteMaxTokens = 200;
    logLLMCall(segment.speakerId, segment.roleType, segment.roleSubType, detailMode, rewriteMaxTokens, compressModel, "persona_rewrite");
    const rewriteUser = buildPersonaRewriteUserPrompt(
      topic,
      segment.speakerId,
      segment.roleSubType,
      context.previousOpponentText,
      text
    );
    try {
      const rewriteResult = await callOpenRouter(
        {
          model: compressModel,
          max_tokens: rewriteMaxTokens,
          messages: [
            { role: "system", content: getSystemMessage(isChair ? "chair" : "debater") },
            { role: "user", content: rewriteUser }
          ]
        },
        apiKey,
        { modelFallbacks }
      );
      if (rewriteResult?.text) text = rewriteResult.text;
    } catch {
      // keep current text
    }
  }

  if (sanitizeOutput) {
    text = sanitizeDebateOutput(text, segment);
  }
  return text;
}
