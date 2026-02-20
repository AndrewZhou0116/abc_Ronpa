/**
 * Three-part prompt for Quality Ladder: Persona (short) + Segment Contract (hard rules) + Context (minimal).
 * Cross-turn constraints (e.g. angle rotation) are enforced by code state; we inject ANGLE_THIS_TURN only.
 */
import { SPEAKER_BACKGROUNDS } from "./character-backgrounds.js";
import { FORBIDDEN_PHRASES, ANTI_HOMOGENIZATION_BANLIST, VOICEPRINT_CHECKLIST } from "./prompts.js";

const PERSONA_MAX_CHARS = 1200;

/** Short persona card: voice + values + habits. Target ~150–250 tokens. */
function buildPersonaCard(speakerId, segment) {
  const raw = SPEAKER_BACKGROUNDS[speakerId];
  if (!raw) return "Stay in character. Natural debate tone.";
  const text = String(raw).trim();
  const short = text.length <= PERSONA_MAX_CHARS ? text : text.slice(0, PERSONA_MAX_CHARS) + "\n[...]";
  return short + "\n\nOutput: English only. No narration, no stage directions.";
}

/**
 * Segment contract: hard constraints only. Short checklist.
 * Quality hooks (concrete handle, specific cut) are 2 short lines.
 */
function buildSegmentContract(segment, context, options = {}) {
  const sub = segment?.roleSubType || "";
  const isChair = segment?.roleType === "chair";
  const exactN = sub === "interjection" || sub === "closingChair" ? 1 : (isChair ? null : null);
  const sentenceRule = exactN != null ? `EXACTLY ${exactN} sentence(s).` : "1–3 sentences (interjection: 1).";
  const angleLine = context.angle_this_turn
    ? `This turn use one concrete angle: ${context.angle_this_turn}.`
    : "Use one concrete handle (definition / baseline / test / liability / cost).";
  return `CONTRACT (all required):
- ${sentenceRule}
- At most 1 question mark.
- Hook: first sentence must name/quote/paraphrase one specific claim from the opponent's last line.
- ${angleLine}
- Make one specific cut on opponent's line (not generic).
- No forbidden phrases. No speaker-banned words. No labels or stage directions.`;
}

/** Context: motion + opponent last (required) + same-side last (optional) + 1–2 main points (optional). */
function buildContextBlock(topic, context) {
  const motion = (topic || "").slice(0, 300);
  const opponent = (context.previousOpponentText || "").trim().slice(0, 500);
  const sameSide = context.sameSideTurns?.length
    ? (context.sameSideTurns[context.sameSideTurns.length - 1]?.text || "").trim().slice(0, 300)
    : "";
  let out = `MOTION: ${motion}\n\n`;
  out += `OPPONENT'S LAST LINE (you must hook to this):\n"""\n${opponent || "(none — open with your point)"}\n"""\n\n`;
  if (sameSide) out += `YOUR SIDE'S LAST POINT (do not contradict):\n"""\n${sameSide}\n"""\n\n`;
  return out;
}

/** Chair-specific contract and context (minimal). */
function buildChairContractAndContext(topic, segment, context) {
  const sub = segment?.roleSubType || "";
  let contract = "CONTRACT: ";
  if (sub === "openingChair") contract += "State motion briefly, hand to first speaker. 1–2 sentences. Do NOT ask for definition.";
  else if (sub === "transition") contract += "Thank previous, invite next. Optional: quote 6–12 words. 1–2 sentences.";
  else if (sub === "reprimand") contract += "One short line (e.g. Order. Let the speaker finish.). Under 15 words.";
  else if (sub === "closingChair") contract += "EXACTLY one closing line. E.g. 'This round is closed.' No motion, no definition.";
  else contract += "1–2 sentences. Procedural only.";
  contract += " No stage directions. English only.";
  const opponent = (context.previousOpponentText || "").trim().slice(0, 400);
  return {
    contract,
    context: `MOTION: ${(topic || "").slice(0, 300)}\n\nLAST SPEAKER:\n"""\n${opponent || "(none)"}\n"""\n\nOutput ONLY the chair line.`
  };
}

/**
 * Build three-part prompt for Quality Ladder.
 * @param {string} topic
 * @param {{ speakerId: string, roleType: string, roleSubType: string, label?: string }} segment
 * @param {{ previousOpponentText?: string, sameSideTurns?: Array<{ text: string }>, angle_this_turn?: string, recentTurns?: Array }} context
 * @param {{ sentenceBudget?: [number, number], bannedWordsSpeaker?: string[] }} [options]
 * @returns {{ system: string, user: string }}
 */
export function buildLadderPrompt(topic, segment, context = {}, options = {}) {
  const isChair = segment?.roleType === "chair";
  const persona = buildPersonaCard(segment.speakerId, segment);
  const bannedWords = options.bannedWordsSpeaker ?? (segment.speakerId && ANTI_HOMOGENIZATION_BANLIST[segment.speakerId]) ?? [];
  const bannedLine = Array.isArray(bannedWords) && bannedWords.length > 0
    ? "BANNED WORDS (do not use): " + bannedWords.map((w) => `"${w}"`).join(", ")
    : "BANNED WORDS: none";

  if (isChair) {
    const { contract, context: ctx } = buildChairContractAndContext(topic, segment, context);
    return {
      system: persona + "\n\n" + bannedLine,
      user: contract + "\n\n" + ctx
    };
  }

  const contract = buildSegmentContract(segment, context, options);
  const contextBlock = buildContextBlock(topic, context);
  const voiceprint = VOICEPRINT_CHECKLIST[segment.speakerId];
  const voiceLine = voiceprint && typeof voiceprint.summary === "string" ? `Voice: ${voiceprint.summary}` : "";

  const user = contract + "\n\n" + bannedLine + (voiceLine ? "\n" + voiceLine : "") + "\n\n" + contextBlock + "\nOutput ONLY the speech text.";
  const system = persona + "\n\nOptional: if a concept or work would sharpen your point, you may name it in passing; never cite for the sake of it.";
  return { system, user };
}

export { buildPersonaCard, buildSegmentContract, buildContextBlock };
