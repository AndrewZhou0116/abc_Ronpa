# Character voice setup

The project supports two ways to make debater voices closer to the characters (e.g. Pro 1 Trump style, Chair Makima): **browser TTS** and **external TTS (e.g. ElevenLabs)**.

---

## 1. Browser TTS (no extra service)

Uses the system/browser built-in speech synthesis and assigns each role a preferred **voice name** so each character keeps a consistent “style” of voice.

- **Current mapping** (in `public/app.js`, `SPEAKER_VOICE_PREFERENCES`):
  - **Chair (Makima):** Prefer female voices (Zira, Samantha, Victoria, etc.)
  - **Pro 1 (Trump):** Deeper / more forceful (David, Mark)
  - **Pro 2 (Light):** Younger male (Daniel, James)
  - **Pro 3 (Kant):** Mature (George)
  - **Con 1/2/3:** Similarly assigned by role style

- **Custom:** Override `window.DEBATE_SPEAKER_VOICE_PREFERENCES` before the page loads, e.g. add a script in `index.html`:

```html
<script>
  window.DEBATE_SPEAKER_VOICE_PREFERENCES = {
    chair: ["zira", "samantha"],
    pro1: ["david", "mark"],
    pro2: ["daniel"],
    pro3: ["george"],
    con1: ["david"],
    con2: ["james"],
    con3: ["george"]
  };
</script>
<script src="app.js"></script>
```

- **Limitation:** Browser TTS only offers generic system voices; it **cannot** reproduce “Trump himself” or anime character voices, only “one fixed system voice per role with slightly different style.”

---

## 2. External TTS (ElevenLabs) — closer to character voices

Using [ElevenLabs](https://elevenlabs.io) (or similar) with multiple/cloned voices, you can set a different **voice_id** per debater for more “in-character” speech (including closer to real or specific styles).

### 2.1 Environment variables (`.env`)

```env
TTS_MODE=external
TTS_PROVIDER=elevenlabs
TTS_API_KEY=your_ElevenLabs_API_Key
TTS_VOICE_DEFAULT=default_voice_id

# Per-speaker (optional; unset uses TTS_VOICE_DEFAULT)
TTS_VOICE_CHAIR=voice_id_for_makima
TTS_VOICE_PRO1=voice_id_for_trump_style
TTS_VOICE_PRO2=voice_id_for_light_style
TTS_VOICE_PRO3=voice_id_for_kant_style
TTS_VOICE_CON1=voice_id_for_gus_style
TTS_VOICE_CON2=voice_id_for_camus_style
TTS_VOICE_CON3=voice_id_for_newton_style
```

### 2.2 Getting voice_id

1. Log in at [ElevenLabs](https://elevenlabs.io) → **Voice Library**.
2. Use an existing voice or create a **Voice Clone** (follow their terms and law; do not imitate real people for misleading use).
3. Each voice has a **Voice ID**; copy it into the corresponding env vars above.

The frontend sends `speakerId` (e.g. `pro1`, `chair`) when calling `/api/tts`; the server uses `SPEAKER_VOICE_IDS` to pick the right `voice_id`, so each debater maps to a fixed voice.

### 2.3 Optional: model

```env
TTS_ELEVEN_MODEL=eleven_multilingual_v2
```

If unset, `eleven_monolingual_v1` is used by default.

---

## Summary

| Method                | Can “match” character voice?     | Setup difficulty |
|-----------------------|-----------------------------------|------------------|
| Browser TTS           | Only fixes system voice per role | Low; edit `SPEAKER_VOICE_PREFERENCES` |
| External TTS (ElevenLabs) | Can use/clone closer voices   | API key + set `TTS_VOICE_*` per speaker |

For a Pro 1 that sounds more “Trump-like,” use **ElevenLabs** and assign a similar-style voice (or clone) to Pro 1, then set `TTS_VOICE_PRO1=that_voice_id` in `.env`.
