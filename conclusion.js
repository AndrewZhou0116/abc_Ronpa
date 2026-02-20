/**
 * Topic Analysis (API/file name kept as "conclusion" for compatibility).
 * Topic-only deep analysis — no transcript; one LLM call: definitions, argument map, literature with links, media (books/films/music/games).
 * Optimized for speed: single request, concise but substantive; use a good model for quality.
 */

const CONCLUSION_SYSTEM = `You are a debate and policy analyst. Given ONLY a motion (debate topic), produce a comprehensive, standalone analysis. Do NOT use or reference any transcript or prior dialogue. Analyze the motion itself: definitions, conceptual argument map, key clashes, assumptions, steelman, novel angles, empirical questions, and your analytical verdict. Then cite related literature (with URLs when possible) and recommend media that deepen thinking: books, films, music, games (include any that genuinely fit). Be substantive and thought-provoking; keep structure clear.
CRITICAL: Your entire response must be exactly one valid JSON object. No text, no explanation, no markdown code fence (no \`\`\`), no text before or after the JSON. Output only the raw JSON.`;

const SCHEMA_DESC = `Output this JSON structure (all fields as specified; omit optional fields if empty):
{
  "title": "string (short, analytic title for the motion)",
  "topic": "string (echo the motion)",
  "sections": [
    { "id": "definitions", "heading": "Motion & Definitions", "items": [ { "text": "string" } ] },
    { "id": "argument_map", "heading": "Argument Map", "items": [ { "node": "string", "side": "Affirmative|Negative", "supports": ["string"], "attacks": ["string"] } ] },
    { "id": "core_clashes", "heading": "Core Clashes", "items": [ { "clash": "string", "aff": "string", "neg": "string" } ] },
    { "id": "assumptions", "heading": "Hidden Assumptions", "items": [ { "who": "string", "text": "string" } ] },
    { "id": "steelman", "heading": "Steelman & Best Reply", "items": [ { "targetSide": "string", "steelman": "string", "bestReply": "string" } ] },
    { "id": "novel_angles", "heading": "Novel Angles", "items": [ { "angle": "string", "whyItMatters": "string" } ] },
    { "id": "empirical", "heading": "Empirical Checks", "items": [ { "question": "string", "whatWouldChangeYourMind": "string" } ] },
    { "id": "verdict", "heading": "Analytical Verdict", "items": [ { "winner": "Affirmative|Negative|Tie", "reasoning": ["string"] } ] },
    { "id": "literature", "heading": "Related Literature", "items": [ { "title": "string", "authors": ["string"], "year": number|null, "url": "string", "relevance": "string" } ] },
    { "id": "media", "heading": "Further Thinking", "items": [ { "kind": "Book|Film|Music|Game", "title": "string", "creator": "string", "year": number|null, "url": "string", "whyRelevant": "string", "spoilerFree": true|false } ] }
  ]
}
Rules: argument_map 2–4 nodes, concise. literature: 1–3 items with url when possible. media: 1–4 items across books, films, music, games as relevant. Your reply must be exactly one JSON object and nothing else.`;

function buildConclusionPrompt(topic) {
  const t = (topic || "").trim().slice(0, 500);
  return `Motion to analyze (standalone; no transcript):

"${t}"

Produce the conclusion JSON per schema. Be comprehensive but concise. Literature and media: include real titles with URLs where possible.`;
}

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
      id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      id,
      heading,
      items: Array.isArray(sec?.items) ? sec.items : []
    };
  });

  return {
    title: typeof json.title === "string" ? json.title : "Topic Analysis",
    topic: typeof json.topic === "string" ? json.topic : topic,
    meta: json.meta || {},
    sections: outSections
  };
}

/**
 * Generate topic-only conclusion. Turns are ignored (analysis is standalone).
 * @param {{ topic: string, turns?: Array, fetchOpenRouter: (body)=>Promise<{ok, data?, message?}>, model?: string }} opts
 * @returns {Promise<{ title, topic, meta, sections }>}
 */
export async function generateConclusion({ topic, fetchOpenRouter, model }) {
  const generatedAt = new Date().toISOString();
  const user = buildConclusionPrompt(topic);

  const res = await fetchOpenRouter({
    max_tokens: 2000,
    messages: [
      { role: "system", content: CONCLUSION_SYSTEM + "\n\n" + SCHEMA_DESC },
      { role: "user", content: user }
    ]
  });

  if (!res.ok) {
    throw new Error(res.message || "Conclusion generation failed");
  }

  let raw = (res.data?.choices?.[0]?.message?.content || "").trim();
  if (!raw) raw = "{}";

  /** Strip markdown code fences (e.g. ```json ... ``` or ``` ... ```) and leading/trailing text. */
  raw = raw
    .replace(/^```(?:json|JSON)?\s*\n?/i, "")
    .replace(/\n?```\s*$/g, "")
    .trim();
  const beforeFirstBrace = raw.indexOf("{");
  if (beforeFirstBrace > 0) raw = raw.slice(beforeFirstBrace);
  const lastBrace = raw.lastIndexOf("}");
  if (lastBrace !== -1 && lastBrace < raw.length - 1) raw = raw.slice(0, lastBrace + 1);

  /** Try to parse JSON; if the model wrapped it in text, find the first balanced { ... } object. */
  function extractJson(str) {
    const s = str.trim();
    try {
      return JSON.parse(s);
    } catch (_) {}
    const start = s.indexOf("{");
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (c === "\\") escape = true;
        else if (c === inString) inString = false;
        continue;
      }
      if (c === '"' || c === "'") {
        inString = c;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return null;
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch (_) {
      return null;
    }
  }

  let parsed = extractJson(raw);
  if (parsed == null && raw.length > 0) {
    const fixTrailingComma = raw.replace(/,(\s*[}\]])/g, "$1");
    try {
      parsed = JSON.parse(fixTrailingComma);
    } catch (_) {}
  }
  if (parsed == null) {
    throw new Error("Conclusion response was not valid JSON");
  }

  const out = normalizeConclusion(parsed, topic);
  out.meta = {
    ...out.meta,
    model: res.modelUsed || model || "unknown",
    generatedAt
  };
  return out;
}
