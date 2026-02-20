/**
 * Debate stage UI: DOM refs, assets (chroma key), stage (stand/sit), transcript, TTS, SSE stream, start/stop.
 */
(() => {
  const API_BASE = (window.__API_BASE__ ?? "").replace(/\/$/, "");

  const topicInput = document.getElementById("topicInput");
  const startBtn = document.getElementById("startBtn");
  const stopBtn = document.getElementById("stopBtn");
  const transcriptEl = document.getElementById("transcript");
  const currentSpeechBar = document.getElementById("currentSpeechBar");
  const currentSpeechSpeaker = document.getElementById("currentSpeechSpeaker");
  const currentSpeechText = document.getElementById("currentSpeechText");
  const yourTurnPopup = document.getElementById("yourTurnPopup");
  const yourTurnTextInput = document.getElementById("yourTurnTextInput");
  const yourTurnTranscript = document.getElementById("yourTurnTranscript");
  const voiceInputBtn = document.getElementById("voiceInputBtn");
  const endSpeakBtn = document.getElementById("endSpeakBtn");
  const stageContainer = document.getElementById("stageContainer");

  let currentStreamId = null;
  let currentYourTurnSegmentId = null;
  let userSpeechTranscript = "";
  let recognition = null;
  let isRecording = false;
  let currentSegmentId = null;
  let currentSpeakerId = null;
  let currentSpeakerSide = null;

  const characterIds = ["chair", "pro1", "pro2", "pro3", "con1", "con2", "con3"];

  /** Speaker display names for transcript and current-speech bar (name only; role shown separately). */
  const SPEAKER_DISPLAY_NAMES = {
    chair: "Makima",
    pro1: "Donald Trump",
    pro2: "Light Yagami",
    pro3: "Immanuel Kant",
    con1: "Gus Fring",
    con2: "Albert Camus",
    con3: "Isaac Newton"
  };
  function getDisplayName(speakerId, fallbackLabel) {
    return (speakerId && SPEAKER_DISPLAY_NAMES[speakerId]) || fallbackLabel || "Speaker";
  }

  const STAND_DELTA = 70;

  const bannedClientPatterns = [
    /as an\s+ai[^.!?]*[.!?]?/gi,
    /as a language model[^.!?]*[.!?]?/gi,
    /i am just an ai[^.!?]*[.!?]?/gi,
    /this is a simulation[^.!?]*[.!?]?/gi,
    /simulated (dialogue|conversation)[^.!?]*[.!?]?/gi,
    /as an artificial intelligence[^.!?]*[.!?]?/gi,
    /i (cannot|can't) (do|provide)[^.!?]*[.!?]?/gi
  ];

  function sanitizeClientText(text) {
    if (!text) return "";
    let t = text;
    for (const pattern of bannedClientPatterns) {
      t = t.replace(pattern, "");
    }
    return t;
  }

  function stripEmojiForSpeech(str) {
    if (!str) return "";
    return str.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}\u{1F1E0}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}]/gu, "").replace(/\s+/g, " ").trim();
  }

  let eventSource = null;
  let speakQueue = [];
  let isSpeaking = false;
  let typewriterTimeouts = [];
  let typewriterAborted = false;
  let ttsMode = "browser";
  /** Transcript turns (for segment indexing only). Topic Analysis is topic-only and does not use this. */
  let transcriptTurns = [];

  // ─── TTS config: voice mode, speech rate, interrupt behavior, debug ─────────
  const TTS_CONFIG = (typeof window !== "undefined" && window.DEBATE_TTS_CONFIG) || {
    voiceMode: true,           // true = TTS queue, guaranteed playback; false = transcript only, fastest
    speechRateWPM: 150,       // words per minute for duration estimation
    postEndDelayMs: 80,       // delay after utterance.onend before starting next (lets browser settle)
    interruptBehavior: "queue", // "queue" = never cancel on new turn; only cancel in stopAllSpeech
    ttsDebug: false           // set true or window.DEBATE_TTS_DEBUG to log enqueue, start, end, cancel
  };
  function getVoiceMode() {
    const cb = document.getElementById("voiceModeCheckbox");
    if (!cb) return true;
    return cb.checked;
  }
  function estimateSpeechDurationMs(text, rate) {
    const words = (text || "").trim().split(/\s+/).filter(Boolean).length || 1;
    const wpm = TTS_CONFIG.speechRateWPM * (rate || 1);
    return Math.round((words / wpm) * 60 * 1000);
  }
  function ttsLog(msg, data = {}) {
    if (!TTS_CONFIG.ttsDebug && !(typeof window !== "undefined" && window.DEBATE_TTS_DEBUG)) return;
    const parts = ["[TTS]", msg];
    if (data.queueLength !== undefined) parts.push("queueLength=" + data.queueLength);
    if (data.speakerId !== undefined) parts.push("speakerId=" + data.speakerId);
    if (data.estimatedMs !== undefined) parts.push("estimatedMs=" + data.estimatedMs);
    if (data.textLen !== undefined) parts.push("textLen=" + data.textLen);
    if (data.error !== undefined) parts.push("error=" + data.error);
    console.log(parts.join(" "));
  }

  let voicesCache = [];
  function initVoices() {
    if (!("speechSynthesis" in window)) return;
    voicesCache = window.speechSynthesis.getVoices();
    const en = voicesCache.filter((v) => (v.lang || "").replace(/_/g, "-").toLowerCase().startsWith("en"));
    if (TTS_CONFIG.ttsDebug) {
      console.log("[TTS] initVoices: total=" + voicesCache.length + " en=" + en.length);
      if (voicesCache.length === 0) console.warn("[TTS] initVoices: no voices yet, will use default");
    }
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = () => {
        initVoices();
      };
    }
  }
  function getPreferredEnglishVoice() {
    const list = voicesCache.length ? voicesCache : (window.speechSynthesis && window.speechSynthesis.getVoices()) || [];
    const en = list.filter((v) => (v.lang || "").replace(/_/g, "-").toLowerCase().startsWith("en"));
    return en[0] || list[0] || null;
  }

  function resetCharacters() {
    characterIds.forEach((id) => {
      const el = document.getElementById(id);
      if (!el || !baseTransforms[id]) return;
      el.setAttribute("transform", baseTransforms[id]);
    });
  }

  const baseTransforms = {};
  function captureBaseTransforms() {
    characterIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) baseTransforms[id] = el.getAttribute("transform") || "";
    });
  }

  function removeChromaGreen(img) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, w, h);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const isGreen = g > 100 && g > r && g > b && (g - r) + (g - b) > 60;
      if (isGreen) d[i + 3] = 0;
    }
    ctx.putImageData(data, 0, 0);
    try { return canvas.toDataURL("image/png"); } catch (e) { return null; }
  }

  function loadImageChromaKey(src, onOk, onFail) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function () {
      const dataUrl = removeChromaGreen(img);
      if (dataUrl) onOk(dataUrl); else if (onFail) onFail();
    };
    img.onerror = function () { if (onFail) onFail(); };
    img.src = src.startsWith("http") ? src : new URL(src, window.location.href).href;
  }

  function applyTableBackgroundRemoval() {
    const tables = [
      { id: "tableAffirmative", src: "assets/table-affirmative.png" },
      { id: "tableJudge", src: "assets/table-judge.png" },
      { id: "tableNegative", src: "assets/table-negative.png" }
    ];
    tables.forEach(({ id, src }) => {
      const el = document.getElementById(id);
      if (!el) return;
      loadImageChromaKey(src, (dataUrl) => el.setAttribute("href", dataUrl), () => {
        el.setAttribute("href", src);
      });
    });
  }

  function initAssets() {
    applyTableBackgroundRemoval();
    const chairEl = document.getElementById("chairImage");
    if (chairEl) {
      loadImageChromaKey("assets/makima.png", (dataUrl) => chairEl.setAttribute("href", dataUrl), () => {
        chairEl.setAttribute("href", "assets/sketch/judge.svg");
      });
    }
    const debaterSlots = [
      { id: "pro1", src: "assets/debater_pro1.png", fallback: "assets/sketch/pro1.svg" },
      { id: "pro2", src: "assets/debater_pro2.png", fallback: "assets/sketch/pro2.svg" },
      { id: "pro3", src: "assets/debater_pro3.png", fallback: "assets/sketch/pro3.svg" },
      { id: "con1", src: "assets/debater_con1.png", fallback: "assets/sketch/con1.svg" },
      { id: "con2", src: "assets/debater_con2.png", fallback: "assets/sketch/con2.svg" },
      { id: "con3", src: "assets/debater_con3.png", fallback: "assets/sketch/con3.svg" }
    ];
    debaterSlots.forEach(({ id, src, fallback }) => {
      const el = document.getElementById(id + "Image");
      if (!el) return;
      loadImageChromaKey(src, (dataUrl) => el.setAttribute("href", dataUrl), () => {
        el.setAttribute("href", fallback);
      });
    });
  }

  recognition = initSpeechRecognition();

  voiceInputBtn.addEventListener("click", () => {
    if (!recognition) return;
    if (isRecording) {
      try { recognition.stop(); } catch (e) {}
      return;
    }
    userSpeechTranscript = "";
    if (yourTurnTranscript) yourTurnTranscript.textContent = "(listening...)";
    voiceInputBtn.classList.add("recording");
    voiceInputBtn.textContent = "Stop";
    isRecording = true;
    try { recognition.start(); } catch (e) {
      console.warn("Speech recognition start failed", e);
      isRecording = false;
      voiceInputBtn.classList.remove("recording");
      voiceInputBtn.textContent = "Voice";
    }
  });

  endSpeakBtn.addEventListener("click", () => {
    submitUserSpeech();
  });

  captureBaseTransforms();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAssets);
  } else {
    initAssets();
  }

  function standUp(id) {
    const el = document.getElementById(id);
    if (!el || !baseTransforms[id]) return;
    el.setAttribute("transform", baseTransforms[id] + " translate(0,-" + STAND_DELTA + ")");
  }

  function sitDown(id) {
    const el = document.getElementById(id);
    if (!el || !baseTransforms[id]) return;
    el.setAttribute("transform", baseTransforms[id]);
  }

  function sideFromSpeakerId(id) {
    const sid = (id != null && typeof id === "string") ? id.toLowerCase() : "";
    if (sid.startsWith("pro")) return "pro";
    if (sid.startsWith("con")) return "con";
    return "chair";
  }

  function clearCurrentSpeakerHighlight() {
    transcriptEl.querySelectorAll(".transcript-entry--current").forEach((el) => el.classList.remove("transcript-entry--current"));
  }

  /** @param {string} displayName - Full name + label e.g. "Makima (Chair)"
   *  @param {string} [speakerId] - e.g. "chair", "pro1", "con2"
   *  @param {boolean} [isCurrent] - whether this entry is the active speaker (highlight)
   *  @param {string} [entryType] - "speech" | "objection" | "ruling"
   *  @param {object} [meta] - objectionType, raisedBy, ruling, reason, etc. */
  function createTranscriptLine(displayName, roleType, side, speakerId, isCurrent, entryType, meta) {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    if (isCurrent) div.classList.add("transcript-entry--current");
    const type = entryType || "speech";
    if (type !== "speech") div.classList.add("transcript-entry--" + type);
    const segmentIndex = transcriptTurns.length;
    div.setAttribute("data-segment-index", String(segmentIndex));

    const header = document.createElement("div");
    header.className = "transcript-entry__header";

    const nameSpan = document.createElement("span");
    nameSpan.className = "transcript-entry__name";
    nameSpan.textContent = displayName;

    const roleTag = document.createElement("span");
    roleTag.className = "transcript-entry__role-tag";
    roleTag.textContent = speakerId === "chair" ? "" : (speakerId ? speakerId.toUpperCase().replace(/(\d)$/, " $1") : "");

    const sideBadge = document.createElement("span");
    sideBadge.className = "transcript-entry__side-badge";
    if (side === "pro") {
      sideBadge.classList.add("side-affirmative");
      sideBadge.textContent = "Affirmative";
    } else if (side === "con") {
      sideBadge.classList.add("side-negative");
      sideBadge.textContent = "Negative";
    } else {
      sideBadge.classList.add("side-judge");
      sideBadge.textContent = "Judge";
    }

    header.appendChild(nameSpan);
    header.appendChild(roleTag);
    header.appendChild(sideBadge);
    if (type === "objection" && meta && meta.objectionType) {
      const badge = document.createElement("span");
      badge.className = "transcript-entry__type-badge transcript-entry__type-badge--objection";
      badge.textContent = "Objection (" + (meta.objectionType || "").replace(/^./, (c) => c.toUpperCase()) + ")";
      header.appendChild(badge);
    }
    if (type === "ruling" && meta && meta.ruling) {
      const badge = document.createElement("span");
      badge.className = "transcript-entry__type-badge transcript-entry__type-badge--ruling " + (meta.ruling === "SUSTAINED" ? "sustained" : "overruled");
      badge.textContent = meta.ruling === "SUSTAINED" ? "Sustained" : "Overruled";
      header.appendChild(badge);
    }
    if (type === "speech" && meta && meta.isCorrection) {
      const badge = document.createElement("span");
      badge.className = "transcript-entry__type-badge transcript-entry__type-badge--correction";
      badge.textContent = "Correction";
      header.appendChild(badge);
    }
    if (type === "speech" && meta && meta.isClarification) {
      const badge = document.createElement("span");
      badge.className = "transcript-entry__type-badge transcript-entry__type-badge--clarification";
      badge.textContent = "Clarification";
      header.appendChild(badge);
    }
    div.appendChild(header);

    const textSpan = document.createElement("span");
    textSpan.className = "transcript-entry__text";
    div.appendChild(textSpan);

    transcriptEl.appendChild(div);
    if (isTranscriptNearBottom()) scrollTranscriptToLatest("auto");
    updateJumpToLatestVisibility();
    return textSpan;
  }

  /** Preferred voice name substrings per character (browser TTS). Match is case-insensitive.
   *  Pro1=Trump: deeper/raspy; Pro2=Light: younger male; Pro3=Kant: mature; Con1=Gus: cold; Con2=Camus: thoughtful; Con3=Newton: precise. */
  const SPEAKER_VOICE_PREFERENCES = (typeof window !== "undefined" && window.DEBATE_SPEAKER_VOICE_PREFERENCES) || {
    chair: ["zira", "samantha", "victoria", "susan", "female", "anna", "melina"],
    pro1: ["david", "mark", "male"],           // Trump-style: deeper, assertive
    pro2: ["daniel", "james", "male"],        // Light: younger, calmer
    pro3: ["george", "male"],                 // Kant: mature, measured
    con1: ["david", "mark", "male"],          // Gus: cold, authoritative
    con2: ["daniel", "james", "male"],        // Camus: reflective
    con3: ["george", "male"]                  // Newton: precise
  };

  const VOICE_MANAGER = (function () {
    let voices = [];
    const ADVANCED_KEYWORDS = ["neural", "natural", "online", "microsoft", "google", "premium", "enhanced"];
    const FEMALE_KEYWORDS = ["female", "zira", "samantha", "karen", "victoria", "susan", "anna", "melina"];
    const MALE_KEYWORDS = ["male", "david", "mark", "james", "daniel", "george"];

    function load() {
      voices = window.speechSynthesis.getVoices();
    }
    function isAdvanced(v) {
      const n = (v.name || "").toLowerCase();
      return ADVANCED_KEYWORDS.some((k) => n.includes(k));
    }
    function isFemale(v) {
      const n = (v.name || "").toLowerCase();
      return FEMALE_KEYWORDS.some((k) => n.includes(k));
    }
    function isMale(v) {
      const n = (v.name || "").toLowerCase();
      return MALE_KEYWORDS.some((k) => n.includes(k));
    }
    function enVoices() {
      return voices.filter((v) => (v.lang || "").replace(/_/g, "-").toLowerCase().startsWith("en"));
    }
    function voiceMatchesPreference(v, speakerId) {
      const prefs = SPEAKER_VOICE_PREFERENCES[speakerId];
      if (!prefs || !prefs.length) return false;
      const n = (v.name || "").toLowerCase();
      return prefs.some((key) => n.includes(String(key).toLowerCase()));
    }
    function pick(speakerId, roleType) {
      const anyEn = enVoices();
      const advanced = anyEn.filter(isAdvanced);
      const female = anyEn.filter(isFemale);
      const male = anyEn.filter(isMale);
      const other = anyEn.filter((v) => !isFemale(v) && !isMale(v));
      const pool = advanced.length ? advanced : anyEn;

      const roleParams = {
        chair: { rate: 1.12, pitch: 1.12, volume: 1, preferFemale: true },
        pro1: { rate: 1.22, pitch: 0.96, volume: 1 },
        pro2: { rate: 1.18, pitch: 1.02, volume: 1 },
        pro3: { rate: 1.14, pitch: 1.05, volume: 1 },
        con1: { rate: 1.2, pitch: 0.98, volume: 1 },
        con2: { rate: 1.16, pitch: 1.04, volume: 1 },
        con3: { rate: 1.18, pitch: 1.0, volume: 1 }
      };
      const params = roleParams[speakerId] || roleParams.pro1;

      let voice = null;
      const byPreference = anyEn.filter((v) => voiceMatchesPreference(v, speakerId));
      if (byPreference.length) {
        voice = (pool.filter((v) => voiceMatchesPreference(v, speakerId))[0]) || byPreference[0];
      }
      if (!voice) {
        if (roleType === "chair" && params.preferFemale) {
          voice = (pool.filter(isFemale)[0]) || (female[0]) || (other[0]) || (anyEn[0]);
        } else {
          const malePool = pool.filter(isMale).length ? pool.filter(isMale) : pool;
          const index = ["pro1", "con1", "pro2", "con2", "pro3", "con3"].indexOf(speakerId);
          voice = malePool[index % Math.max(1, malePool.length)] || other[index % Math.max(1, other.length)] || anyEn[0];
        }
      }
      return { voice: voice || null, rate: params.rate, pitch: params.pitch, volume: params.volume };
    }
    function debugLog() {
      load();
      const anyEn = enVoices();
      console.group("[VoiceManager] Available voices (en):");
      anyEn.forEach((v, i) => {
        console.log(i + 1, v.name, v.lang, isAdvanced(v) ? "[advanced]" : "");
      });
      console.groupEnd();
      const roles = ["chair", "pro1", "pro2", "pro3", "con1", "con2", "con3"];
      const assignment = roles.map((id) => {
        const { voice, rate, pitch, volume } = pick(id, id === "chair" ? "chair" : "debater");
        return { role: id, voice: voice ? voice.name : "(default)", rate, pitch, volume };
      });
      console.table(assignment);
    }
    if (typeof window !== "undefined" && window.speechSynthesis) {
      load();
      if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = () => { load(); };
      }
      if (typeof window !== "undefined" && window.DEBATE_TTS_DEBUG) setTimeout(debugLog, 500);
    }
    return { load, pick, debugLog, getVoices: () => voices };
  })();

  function unlockSpeechThenConnect(topic) {
    if (!("speechSynthesis" in window)) {
      connectStream(topic);
      return;
    }
    VOICE_MANAGER.load();
    if (window.speechSynthesis.paused) {
      try { window.speechSynthesis.resume(); } catch (e) {}
    }
    connectStream(topic);
    const u = new SpeechSynthesisUtterance("Starting.");
    u.lang = "en-US";
    u.volume = 0.01;
    u.rate = 1.5;
    try { window.speechSynthesis.speak(u); } catch (e) {}
  }

  const TRANSCRIPT_NEAR_BOTTOM_PX = 60;

  /** True when user has scrolled the transcript body so the bottom is in view (follow mode). */
  function isTranscriptNearBottom() {
    if (!transcriptEl) return true;
    const { scrollTop, scrollHeight, clientHeight } = transcriptEl;
    return scrollHeight - scrollTop - clientHeight <= TRANSCRIPT_NEAR_BOTTOM_PX;
  }

  /** Scroll transcript body to show the latest entry. */
  function scrollTranscriptToLatest(behavior) {
    if (!transcriptEl) return;
    if (behavior === "smooth") {
      transcriptEl.scrollTo({ top: transcriptEl.scrollHeight, behavior: "smooth" });
    } else {
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }
  }

  function runTypewriter(textSpan, text, durationMs, onDone, mirrorTextEl) {
    if (!text || typewriterAborted) {
      if (onDone) onDone();
      return;
    }
    const len = text.length;
    const interval = durationMs / len;
    let i = 0;
    function tick() {
      if (typewriterAborted) {
        if (onDone) onDone();
        return;
      }
      if (i < len) {
        i += 1;
        const slice = text.slice(0, i);
        textSpan.textContent = slice;
        if (mirrorTextEl) mirrorTextEl.textContent = slice;
        if (isTranscriptNearBottom()) scrollTranscriptToLatest("auto");
        const t = setTimeout(tick, interval);
        typewriterTimeouts.push(t);
      } else {
        if (onDone) onDone();
      }
    }
    const t = setTimeout(tick, interval);
    typewriterTimeouts.push(t);
  }

  function updateCurrentSpeechBar(speakerLabel, roleType, side, text) {
    if (!currentSpeechBar || !currentSpeechSpeaker || !currentSpeechText) return;
    currentSpeechBar.hidden = false;
    currentSpeechSpeaker.textContent = speakerLabel ? speakerLabel + ": " : "";
    currentSpeechSpeaker.className = "current-speech-speaker " + (roleType === "chair" ? "chair" : side === "pro" ? "pro" : side === "con" ? "con" : "");
    currentSpeechText.textContent = text || "";
  }

  function clearCurrentSpeechBar() {
    if (!currentSpeechBar || !currentSpeechSpeaker || !currentSpeechText) return;
    currentSpeechBar.hidden = true;
    currentSpeechSpeaker.textContent = "";
    currentSpeechSpeaker.className = "current-speech-speaker";
    currentSpeechText.textContent = "";
  }

  let preparingStateActive = false;
  function showPreparingState(show) {
    if (!currentSpeechBar || !currentSpeechSpeaker || !currentSpeechText) return;
    if (show) {
      preparingStateActive = true;
      currentSpeechBar.hidden = false;
      currentSpeechSpeaker.textContent = "";
      currentSpeechSpeaker.className = "current-speech-speaker";
      currentSpeechText.textContent = "Preparing first speaker…";
    } else {
      if (preparingStateActive) clearCurrentSpeechBar();
      preparingStateActive = false;
    }
  }

  function cancelTypewriter() {
    typewriterAborted = true;
    typewriterTimeouts.forEach(clearTimeout);
    typewriterTimeouts = [];
  }

  function enqueueSpeech(item) {
    speakQueue.push(item);
    ttsLog("enqueue", { speakerId: item.speakerId, queueLength: speakQueue.length });
    if (!isSpeaking) playNextSpeech();
  }

  function playNextSpeech() {
    if (isSpeaking) return;
    const item = speakQueue.shift();
    if (!item) {
      ttsLog("drain", { queueLength: 0 });
      return;
    }

    if (item.isObjection && !item.objectionDisplayDone) {
      const side = sideFromSpeakerId(item.speakerId);
      appendTranscriptLine(
        item.speakerId,
        item.speakerLabel || "",
        "debater",
        side,
        item.text || "",
        "objection",
        { objectionType: item.objectionType, raisedBy: item.raisedBy, justification: item.justification }
      );
      showObjectionBurst();
      item.objectionDisplayDone = true;
      speakQueue.unshift(item);
      setTimeout(playNextSpeech, OBJECTION_TTS_DELAY_MS);
      return;
    }

    if (item.isRuling && !item.rulingDisplayDone) {
      appendTranscriptLine(
        "chair",
        item.speakerLabel || getDisplayName("chair", "Chair"),
        "chair",
        "chair",
        item.text || "",
        "ruling",
        { ruling: item.ruling, reason: item.reason, penalty: item.penalty }
      );
      if (item.ruling === "SUSTAINED") showSustainedBurst(); else showOverruledBurst();
      item.rulingDisplayDone = true;
      speakQueue.unshift(item);
      setTimeout(playNextSpeech, OBJECTION_TTS_DELAY_MS);
      return;
    }

    const text = sanitizeClientText(item.text || "");
    const side = sideFromSpeakerId(item.speakerId);

    const speechMeta = item.isCorrection ? { isCorrection: true } : undefined;
    if (!("speechSynthesis" in window)) {
      if (item.isObjection) {
        appendTranscriptLine(item.speakerId, item.speakerLabel || "", "debater", side, text, "objection", { objectionType: item.objectionType, raisedBy: item.raisedBy, justification: item.justification });
        showObjectionBurst();
      } else if (item.isRuling) {
        appendTranscriptLine("chair", item.speakerLabel || "", "chair", "chair", text, "ruling", { ruling: item.ruling, reason: item.reason, penalty: item.penalty });
        if (item.ruling === "SUSTAINED") showSustainedBurst(); else showOverruledBurst();
      } else {
        appendTranscriptLine(item.speakerId, item.speakerLabel || "", item.roleType || "debater", side, text, "speech", speechMeta);
      }
      updateCurrentSpeechBar(getDisplayName(item.speakerId, item.speakerLabel), item.roleType || "debater", side, text);
      clearCurrentSpeechBar();
      sitDown(item.speakerId);
      setTimeout(playNextSpeech, 0);
      return;
    }

    initVoices();
    VOICE_MANAGER.load();
    try {
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    } catch (e) {}
    typewriterAborted = false;
    isSpeaking = true;
    standUp(item.speakerId);
    clearCurrentSpeakerHighlight();
    /** Show text and start typewriter when audio actually starts (sync text with voice). */
    function showTextWhenAudioStarts() {
      updateCurrentSpeechBar(getDisplayName(item.speakerId, item.speakerLabel), item.roleType || "debater", side, text);
      let span = null;
      if (!item.isObjection && !item.isRuling) {
        span = createTranscriptLine(getDisplayName(item.speakerId, item.speakerLabel), item.roleType || "debater", side, item.speakerId, true, "speech", speechMeta);
        transcriptTurns.push({
          speakerId: item.speakerId || undefined,
          speakerLabel: getDisplayName(item.speakerId, item.speakerLabel),
          text: text || "",
          side: side || sideFromSpeakerId(item.speakerId),
          turnIndex: transcriptTurns.length + 1,
          type: "speech",
          meta: speechMeta || undefined
        });
      }
      if (!item.isObjection && !item.isRuling) {
        runTypewriter(span || document.createElement("span"), text, typewriterDurationMs, () => onUtteranceDone(), currentSpeechText);
      }
    }
    const { voice, rate, pitch, volume } = VOICE_MANAGER.pick(item.speakerId, item.roleType);
    const textForSpeech = stripEmojiForSpeech(text) || " ";
    const speakRate = 0.95;
    const estimatedMs = estimateSpeechDurationMs(textForSpeech, rate);
    // Scale typewriter duration by 1/rate so transcript reveal aligns better with TTS (utterance.rate makes TTS slower)
    const typewriterDurationMs = Math.round(estimatedMs / speakRate);
    ttsLog("start", { speakerId: item.speakerId, textLen: textForSpeech.length, estimatedMs, queueLength: speakQueue.length });

    const utter = new SpeechSynthesisUtterance(textForSpeech);
    utter.lang = "en-US";
    utter.rate = speakRate;
    utter.pitch = pitch != null ? pitch : 1;
    utter.volume = volume != null ? volume : 1;
    const voicesNow = VOICE_MANAGER.getVoices();
    if (voice && voicesNow.indexOf(voice) !== -1) {
      utter.voice = voice;
    } else {
      const preferredEn = getPreferredEnglishVoice();
      if (preferredEn) utter.voice = preferredEn;
    }

    let doneCount = 0;
    let doneCalled = false;
    function onUtteranceDone() {
      doneCount += 1;
      if (doneCount < 2 || doneCalled) return;
      doneCalled = true;
      if (safetyTimer) clearTimeout(safetyTimer);
      clearCurrentSpeakerHighlight();
      clearCurrentSpeechBar();
      sitDown(item.speakerId);
      isSpeaking = false;
      const delay = TTS_CONFIG.postEndDelayMs || 0;
      if (delay > 0) setTimeout(playNextSpeech, delay);
      else playNextSpeech();
    }

    utter.onstart = () => {
      ttsLog("onstart", { speakerId: item.speakerId });
      showTextWhenAudioStarts();
    };
    utter.onend = () => {
      ttsLog("onend", { speakerId: item.speakerId, queueLength: speakQueue.length });
      onUtteranceDone();
    };
    utter.onerror = (e) => {
      ttsLog("onerror", { speakerId: item.speakerId, error: (e && e.error) ? String(e.error) : "unknown" });
      onUtteranceDone();
    };

    const maxWaitMs = Math.min(Math.max(estimatedMs * 2, 5000), 60000);
    const safetyTimer = setTimeout(() => {
      if (doneCalled) return;
      ttsLog("end (timeout)", { speakerId: item.speakerId });
      doneCalled = true;
      clearCurrentSpeakerHighlight();
      clearCurrentSpeechBar();
      sitDown(item.speakerId);
      isSpeaking = false;
      const delay = TTS_CONFIG.postEndDelayMs || 0;
      if (delay > 0) setTimeout(playNextSpeech, delay);
      else playNextSpeech();
    }, maxWaitMs);

    function fallbackSpeak() {
      try { window.speechSynthesis.resume(); } catch (e) {}
      window.speechSynthesis.speak(utter);
    }
    if (ttsMode === "external") {
      fetch(`${API_BASE}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: textForSpeech || item.text || "",
          speakerId: item.speakerId,
          voice: (voice && voice.name) || "",
          speed: speakRate
        })
      })
        .then((res) => {
          if (res.ok && res.headers.get("content-type") && res.headers.get("content-type").toLowerCase().includes("audio")) {
            return res.arrayBuffer().then((buf) => {
              const audio = new Audio(URL.createObjectURL(new Blob([buf])));
              audio.onended = () => onUtteranceDone();
              audio.onerror = () => fallbackSpeak();
              audio.onplaying = () => showTextWhenAudioStarts();
              audio.play().catch(() => fallbackSpeak());
            });
          }
          fallbackSpeak();
        })
        .catch(() => fallbackSpeak());
    } else {
      fallbackSpeak();
    }
  }

  function stopAllSpeech() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      ttsLog("cancel", { queueLength: speakQueue.length });
    }
    cancelTypewriter();
    speakQueue = [];
    isSpeaking = false;
    typewriterAborted = true;
    clearCurrentSpeakerHighlight();
    clearCurrentSpeechBar();
    resetCharacters();
  }

  /** @param {string} [entryType] - "speech" | "objection" | "ruling" (default "speech")
   *  @param {object} [meta] - for objection: objectionType, raisedBy, etc.; for ruling: ruling, reason, penalty */
  function appendTranscriptLine(speakerId, speakerLabel, roleType, side, text, entryType, meta) {
    const displayName = getDisplayName(speakerId, speakerLabel);
    const type = entryType || "speech";
    const textSpan = createTranscriptLine(displayName, roleType || "debater", side, speakerId, false, type, meta);
    textSpan.textContent = text || "";
    transcriptTurns.push({
      speakerId: speakerId || undefined,
      speakerLabel: displayName,
      text: text || "",
      side: side || sideFromSpeakerId(speakerId),
      turnIndex: transcriptTurns.length + 1,
      type,
      meta: meta || undefined
    });
  }

  function isApiErrorText(text) {
    if (!text || typeof text !== "string") return false;
    const t = text.trim();
    return /^HTTP \d+:/i.test(t) || /OpenRouter:/i.test(t) || /api key error/i.test(t) || /invalid.*key/i.test(t);
  }

  function handleSpeechEvent(data) {
    const side = sideFromSpeakerId(data.speakerId);
    const text = sanitizeClientText(data.text || "");
    if (!text) return;
    if (isApiErrorText(text)) {
      showToast("Generation error. Check server .env key.");
      return;
    }

    const meta = data.isCorrection ? { isCorrection: true } : undefined;
    if (getVoiceMode()) {
      enqueueSpeech({
        speakerId: data.speakerId,
        speakerLabel: data.speakerLabel || "",
        roleType: data.roleType || "debater",
        roleSubType: data.roleSubType,
        segmentId: data.segmentId ?? null,
        text: text,
        isCorrection: !!data.isCorrection
      });
    } else {
      appendTranscriptLine(data.speakerId, data.speakerLabel || "", data.roleType || "debater", side, text, "speech", meta);
    }
  }

  function getSelectedUserSlot() {
    const radio = document.querySelector('input[name="userSlot"]:checked');
    return (radio && radio.value) || "";
  }

  function initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return null;
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";
    rec.onresult = (event) => {
      let interim = "";
      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          userSpeechTranscript += (userSpeechTranscript ? " " : "") + transcript;
        } else {
          interim = transcript;
        }
      }
      if (yourTurnTranscript) yourTurnTranscript.textContent = (userSpeechTranscript + (interim ? " " + interim : "")).trim() || "(listening...)";
    };
    rec.onend = () => {
      if (voiceInputBtn) {
        voiceInputBtn.classList.remove("recording");
        voiceInputBtn.textContent = "Voice";
      }
      isRecording = false;
    };
    rec.onerror = () => {
      if (voiceInputBtn) {
        voiceInputBtn.classList.remove("recording");
        voiceInputBtn.textContent = "Voice";
      }
      isRecording = false;
    };
    return rec;
  }

  function showYourTurnPopup(segmentId, focusInput) {
    currentYourTurnSegmentId = segmentId;
    userSpeechTranscript = "";
    if (yourTurnTranscript) yourTurnTranscript.textContent = "";
    if (yourTurnTextInput) yourTurnTextInput.value = "";
    if (yourTurnPopup) yourTurnPopup.hidden = false;
    if (voiceInputBtn) voiceInputBtn.textContent = "Voice";
    if (endSpeakBtn) endSpeakBtn.disabled = false;
    if (focusInput && yourTurnTextInput) yourTurnTextInput.focus();
  }

  function hideYourTurnPopup() {
    if (yourTurnPopup) yourTurnPopup.hidden = true;
    currentYourTurnSegmentId = null;
    userSpeechTranscript = "";
    if (yourTurnTextInput) yourTurnTextInput.value = "";
    if (recognition && isRecording) {
      try { recognition.stop(); } catch (e) {}
      isRecording = false;
    }
  }

  async function submitUserSpeech() {
    if (!currentStreamId || !currentYourTurnSegmentId) return;
    const typed = yourTurnTextInput && yourTurnTextInput.value.trim();
    const voice = (yourTurnTranscript && yourTurnTranscript.textContent.trim()) || userSpeechTranscript.trim();
    const text = typed || voice || "(No speech.)";
    try {
      await fetch(`${API_BASE}/api/user-speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ streamId: currentStreamId, segmentId: currentYourTurnSegmentId, text })
      });
    } catch (e) {
      console.error("Failed to submit user speech", e);
    }
    hideYourTurnPopup();
  }

  function connectStream(topic) {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    const userSlot = getSelectedUserSlot();
    let url = `${API_BASE}/api/stream?topic=${encodeURIComponent(topic)}`;
    if (userSlot) url += `&userSlot=${encodeURIComponent(userSlot)}`;
    eventSource = new EventSource(url);
    currentStreamId = null;

    eventSource.onmessage = (event) => {
      if (!event.data) return;
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === "status") {
        if (data.streamId) currentStreamId = data.streamId;
        if (data.segmentId != null) currentSegmentId = data.segmentId;
        if (data.message === "debate_started") {
          /* debater objection dialogue (AI vs AI) still shown in transcript */
        }
        if (data.message === "debate_finished") {
          showPreparingState(false);
          startBtn.disabled = false;
          hideYourTurnPopup();
          const motion = (topicInput && topicInput.value) ? topicInput.value.trim() : "";
          if (motion) startBackgroundConclusion(motion);
        }
      } else if (data.type === "error") {
        const code = data.code || 500;
        showPreparingState(false);
        showToast("Generation error (" + code + "). Check server .env key.");
        startBtn.disabled = false;
        hideYourTurnPopup();
      } else if (data.type === "your_turn_soon" || data.type === "your_turn") {
        if (data.segmentId != null) currentSegmentId = data.segmentId;
        showYourTurnPopup(data.segmentId, data.type === "your_turn");
      } else if (data.type === "speech") {
        showPreparingState(false);
        if (data.speakerId != null) currentSpeakerId = data.speakerId;
        if (data.speakerId != null) currentSpeakerSide = sideFromSpeakerId(data.speakerId);
        if (data.segmentId != null) currentSegmentId = data.segmentId;
        handleSpeechEvent(data);
      } else if (data.type === "objection") {
        if (data.segmentId != null) currentSegmentId = data.segmentId;
        const side = (data.speakerId ? sideFromSpeakerId(data.speakerId) : null) || (data.side === "con" || data.side === "pro" ? data.side : "pro");
        const label = data.speakerLabel || getDisplayName(data.speakerId, "");
        const text = (data.justification || "Objection.").trim();
        if (getVoiceMode() && text) {
          enqueueSpeech({
            speakerId: data.speakerId || "pro1",
            speakerLabel: label,
            roleType: "debater",
            segmentId: data.segmentId ?? null,
            text: text,
            isObjection: true,
            objectionType: data.objectionType,
            raisedBy: data.raisedBy,
            justification: data.justification
          });
        } else {
          appendTranscriptLine(
            data.speakerId || "pro1",
            label,
            "debater",
            side,
            text,
            "objection",
            { objectionType: data.objectionType, raisedBy: data.raisedBy, justification: data.justification }
          );
          showObjectionBurst();
        }
      } else if (data.type === "ruling") {
        if (data.segmentId != null) currentSegmentId = data.segmentId;
        const label = data.speakerLabel || getDisplayName("chair", "Chair");
        const rulingText = (data.text || [data.ruling, data.reason].filter(Boolean).join(". ")).trim();
        if (getVoiceMode() && rulingText) {
          enqueueSpeech({
            speakerId: "chair",
            speakerLabel: label,
            roleType: "chair",
            segmentId: data.segmentId ?? null,
            text: rulingText,
            isRuling: true,
            ruling: data.ruling,
            reason: data.reason,
            penalty: data.penalty
          });
        } else {
          appendTranscriptLine(
            "chair",
            label,
            "chair",
            "chair",
            rulingText,
            "ruling",
            { ruling: data.ruling, reason: data.reason, penalty: data.penalty }
          );
          if (data.ruling === "SUSTAINED") showSustainedBurst(); else showOverruledBurst();
        }
      } else if (data.type === "clarification") {
        if (data.segmentId != null) currentSegmentId = data.segmentId;
        const side = sideFromSpeakerId(data.speakerId);
        const text = sanitizeClientText(data.text || "");
        if (text) {
          appendTranscriptLine(
            data.speakerId,
            data.speakerLabel || getDisplayName(data.speakerId, ""),
            data.roleType || "debater",
            side,
            text,
            "speech",
            { isClarification: true }
          );
          if (getVoiceMode()) {
            enqueueSpeech({
              speakerId: data.speakerId,
              speakerLabel: data.speakerLabel || "",
              roleType: data.roleType || "debater",
              segmentId: data.segmentId ?? null,
              text: text
            });
          }
        }
      }
    };

    eventSource.onerror = () => {
      showPreparingState(false);
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      startBtn.disabled = false;
      hideYourTurnPopup();
    };
  }

  function clearTranscript() {
    transcriptEl.innerHTML = "";
    clearCurrentSpeechBar();
    transcriptTurns = [];
    const jumpBtn = document.getElementById("transcriptJumpToLatest");
    if (jumpBtn) jumpBtn.remove();
  }

  function showToast(message) {
    let toast = document.getElementById("debateToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "debateToast";
      toast.className = "debate-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toast._tid);
    toast._tid = setTimeout(() => toast.classList.remove("show"), 4000);
  }

  function updateJumpToLatestVisibility() {
    let btn = document.getElementById("transcriptJumpToLatest");
    if (isTranscriptNearBottom()) {
      if (btn) btn.classList.remove("show");
      return;
    }
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.id = "transcriptJumpToLatest";
      btn.className = "transcript-jump-to-latest";
      btn.textContent = "Jump to latest";
      btn.addEventListener("click", () => {
        scrollTranscriptToLatest("smooth");
        updateJumpToLatestVisibility();
      });
      transcriptEl.parentElement.appendChild(btn);
    }
    btn.classList.add("show");
  }

  function setupTranscriptScrollTracking() {
    if (transcriptEl) {
      transcriptEl.addEventListener("scroll", () => updateJumpToLatestVisibility(), { passive: true });
    }
  }

  const RONPA_INTRO_DURATION_MS = 2150;

  function runRonpaIntroThenStart(topic) {
    const overlay = document.getElementById("ronpaIntro");
    const imgEl = document.getElementById("ronpaIntroImage");
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!overlay || !imgEl || prefersReducedMotion) {
      unlockSpeechThenConnect(topic);
      return;
    }
    loadImageChromaKey("assets/ronpa-intro.png", (dataUrl) => {
      imgEl.src = dataUrl;
      overlay.hidden = false;
      overlay.setAttribute("aria-hidden", "false");
      overlay.setAttribute("data-active", "true");
      setTimeout(() => {
        overlay.setAttribute("data-active", "false");
        setTimeout(() => {
          overlay.hidden = true;
          overlay.setAttribute("aria-hidden", "true");
          unlockSpeechThenConnect(topic);
        }, 380);
      }, RONPA_INTRO_DURATION_MS);
    }, () => {
      unlockSpeechThenConnect(topic);
    });
  }

  const OBJECTION_BURST_DURATION_MS = 1750;
  /** Delay before TTS speaks the objection line so icon is visible first (fallback: icon then dialogue). */
  const OBJECTION_TTS_DELAY_MS = 550;
  let objectionBurstShownAt = null;

  function showObjectionBurst() {
    const overlay = document.getElementById("objectionIntro");
    const imgEl = document.getElementById("objectionIntroImage");
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!overlay || !imgEl || prefersReducedMotion) return;
    objectionBurstShownAt = Date.now();
    loadImageChromaKey("assets/objection-intro.png", (dataUrl) => {
      imgEl.src = dataUrl;
      overlay.hidden = false;
      overlay.setAttribute("aria-hidden", "false");
      overlay.setAttribute("data-active", "true");
      setTimeout(() => {
        overlay.setAttribute("data-active", "false");
        setTimeout(() => {
          overlay.hidden = true;
          overlay.setAttribute("aria-hidden", "true");
        }, 300);
      }, OBJECTION_BURST_DURATION_MS);
    });
  }

  function showRulingBurst(imageId, overlayId, assetPath) {
    const overlay = document.getElementById(overlayId);
    const imgEl = document.getElementById(imageId);
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!overlay || !imgEl || prefersReducedMotion) return;
    loadImageChromaKey(assetPath, (dataUrl) => {
      imgEl.src = dataUrl;
      overlay.hidden = false;
      overlay.setAttribute("aria-hidden", "false");
      overlay.setAttribute("data-active", "true");
      setTimeout(() => {
        overlay.setAttribute("data-active", "false");
        setTimeout(() => {
          overlay.hidden = true;
          overlay.setAttribute("aria-hidden", "true");
        }, 300);
      }, OBJECTION_BURST_DURATION_MS);
    });
  }

  function showSustainedBurst() {
    showRulingBurst("sustainedIntroImage", "sustainedIntro", "assets/sustained-intro.png");
  }

  function showOverruledBurst() {
    showRulingBurst("overruledIntroImage", "overruledIntro", "assets/overruled-intro.png");
  }

  function onStart() {
    const topic = (topicInput.value || "").trim();
    if (!topic) {
      topicInput.focus();
      return;
    }
    clearTranscript();
    resetCharacters();
    stopAllSpeech();
    startBtn.disabled = true;
    showPreparingState(true);

    fetch(`${API_BASE}/api/tts/config`).then((r) => {
      if (r.ok) return r.json();
      return { mode: "browser" };
    }).then((j) => {
      ttsMode = (j && j.mode === "external") ? "external" : "browser";
    }).catch(() => { ttsMode = "browser"; });

    fetch(`${API_BASE}/api/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic })
    }).catch((e) => console.warn("Failed /api/start", e));

    runRonpaIntroThenStart(topic);
  }

  function onStopReset() {
    showPreparingState(false);
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    stopAllSpeech();
    clearTranscript();
    startBtn.disabled = false;
  }

  initVoices();
  setupTranscriptScrollTracking();

  const copyScriptBtn = document.getElementById("copyScriptBtn");
  if (copyScriptBtn) {
    copyScriptBtn.addEventListener("click", () => {
      const text = transcriptEl && transcriptEl.innerText ? transcriptEl.innerText : "";
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => showToast("Copied to clipboard.")).catch(() => showToast("Copy failed."));
    });
  }

  function escapeHtml(str) {
    if (str == null) return "";
    const s = String(str);
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  /** Convert conclusion JSON to markdown string. */
  function conclusionToMarkdown(data) {
    const lines = [];
    if (data.title) lines.push("# " + data.title + "\n");
    if (data.topic) lines.push("**Topic:** " + data.topic + "\n");
    if (data.meta && data.meta.generatedAt) lines.push("*Generated " + data.meta.generatedAt + (data.meta.model ? " · " + data.meta.model : "") + "*\n");
    (data.sections || []).forEach((sec) => {
      if (!sec.heading) return;
      lines.push("\n## " + sec.heading + "\n");
      const items = sec.items || sec.bullets;
      if (Array.isArray(items)) {
        if (sec.id === "literature") {
          items.forEach((it) => {
            const title = it.title || "";
            const url = it.url || (it.doi ? "https://doi.org/" + it.doi : "");
            const link = url ? "[" + title + "](" + url + ")" : title;
            const auth = (it.authors && it.authors.length) ? " " + it.authors.join(", ") : "";
            const rel = it.relevance ? " — " + it.relevance : "";
            lines.push("- " + link + (auth ? " —" + auth : "") + rel);
          });
        } else if (sec.id === "media") {
          items.forEach((it) => {
            const title = it.title || "";
            const url = (it.url || "").trim();
            const link = url ? "[" + title + "](" + url + ")" : title;
            lines.push("- **" + (it.kind || "Media") + ":** " + link + " by " + (it.creator || "") + (it.whyRelevant ? " — " + it.whyRelevant : ""));
          });
        } else if (sec.id === "argument_map") {
          items.forEach((it) => {
            lines.push("- **" + (it.node || "") + "** (" + (it.side || "") + ")");
            if (it.supports && it.supports.length) lines.push("  - Supports: " + it.supports.join("; "));
            if (it.attacks && it.attacks.length) lines.push("  - Attacks: " + it.attacks.join("; "));
          });
        } else if (sec.id === "core_clashes") {
          items.forEach((it) => {
            lines.push("- **" + (it.clash || "") + "** — Aff: " + (it.aff || "") + " | Neg: " + (it.neg || ""));
          });
        } else if (sec.id === "verdict") {
          items.forEach((it) => {
            lines.push("- **" + (it.winner || "") + "**");
            (it.reasoning || []).forEach((r) => lines.push("  - " + r));
          });
        } else {
          items.forEach((it) => {
            const text = typeof it === "string" ? it : (it.text || it.angle || it.question || it.steelman || "");
            if (text) lines.push("- " + text);
          });
        }
      } else if (Array.isArray(sec.bullets)) {
        sec.bullets.forEach((b) => { if (typeof b === "string") lines.push("- " + b); });
      }
    });
    return lines.join("\n").trim();
  }

  /** Render one conclusion section as HTML (flat, all visible). */
  function renderConclusionSection(sec) {
    const items = sec.items || [];
    let body = "";
    if (sec.id === "definitions") {
      body = "<ul class=\"conclusion-list\">" + items.map((it) => "<li>" + escapeHtml(it.text || "") + "</li>").join("") + "</ul>";
    } else if (sec.id === "argument_map") {
      body = "<ul class=\"conclusion-list conclusion-argument-map\">" + items.map((it) => "<li><strong>" + escapeHtml(it.node || "") + "</strong> <span class=\"conclusion-side conclusion-side--" + (it.side === "Affirmative" ? "aff" : "neg") + "\">" + escapeHtml(it.side || "") + "</span>" + (it.supports && it.supports.length ? "<br>Supports: " + escapeHtml(it.supports.join("; ")) : "") + (it.attacks && it.attacks.length ? "<br>Attacks: " + escapeHtml(it.attacks.join("; ")) : "") + "</li>").join("") + "</ul>";
    } else if (sec.id === "core_clashes") {
      body = "<ul class=\"conclusion-list\">" + items.map((it) => "<li><strong>" + escapeHtml(it.clash || "") + "</strong><br>Aff: " + escapeHtml(it.aff || "") + "<br>Neg: " + escapeHtml(it.neg || "") + "</li>").join("") + "</ul>";
    } else if (sec.id === "assumptions") {
      body = "<ul class=\"conclusion-list\">" + items.map((it) => "<li><span class=\"conclusion-who\">" + escapeHtml(it.who || "") + "</span>: " + escapeHtml(it.text || "") + "</li>").join("") + "</ul>";
    } else if (sec.id === "steelman") {
      body = "<ul class=\"conclusion-list\">" + items.map((it) => "<li><strong>" + escapeHtml(it.targetSide || "") + "</strong><br>Steelman: " + escapeHtml(it.steelman || "") + "<br>Best reply: " + escapeHtml(it.bestReply || "") + "</li>").join("") + "</ul>";
    } else if (sec.id === "novel_angles") {
      body = "<ul class=\"conclusion-list conclusion-novel-angles\">" + items.map((it) => "<li>" + escapeHtml(it.angle || "") + (it.whyItMatters ? "<br><em class=\"conclusion-why-matters\">" + escapeHtml(it.whyItMatters) + "</em>" : "") + "</li>").join("") + "</ul>";
    } else if (sec.id === "empirical") {
      body = "<ul class=\"conclusion-list\">" + items.map((it) => "<li>" + escapeHtml(it.question || "") + "<br>What would change your mind: " + escapeHtml(it.whatWouldChangeYourMind || "") + "</li>").join("") + "</ul>";
    } else if (sec.id === "verdict") {
      body = "<ul class=\"conclusion-list\">" + items.map((it) => "<li><strong>" + escapeHtml(it.winner || "") + "</strong><ul>" + (it.reasoning || []).map((r) => "<li>" + escapeHtml(r) + "</li>").join("") + "</ul></li>").join("") + "</ul>";
    } else if (sec.id === "literature") {
      body = "<ul class=\"conclusion-list conclusion-literature\">" + items.map((it) => {
        const url = (it.url || (it.doi ? "https://doi.org/" + it.doi : "")).trim();
        const link = url ? "<a href=\"" + escapeHtml(url) + "\" target=\"_blank\" rel=\"noopener\">" + escapeHtml(it.title || "") + "</a>" : escapeHtml(it.title || "");
        const auth = (it.authors && it.authors.length) ? " <span class=\"conclusion-authors\">" + escapeHtml(it.authors.slice(0, 4).join(", ")) + "</span>" : "";
        const rel = it.relevance ? "<br><span class=\"conclusion-relevance\">" + escapeHtml(it.relevance) + "</span>" : "";
        const meta = [it.year].filter(Boolean).join(" · ");
        return "<li class=\"conclusion-lit-item\">" + link + auth + (meta ? " (" + escapeHtml(meta) + ")" : "") + rel + "</li>";
      }).join("") + "</ul>";
    } else if (sec.id === "media") {
      body = "<ul class=\"conclusion-list conclusion-media\">" + items.map((it) => {
        const kind = (it.kind || "Media").trim();
        const title = escapeHtml(it.title || "");
        const creator = escapeHtml(it.creator || "");
        const url = (it.url || "").trim();
        const titleEl = url ? "<a href=\"" + escapeHtml(url) + "\" target=\"_blank\" rel=\"noopener\">" + title + "</a>" : title;
        const why = it.whyRelevant ? "<br><span class=\"conclusion-why\">" + escapeHtml(it.whyRelevant) + "</span>" : "";
        const spoiler = it.spoilerFree === false ? " <span class=\"conclusion-spoiler\">Spoilers</span>" : "";
        const year = it.year ? " (" + it.year + ")" : "";
        return "<li class=\"conclusion-media-item\"><span class=\"conclusion-media-kind\">" + escapeHtml(kind) + "</span> " + titleEl + " — " + creator + year + why + spoiler + "</li>";
      }).join("") + "</ul>";
    } else {
      body = "<ul class=\"conclusion-list\">" + items.map((it) => "<li>" + escapeHtml(typeof it === "string" ? it : (it.text || "")) + "</li>").join("") + "</ul>";
    }
    return body;
  }

  let conclusionAbortController = null;
  const CONCLUSION_FETCH_TIMEOUT_MS = 60000;
  const CONCLUSION_LOADING_HTML = '<div class="conclusion-loading conclusion-loading-wrap" aria-busy="true" aria-live="polite">' +
    '<div class="conclusion-loading-spinner" aria-hidden="true"></div>' +
    '<p class="conclusion-loading-label">Analyzing topic…</p>' +
    '<div class="conclusion-loading-skeleton">' +
    '<span class="conclusion-loading-line"></span>' +
    '<span class="conclusion-loading-line conclusion-loading-line--short"></span>' +
    '<span class="conclusion-loading-line conclusion-loading-line--medium"></span>' +
    '</div></div>';

  /** Conclusion cache: keyed by motion only (topic-only analysis). */
  let conclusionCache = { motion: "", status: "idle", data: null, error: null };

  /** Fill content element with successful conclusion data (shared by fetch and cache). */
  function fillConclusionContent(contentEl, data) {
    if (!contentEl || !data) return;
    const hasStructuredSections = data.sections && data.sections[0] && "items" in data.sections[0];
    let html = "";
    if (data.title) html += '<h2 class="conclusion-main-title">' + escapeHtml(data.title) + "</h2>";
    if (data.topic) html += '<p class="conclusion-topic">' + escapeHtml(data.topic) + "</p>";
    if (data.meta && (data.meta.generatedAt || data.meta.model)) {
      html += '<p class="conclusion-meta">' + escapeHtml(data.meta.generatedAt || "") + (data.meta.model ? " · " + escapeHtml(data.meta.model) : "") + "</p>";
    }
    html += "<div class='conclusion-actions'><button type='button' class='conclusion-copy-md' id='conclusionCopyMd'>Copy as Markdown</button></div><div class='conclusion-sections'>";
    (data.sections || []).forEach((sec) => {
      const heading = sec.heading || sec.id || "";
      if (!heading) return;
      const id = "sec-" + (sec.id || Math.random().toString(36).slice(2));
      const body = hasStructuredSections ? renderConclusionSection(sec) : (Array.isArray(sec.bullets) ? "<ul class=\"conclusion-list\">" + sec.bullets.map((b) => "<li>" + escapeHtml(b) + "</li>").join("") + "</ul>" : "");
      const sectionClass = "conclusion-section" + (sec.id === "verdict" ? " conclusion-section--verdict" : "");
      html += '<div class="' + sectionClass + '" id="' + escapeHtml(id) + '"><h3 class="conclusion-section-heading">' + escapeHtml(heading) + "</h3><div class=\"conclusion-section-body\">" + body + "</div></div>";
    });
    html += "</div>";
    contentEl.innerHTML = html || "<p class=\"conclusion-error\">No content returned.</p>";
    const copyBtn = document.getElementById("conclusionCopyMd");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        const md = conclusionToMarkdown(data);
        navigator.clipboard.writeText(md).then(() => showToast("Markdown copied.")).catch(() => showToast("Copy failed."));
      });
    }
  }

  /** Start topic-only conclusion fetch in background; cache by motion. When done, if modal is open and showing loading, update it. */
  function startBackgroundConclusion(motion) {
    const motionTrim = (motion || "").trim();
    if (!motionTrim) return;
    if (conclusionCache.motion === motionTrim && (conclusionCache.status === "done" || conclusionCache.status === "loading")) return;
    conclusionCache = { motion: motionTrim, status: "loading", data: null, error: null };

    fetch(`${API_BASE}/api/conclusion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motion: motionTrim })
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.ok === false || data.error) {
          conclusionCache = { motion: motionTrim, status: "error", data: null, error: (data.error && data.error.message) || data.error || "Analysis failed" };
          return;
        }
        conclusionCache = { motion: motionTrim, status: "done", data, error: null };
        const content = document.getElementById("conclusionContent");
        const modal = document.getElementById("conclusionModal");
        if (content && modal && !modal.hidden && content.querySelector && content.querySelector(".conclusion-loading")) {
          fillConclusionContent(content, data);
        }
      })
      .catch((err) => {
        conclusionCache = { motion: motionTrim, status: "error", data: null, error: err.message || "Request failed" };
      });
  }

  function runConclusionFetch(content, motion, signal, stopLoading) {
    let timeoutId = null;
    let progressId = null;

    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (conclusionAbortController) conclusionAbortController.abort();
      content.innerHTML = '<p class="conclusion-error">Request timed out. Try again or use a faster model.</p><button type="button" class="conclusion-retry-btn" id="conclusionRetryBtn">Retry</button>';
      document.getElementById("conclusionRetryBtn")?.addEventListener("click", () => openConclusionModal());
      showToast("Conclusion timed out");
    }, CONCLUSION_FETCH_TIMEOUT_MS);

    progressId = setTimeout(() => {
      progressId = null;
      if (signal.aborted) return;
      content.innerHTML = CONCLUSION_LOADING_HTML;
    }, 6000);

    function clearTimers() {
      if (timeoutId != null) clearTimeout(timeoutId);
      if (progressId != null) clearTimeout(progressId);
    }

    fetch(`${API_BASE}/api/conclusion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motion }),
      signal
    })
      .then((res) => res.json())
      .then((data) => {
        clearTimers();
        if (signal.aborted) return;
        stopLoading();
        if (data.ok === false || data.error) {
          const msg = (data.error && data.error.message) || data.error || "Analysis failed";
          content.innerHTML = '<p class="conclusion-error">' + escapeHtml(typeof msg === "string" ? msg : "Conclusion failed") + "</p><button type='button' class='conclusion-retry-btn' id='conclusionRetryBtn'>Retry</button>";
          document.getElementById("conclusionRetryBtn")?.addEventListener("click", () => openConclusionModal());
          showToast(typeof msg === "string" ? msg : "Conclusion failed");
          return;
        }
        conclusionCache = { motion, status: "done", data, error: null };
        fillConclusionContent(content, data);
      })
      .catch((err) => {
        clearTimers();
        if (signal.aborted) return;
        stopLoading();
        const msg = err.name === "AbortError" ? "Cancelled" : (err.message || "Request failed");
        content.innerHTML = '<p class="conclusion-error">' + escapeHtml(msg) + "</p><button type='button' class='conclusion-retry-btn' id='conclusionRetryBtn'>Retry</button>";
        document.getElementById("conclusionRetryBtn")?.addEventListener("click", () => openConclusionModal());
        if (err.name !== "AbortError") showToast(msg);
      })
      .finally(() => { stopLoading(); });
  }

  function openConclusionModal() {
    const modal = document.getElementById("conclusionModal");
    const content = document.getElementById("conclusionContent");
    if (!modal || !content) return;

    const motion = (topicInput && topicInput.value) ? topicInput.value.trim() : "";

    if (!motion) {
      modal.hidden = false;
      modal.setAttribute("aria-hidden", "false");
      content.innerHTML = '<p class="conclusion-error">Enter a topic first.</p>';
      return;
    }

    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");

    if (conclusionCache.motion === motion && conclusionCache.status === "done" && conclusionCache.data) {
      content.innerHTML = "";
      content.classList.remove("conclusion-loading");
      fillConclusionContent(content, conclusionCache.data);
      return;
    }
    if (conclusionCache.motion === motion && conclusionCache.status === "loading") {
      content.innerHTML = CONCLUSION_LOADING_HTML;
      return;
    }
    if (conclusionCache.motion === motion && conclusionCache.status === "error" && conclusionCache.error) {
      content.innerHTML = '<p class="conclusion-error">' + escapeHtml(conclusionCache.error) + "</p><button type='button' class='conclusion-retry-btn' id='conclusionRetryBtn'>Retry</button>";
      document.getElementById("conclusionRetryBtn")?.addEventListener("click", () => openConclusionModal());
      return;
    }

    if (conclusionAbortController) conclusionAbortController.abort();
    conclusionAbortController = new AbortController();
    const signal = conclusionAbortController.signal;
    content.innerHTML = CONCLUSION_LOADING_HTML;
    function stopLoading() {
      conclusionAbortController = null;
    }
    runConclusionFetch(content, motion, signal, stopLoading);
  }

  function closeConclusionModal() {
    const modal = document.getElementById("conclusionModal");
    if (!modal) return;
    if (conclusionAbortController) {
      conclusionAbortController.abort();
      conclusionAbortController = null;
    }
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }

  function setupConclusionModal() {
    const conclusionBtn = document.getElementById("conclusionBtn");
    const modal = document.getElementById("conclusionModal");
    const backdrop = document.getElementById("conclusionBackdrop");
    const closeBtn = document.getElementById("conclusionClose");

    if (conclusionBtn) {
      conclusionBtn.addEventListener("click", () => openConclusionModal());
    }
    if (backdrop) {
      backdrop.addEventListener("click", () => closeConclusionModal());
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", () => closeConclusionModal());
    }
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal && !modal.hidden) {
        closeConclusionModal();
      }
    });
  }

  setupConclusionModal();

  fetch(`${API_BASE}/api/ping`)
    .then((r) => { if (!r.ok) throw new Error("ping not ok"); })
    .catch(() => showToast("Backend API not reachable. You may be running frontend from Live Server / wrong port. Set window.__API_BASE__."));

  if (startBtn) startBtn.addEventListener("click", onStart);
  if (stopBtn) stopBtn.addEventListener("click", onStopReset);

  // Transcript panel: collapsible toggle (UI only)
  const transcriptToggle = document.getElementById("transcriptToggle");
  const transcriptContainer = document.querySelector(".transcript-container");
  if (transcriptToggle && transcriptContainer) {
    transcriptToggle.addEventListener("click", () => {
      const collapsed = transcriptContainer.classList.toggle("is-collapsed");
      transcriptToggle.setAttribute("aria-expanded", String(!collapsed));
    });
  }

  // Stage fullscreen: CSS-driven smooth enter/exit (no browser fullscreen API)
  const stageHero = document.getElementById("stageHero");
  const stageFullscreenBtn = document.getElementById("stageFullscreenBtn");
  const stageFullscreenBtnText = stageFullscreenBtn && stageFullscreenBtn.querySelector(".stage-fullscreen-btn-text");
  const FS_DURATION_MS = 450;

  function isStageFullscreen() {
    return stageHero && stageHero.classList.contains("is-fullscreen-expanded");
  }

  function updateFullscreenButton() {
    if (!stageFullscreenBtn || !stageFullscreenBtnText) return;
    if (isStageFullscreen()) {
      stageFullscreenBtn.title = "Exit fullscreen";
      stageFullscreenBtn.setAttribute("aria-label", "Exit fullscreen");
      stageFullscreenBtnText.textContent = "Exit fullscreen";
    } else {
      stageFullscreenBtn.title = "Enter fullscreen (immersion mode)";
      stageFullscreenBtn.setAttribute("aria-label", "Enter fullscreen");
      stageFullscreenBtnText.textContent = "Fullscreen";
    }
  }

  function enterStageFullscreen() {
    if (!stageHero) return;
    const rect = stageHero.getBoundingClientRect();
    stageHero.style.setProperty("--fs-top", rect.top + "px");
    stageHero.style.setProperty("--fs-left", rect.left + "px");
    stageHero.style.setProperty("--fs-width", rect.width + "px");
    stageHero.style.setProperty("--fs-height", rect.height + "px");
    stageHero.classList.add("is-fullscreen");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        stageHero.classList.add("is-fullscreen-expanded");
        updateFullscreenButton();
      });
    });
  }

  function exitStageFullscreen() {
    if (!stageHero || !stageHero.classList.contains("is-fullscreen")) return;
    stageHero.classList.remove("is-fullscreen-expanded");
    updateFullscreenButton();
    setTimeout(() => {
      stageHero.classList.remove("is-fullscreen");
      stageHero.style.removeProperty("--fs-top");
      stageHero.style.removeProperty("--fs-left");
      stageHero.style.removeProperty("--fs-width");
      stageHero.style.removeProperty("--fs-height");
      updateFullscreenButton();
    }, FS_DURATION_MS + 30);
  }

  function toggleStageFullscreen() {
    if (!stageHero) return;
    if (isStageFullscreen()) exitStageFullscreen();
    else enterStageFullscreen();
  }

  if (stageFullscreenBtn && stageHero) {
    stageFullscreenBtn.addEventListener("click", toggleStageFullscreen);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isStageFullscreen()) {
        exitStageFullscreen();
      }
    });
  }

  // Optional: subtle parallax on stage (background moves 1–2px slower than foreground)
  const stageBackground = document.getElementById("stageBackground");
  const stageForegroundWrap = stageContainer && stageContainer.querySelector(".stage-foreground-wrap");
  const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (stageContainer && stageBackground && stageForegroundWrap && !prefersReducedMotion()) {
    let raf = null;
    stageContainer.addEventListener("mousemove", (e) => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = stageContainer.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width - 0.5;
        const y = (e.clientY - rect.top) / rect.height - 0.5;
        const bgX = x * 1;
        const bgY = y * 1;
        const fgX = x * 2;
        const fgY = y * 2;
        stageBackground.style.transform = `translate(${bgX}px, ${bgY}px)`;
        stageForegroundWrap.style.transform = `translate(${fgX}px, ${fgY}px)`;
        raf = null;
      });
    });
    stageContainer.addEventListener("mouseleave", () => {
      if (raf) cancelAnimationFrame(raf);
      stageBackground.style.transform = "";
      stageForegroundWrap.style.transform = "";
    });
  }
})();
