/**
 * Quality Ladder: three-tier routing (cheap / mid / expensive).
 * selectModelAndBudget(segment) → { model, max_tokens, temperature }.
 */
import {
  SEGMENT_MAX_TOKENS,
  QUALITY_LADDER_EXACT_SENTENCE_CAP,
  QUALITY_LADDER_REPAIR,
  MODEL_TIER
} from "./debate-config.js";

/** Map segment to stage key. */
function getStageKey(segment) {
  const roleType = segment?.roleType || "debater";
  const sub = segment?.roleSubType || "";
  if (roleType === "chair") return "chair_procedural";
  if (sub === "interjection") return "interjection";
  if (sub === "pro_statement" || sub === "con_statement") return "opening_statement";
  if (sub === "pro_rebuttal" || sub === "con_rebuttal") return "rebuttal";
  if (sub === "pro_summary" || sub === "con_summary") return "closing";
  return "rebuttal";
}

/** Strictness 0–10: +3 exact_sentence, +2 must_hook, +2 banlist>=20, +2 context=long, +1 quality_mode=final. */
function computeStrictness(segment, context, opts = {}) {
  let s = 0;
  if (opts.exact_sentence_count) s += 3;
  if (opts.must_hook) s += 2;
  if ((opts.banlist_size || 0) >= 20) s += 2;
  if (opts.context_length === "long") s += 2;
  if (opts.quality_mode === "final") s += 1;
  return Math.min(10, s);
}

/**
 * Three-tier model + budget selection. Rules:
 * - conclusion / judge_verdict → expensive
 * - strictness >= 8 → expensive
 * - strictness 5–7 → mid
 * - strictness <=4: short segment (transition/definition/chair_procedural) → cheap; else → mid
 * max_tokens: per SEGMENT_MAX_TOKENS; exact_sentence_count caps to 220.
 * temperature: exact_sentence or banlist>=20 → 0.40; mid 0.55, opus 0.50, cheap 0.60; repair 0.25–0.35.
 */
export function selectModelAndBudget(segment, context = {}, models = {}) {
  const cheap = (models.cheap || MODEL_TIER.cheap).trim();
  const mid = (models.mid || MODEL_TIER.mid).trim();
  const expensive = (models.expensive || MODEL_TIER.expensive).trim();

  const stage = getStageKey(segment);
  const sub = segment?.roleSubType || "";
  const quality_mode = context.streamMode ? "show" : (context.detailMode ? "final" : "draft");
  const exact_sentence_count = sub === "interjection" || sub === "closingChair";
  const must_hook = /rebuttal|summary|statement/.test(sub);
  const banlist_size = typeof context.banlist_size === "number" ? context.banlist_size : 0;
  const contextLen = (context.recentTurns && context.recentTurns.length) || 0;
  const context_length = contextLen > 12 ? "long" : contextLen > 6 ? "medium" : "short";

  const opts = {
    exact_sentence_count,
    must_hook,
    banlist_size,
    context_length,
    quality_mode
  };
  const strictness = computeStrictness(segment, context, opts);

  let model = mid;
  if (sub === "judge_verdict" || stage === "closing" || sub === "closingChair") {
    model = expensive;
  } else if (strictness >= 8) {
    model = expensive;
  } else if (strictness >= 5 && strictness <= 7) {
    model = mid;
  } else if (strictness <= 4) {
    if (stage === "transition" || stage === "definition_request" || stage === "chair_procedural") {
      model = cheap;
    } else {
      model = mid;
    }
  }

  let max_tokens = SEGMENT_MAX_TOKENS[stage] ?? SEGMENT_MAX_TOKENS.rebuttal;
  if (exact_sentence_count) max_tokens = Math.min(max_tokens, QUALITY_LADDER_EXACT_SENTENCE_CAP);

  let temperature = 0.55;
  if (exact_sentence_count || banlist_size >= 20) temperature = 0.4;
  else if (model === expensive) temperature = 0.5;
  else if (model === mid) temperature = 0.55;
  else temperature = 0.6;

  return { model, max_tokens, temperature, strictness, stage };
}

