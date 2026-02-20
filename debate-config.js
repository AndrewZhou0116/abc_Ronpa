/**
 * Tunable debate generation config.
 * - Turn length: default 1–2 sentences (micro-turns); per-speaker overrides.
 * - flowMode: "classic" (Pro1→Con1→Pro2→…) or "micro" (frequent Chair, rapid switch).
 * - heatLevel: "low" | "medium" | "high".
 * - logPromptForSpeakers: full user prompt printed for these (e.g. ["pro2", "con3"]).
 * - debugLogBeforeGeneration: log speakerId, side, background length, first 60 chars before each generation.
 * - Emojis: facial only, at most 1 at end of debater turn (optional); Chair: configurable (off for authority).
 */

/** Per-turn max_tokens (enough for dense 2–3 sentences + one logical step + character tics). */
export const TOKEN_BUDGETS = {
  chairMicro: 100,
  debaterMicro: 260,
  interjection: 60,
  detailTurn: 360,
  compressionPass: 140
};

/**
 * Three-tier model routing: cheap (4o-mini) / mid (Sonnet4) / expensive (Opus4).
 * Values can be overridden by .env: OPENROUTER_MODEL_CHEAP, OPENROUTER_MODEL_MID, OPENROUTER_MODEL_EXPENSIVE.
 */
export const MODEL_TIER = {
  cheap: "openai/gpt-4o-mini",
  mid: "anthropic/claude-sonnet-4",
  expensive: "anthropic/claude-opus-4"
};

/**
 * Fixed max_tokens by stage for selectModelAndBudget. exact_sentence_count caps to QUALITY_LADDER_EXACT_SENTENCE_CAP.
 */
export const SEGMENT_MAX_TOKENS = {
  transition: 120,
  definition_request: 120,
  chair_procedural: 120,
  interjection: 180,
  opening_statement: 260,
  rebuttal: 320,
  crossfire: 320,
  closing: 700,
  conclusion: 700,
  judge_verdict: 700
};

/** When exact_sentence_count=true, cap max_tokens to avoid run-on. */
export const QUALITY_LADDER_EXACT_SENTENCE_CAP = 220;

/** Repair pass: always use cheap model, low temp. */
export const QUALITY_LADDER_REPAIR = {
  max_tokens: 250,
  temperature_min: 0.25,
  temperature_max: 0.35
};

/** Optional: use a cheaper model for compression only. If unset, server OPENROUTER_MODEL is used. */
export const MODEL_CONFIG = {
  cheapModelForCompression: null
};

export const DEBATE_CONFIG = {
  minSentences: 1,
  maxSentences: 2,
  /** Per-speaker [min, max] sentences. Debaters: 1–3 default; 4–6 only in detailMode; interjection 1. */
  turnSentencesBySpeaker: {
    chair: [1, 2],
    pro1: [1, 3],
    pro2: [1, 3],
    pro3: [1, 3],
    con1: [1, 3],
    con2: [1, 3],
    con3: [1, 3]
  },
  /** "classic" = standard order with interjections; "micro" = fixed 14-turn order (no Chair between each). */
  flowMode: "micro",
  /** If true, middle segments are shuffled (no same speaker twice in a row). If false, use the defined order. */
  shuffleSegmentOrder: false,
  heatLevel: "high",
  strictness: "hard",
  /** Set to e.g. ["pro2", "con3"] to log full user prompt for those speakers. */
  logPromptForSpeakers: [],
  debugLogBeforeGeneration: false,
  logTokenBudget: false,
  sanitizeOutputForbidden: true,
  allowFacialEmoji: true,
  maxFacialPerTurn: 1,
  chairEmojis: false,
  enableSideFlipDetector: true,
  /** If true, 2-step generate: draft then compress to 1–2 sentences (extra API call). */
  useCompressStep: true,
  /** Quality Ladder: default 4o-mini, validate, repair once, then upgrade to Opus only if needed. When true, useQualityLadder overrides budget router for segment generation. */
  useQualityLadder: true
};
