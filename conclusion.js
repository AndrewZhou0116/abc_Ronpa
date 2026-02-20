/**
 * Conclusion: single-call, high-quality report.
 * Output: systematic analysis, concise argument map, literature with links, media (books/films/music/games).
 */

const CONCLUSION_SYSTEM = `You are a debate analyst. Output a single JSON report. Be very concise for speed.
1. Definitions + argument map (short nodes).
2. Core clashes, assumptions, steelman (1–2 items each).
3. Verdict (winner + 1–2 reasoning lines).
4. Literature: 0–2 items with url if possible. Media: 0–1 item. Omit if none fit.
Output ONLY valid JSON. No markdown, no commentary.`;

const SCHEMA_DESC = `JSON schema (output this structure; 1–2 items per section for speed):
{
  "title": "string",
  "topic": "string",
  "sections": [
    { "id": "definitions", "heading": "Motion & Definitions", "items": [ { "text": "string", "turnRefs": [number] } ] },
    { "id": "argument_map", "heading": "Argument Map", "items": [ { "node": "string", "side": "Affirmative|Negative", "supports": ["string"], "attacks": ["string"], "turnRefs": [number] } ] },
    { "id": "core_clashes", "heading": "Core Clashes", "items": [ { "clash": "string", "aff": "string", "neg": "string", "turnRefs": [number] } ] },
    { "id": "assumptions", "heading": "Hidden Assumptions", "items": [ { "who": "string", "text": "string", "turnRefs": [number] } ] },
    { "id": "steelman", "heading": "Steelman & Best Reply", "items": [ { "targetSide": "string", "steelman": "string", "bestReply": "string", "turnRefs": [number] } ] },
    { "id": "novel_angles", "heading": "New Angles", "items": [ { "angle": "string", "whyItMatters": "string" } ] },
    { "id": "empirical", "heading": "Empirical Checks", "items": [ { "question": "string", "whatWouldChangeYourMind": "string" } ] },
    { "id": "verdict", "heading": "Verdict", "items": [ { "winner": "Affirmative|Negative|Tie", "reasoning": ["string"], "keyTurnRefs": [number] } ] },
    { "id": "literature", "heading": "Related Literature", "items": [ { "title": "string", "authors": ["string"], "year": number|null, "url": "string", "relevance": "string" } ] },
    { "id": "media", "heading": "Further Thinking", "items": [ { "kind": "string", "title": "string", "creator": "string", "year": number|null, "whyRelevant": "string", "spoilerFree": true|false } ] }
  ]
}
Rules: Max 2 items per section. argument_map: 2–3 nodes. literature: 0–2, media: 0–1. turnRefs optional.`;

/** Build user prompt: topic + transcript (trimmed for speed; smaller = faster API response). */
const CONCLUSION_MAX_TURNS_IN_PROMPT = 15;
const CONCLUSION_CHARS_PER_TURN = 200;

function buildConclusionPrompt(topic, turns) {
  const trimmed = turns.length > CONCLUSION_MAX_TURNS_IN_PROMPT
    ? turns.slice(-CONCLUSION_MAX_TURNS_IN_PROMPT)
    : turns;
  const turnsText =
    trimmed.length === 0
      ? "(No transcript. Analyze motion only: definitions, argument map, verdict.)"
      : trimmed
          .map(
            (t, i) =>
              `[${t.turnIndex != null ? t.turnIndex : i + 1}] ${(t.speakerLabel || "").slice(0, 20)} (${(t.side || "").slice(0, 8)}): ${(t.text || "").slice(0, CONCLUSION_CHARS_PER_TURN)}`
          )
          .join("\n");

  return `Motion: ${topic.slice(0, 300)}

Transcript:
${turnsText}

Output the conclusion JSON per schema. Be concise.`;
}

/** Normalize and fill sections so frontend always has a consistent shape. */
const SECTION_IDS = [
  "definitions",
  "argument_map",
  "core_clashes",
  "assumptions",
  "steelman",
  "novel_angles",
  "empirical",
  "verdict",
  "literature",
  "media"
];

function normalizeConclusion(json, topic) {
  const sections = Array.isArray(json.sections) ? json.sections : [];
  const byId = new Map(sections.map((s) => [s.id, s]));

  const outSections = SECTION_IDS.map((id) => {
    const sec = byId.get(id);
    const heading =
      sec?.heading ||
      id
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      id,
      heading,
      items: Array.isArray(sec?.items) ? sec.items : []
    };
  });

  return {
    title: typeof json.title === "string" ? json.title : "Conclusion",
    topic: typeof json.topic === "string" ? json.topic : topic,
    meta: json.meta || {},
    sections: outSections
  };
}

/**
 * Generate conclusion with one LLM call. Uses high token count for quality.
 * @param {{ topic: string, turns: Array, fetchOpenRouter: (body)=>Promise<{ok, data?, message?}>, model?: string }} opts
 * @returns {Promise<{ title, topic, meta, sections }>}
 */
export async function generateConclusion({ topic, turns, fetchOpenRouter, model }) {
  const generatedAt = new Date().toISOString();
  const user = buildConclusionPrompt(topic, turns);

  const res = await fetchOpenRouter({
    max_tokens: 1000,
    messages: [
      { role: "system", content: CONCLUSION_SYSTEM + "\n\n" + SCHEMA_DESC },
      { role: "user", content: user }
    ]
  });

  if (!res.ok) {
    throw new Error(res.message || "Conclusion generation failed");
  }

  const raw =
    (res.data?.choices?.[0]?.message?.content || "")
      .trim()
      .replace(/^```\w*\n?|\n?```$/g, "") || "{}";

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("Conclusion response was not valid JSON");
  }

  const out = normalizeConclusion(parsed, topic);
  out.meta = {
    ...out.meta,
    model: res.modelUsed || model || "unknown",
    generatedAt,
    transcriptTurnCount: turns.length
  };
  return out;
}