/** Backward compat: segmentBudget for callers that only need max_tokens + temperature. */
export function segmentBudget(stage, strictness = 0, quality_mode = "show", opts = {}) {
  let max_tokens = SEGMENT_MAX_TOKENS[stage] ?? SEGMENT_MAX_TOKENS.rebuttal;
  if (opts.exact_sentence_count) max_tokens = Math.min(max_tokens, QUALITY_LADDER_EXACT_SENTENCE_CAP);
  let temperature = 0.55;
  if (opts.exact_sentence_count || (opts.banlist_size >= 20)) temperature = 0.4;
  else if (strictness >= 8) temperature = 0.5;
  return { max_tokens, temperature };
}

/**
 * Build validator contract for this segment (for validateOutput).
 * Caller passes forbidden phrases, banned stems, speaker banlist from prompts.
 */
export function buildValidatorContract(segment, context = {}, options = {}) {
  const roleType = segment?.roleType || "debater";
  const sub = segment?.roleSubType || "";
  const exactSentences = sub === "interjection" || sub === "closingChair" ? 1 : (options.exactSentences ?? null);
  const minSentences = options.minSentences ?? (roleType === "chair" ? 1 : 1);
  const maxSentences = options.maxSentences ?? (roleType === "chair" ? 2 : 6);
  const maxQuestions = options.maxQuestions ?? 1;
  const mustHook = options.mustHook ?? /rebuttal|summary|statement/.test(sub);
  const opponentLine = (context.previousOpponentText || "").trim().slice(0, 600);
  return {
    exactSentences: exactSentences ?? undefined,
    minSentences: exactSentences == null ? minSentences : undefined,
    maxSentences: exactSentences == null ? maxSentences : exactSentences,
    maxQuestions,
    mustHook: mustHook && opponentLine.length > 0,
    opponentLine: opponentLine || undefined,
    forbiddenPhrases: options.forbiddenPhrases || [],
    bannedStems: options.bannedStems || [],
    bannedWordsSpeaker: options.bannedWordsSpeaker || [],
    englishOnly: true,
    noStageDirections: true
  };
}

/**
 * Build repair prompt: contract + opponent line + failure list. Model outputs only the fixed speech.
 */
export function buildRepairPrompt(contract, opponentLine, failures, currentText) {
  const failLines = failures.map((f) => `- ${f.rule}: ${f.detail || ""}`).join("\n");
  return `You are fixing a debate turn that failed validation. Output ONLY the corrected speech text. No explanation, no labels.

CONTRACT (must all be satisfied):
- Sentence count: ${contract.exactSentences != null ? `EXACTLY ${contract.exactSentences}` : `between ${contract.minSentences} and ${contract.maxSentences}`} sentence(s).
- At most ${contract.maxQuestions} question mark(s).
- First sentence must hook to the opponent's line (quote, paraphrase, or use a key word from it).
- Do not use any of the forbidden phrases or speaker-banned words already listed.
- English only. No stage directions or labels.

Opponent's last line (hook target):
"""
${(opponentLine || "").slice(0, 400)}
"""

FAILURES TO FIX:
${failLines}

Current (rejected) draft:
"""
${(currentText || "").slice(0, 800)}
"""

Output ONLY the repaired speech.`;
}

/** Repair pass params (4o-mini, low temp). */
export function getRepairParams() {
  return {
    max_tokens: QUALITY_LADDER_REPAIR.max_tokens,
    temperature: (QUALITY_LADDER_REPAIR.temperature_min + QUALITY_LADDER_REPAIR.temperature_max) / 2
  };
}

/** Start with expensive (Opus) without trying mid: conclusion, judge_verdict, or strictness>=8 only. */
export function shouldUpgradeImmediately(segment, context = {}, strictness = 0) {
  const sub = segment?.roleSubType || "";
  const stage = getStageKey(segment);
  if (stage === "closing" || sub === "closingChair" || sub === "judge_verdict") return true;
  if (strictness >= 8) return true;
  return false;
}

/** Get stage key from segment for segmentBudget. */
export function getStageKeyForSegment(segment) {
  return getStageKey(segment);
}
