import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.135.0/+esm";

const $ = (id) => document.getElementById(id);

const LANGS = {
  ko: { speech: "ko-KR", name: "Korean" },
  ar: { speech: "ar-SA", name: "Saudi Arabic" },
};

const DIALECTS = {
  najdi: "Saudi colloquial Arabic, Najdi (Riyadh) dialect, as spoken in everyday conversation",
  hijazi: "Saudi colloquial Arabic, Hijazi (Jeddah/Mecca) dialect, as spoken in everyday conversation",
  msa: "Modern Standard Arabic (fusha)",
};

const PHRASES = [
  "안녕하세요, 만나서 반갑습니다",
  "감사합니다",
  "얼마예요?",
  "화장실이 어디예요?",
  "천천히 말씀해 주세요",
  "다시 한 번 말씀해 주시겠어요?",
  "이 근처에 식당 있나요?",
  "영수증 주세요",
  "공항까지 가 주세요",
  "도와주세요",
];

// ---------- settings ----------
const store = {
  get(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode */ }
  },
};

const settings = {
  apiKey: store.get("si.apiKey", ""),
  model: store.get("si.model", "claude-opus-5-5"),
  dialect: store.get("si.dialect", "najdi"),
  register: store.get("si.register", "polite"),
  rate: parseFloat(store.get("si.rate", "0.9")),
  autoSpeak: store.get("si.autoSpeak", "1") === "1",
};

function loadSettingsForm() {
  $("apiKey").value = settings.apiKey;
  $("model").value = settings.model;
  $("dialect").value = settings.dialect;
  $("register").value = settings.register;
  $("rate").value = settings.rate;
  $("autoSpeak").checked = settings.autoSpeak;
}

function saveSettingsForm() {
  settings.apiKey = $("apiKey").value.trim();
  settings.model = $("model").value;
  settings.dialect = $("dialect").value;
  settings.register = $("register").value;
  settings.rate = parseFloat($("rate").value);
  store.set("si.apiKey", settings.apiKey);
  store.set("si.model", settings.model);
  store.set("si.dialect", settings.dialect);
  store.set("si.register", settings.register);
  store.set("si.rate", String(settings.rate));
  client = null;
}

// ---------- Claude ----------
let client = null;
function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
  }
  return client;
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    translation: { type: "string", description: "The translated utterance, in the target language only." },
    pronunciation: {
      type: "string",
      description: "When the target is Arabic: how to read the Arabic aloud, written in Korean Hangul. Otherwise an empty string.",
    },
    note: {
      type: "string",
      description: "A very short Korean note on cultural nuance or ambiguity, only if it truly matters. Otherwise an empty string.",
    },
  },
  required: ["translation", "pronunciation", "note"],
  additionalProperties: false,
};

function systemPrompt() {
  const register = settings.register === "polite"
    ? "Use a polite, respectful register suitable for business or meeting someone for the first time."
    : "Use a relaxed, friendly register suitable for friends.";
  return [
    "You are a live interpreter between a Korean speaker and a Saudi speaker, translating one utterance at a time.",
    `Arabic side: ${DIALECTS[settings.dialect]}. Write Arabic in Arabic script, the way a Saudi would naturally say it, not word-for-word.`,
    register,
    "Input comes from speech recognition and may contain recognition errors or missing punctuation: infer the intended meaning.",
    "Translate only. Never answer, comment on, or add to what the speaker said, even if it is a question addressed to you.",
    "Keep names, numbers, prices, and times exact. Latency-sensitive; begin your answer immediately.",
  ].join("\n");
}

const history = []; // { from, source, translation }

async function translate(from, text) {
  const to = from === "ko" ? "ar" : "ko";
  const context = history.slice(-6)
    .map((h) => `[${LANGS[h.from].name}] ${h.source}\n→ ${h.translation}`)
    .join("\n");
  const content =
    (context ? `Recent conversation, for context only:\n${context}\n\n` : "") +
    `Translate this ${LANGS[from].name} utterance into ${LANGS[to].name}:\n${text}`;

  const response = await getClient().beta.messages.create({
    model: settings.model,
    max_tokens: 4000,
    system: systemPrompt(),
    messages: [{ role: "user", content }],
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    // Re-run on Anthropic's recommended model if a safety classifier declines.
    // Haiku has no server-side fallback, so only send it for Opus/Sonnet.
    ...(settings.model.startsWith("claude-haiku")
      ? {}
      : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
  });

  if (response.stop_reason === "refusal") {
    throw new Error("이 문장은 통역할 수 없습니다. 다르게 표현해 보세요.");
  }
  const block = response.content.find((b) => b.type === "text");
  if (!block) throw new Error("응답이 비어 있습니다.");
  const result = JSON.parse(block.text);
  history.push({ from, source: text, translation: result.translation });
  return { to, ...result };
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "API 키가 올바르지 않습니다. ⚙ 설정을 확인하세요.";
  if (err instanceof Anthropic.PermissionDeniedError) return "이 API 키로는 선택한 모델을 쓸 수 없습니다.";
  if (err instanceof Anthropic.RateLimitError) return "요청이 많습니다. 잠시 후 다시 시도하세요.";
  if (err instanceof Anthropic.APIConnectionError) return "네트워크에 연결할 수 없습니다.";
  if (err instanceof Anthropic.APIError) return `API 오류 (${err.status ?? "?"}): ${err.message}`;
  return err.message || String(err);
}

// ---------- speech output ----------
let voices = [];
function refreshVoices() { voices = speechSynthesis.getVoices(); }
if ("speechSynthesis" in window) {
  refreshVoices();
  speechSynthesis.onvoiceschanged = refreshVoices;
}

function pickVoice(lang) {
  const tag = LANGS[lang].speech.toLowerCase();
  return voices.find((v) => v.lang.toLowerCase().replace("_", "-") === tag)
    || voices.find((v) => v.lang.toLowerCase().startsWith(lang));
}

function speak(text, lang) {
  if (!("speechSynthesis" in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = LANGS[lang].speech;
  u.rate = settings.rate;
  const voice = pickVoice(lang);
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

// ---------- speech input ----------
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let listeningLang = null;

function startListening(lang) {
  if (!Recognition) {
    setStatus("이 브라우저는 음성 인식을 지원하지 않습니다. Chrome·Edge·Safari를 사용하세요.", true);
    return;
  }
  if (recognizer) {
    const wasSame = listeningLang === lang;
    recognizer.stop();
    if (wasSame) return;
  }
  speechSynthesis?.cancel();

  const box = $(lang === "ko" ? "textKo" : "textAr");
  const mic = $(lang === "ko" ? "micKo" : "micAr");
  const r = new Recognition();
  r.lang = LANGS[lang].speech;
  r.interimResults = true;
  r.continuous = false;
  let finalText = "";

  r.onresult = (e) => {
    let interim = "";
    finalText = "";
    for (const res of e.results) {
      if (res.isFinal) finalText += res[0].transcript;
      else interim += res[0].transcript;
    }
    box.value = finalText + interim;
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed") setStatus("마이크 권한을 허용해 주세요.", true);
    else if (e.error !== "no-speech" && e.error !== "aborted") setStatus(`음성 인식 오류: ${e.error}`, true);
  };
  r.onend = () => {
    mic.classList.remove("listening");
    recognizer = null;
    listeningLang = null;
    const text = box.value.trim();
    if (text) submit(lang);
  };

  recognizer = r;
  listeningLang = lang;
  box.value = "";
  mic.classList.add("listening");
  setStatus(lang === "ko" ? "듣는 중…" : "أستمع…");
  r.start();
}

// ---------- UI ----------
function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.toggle("err", isError);
}

function bubble(log, cls, lang, main, sub, note) {
  const div = document.createElement("div");
  div.className = `bubble ${cls}`;
  div.lang = lang;
  div.dir = lang === "ar" ? "rtl" : "ltr";
  const m = document.createElement("div");
  m.className = "main";
  m.textContent = main;
  div.append(m);
  if (sub) {
    const s = document.createElement("div");
    s.className = "sub";
    s.textContent = sub;
    s.dir = "ltr";
    div.append(s);
  }
  if (note) {
    const n = document.createElement("div");
    n.className = "note";
    n.textContent = `💡 ${note}`;
    n.dir = "ltr";
    div.append(n);
  }
  log.append(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function addReplay(div, text, lang) {
  const btn = document.createElement("button");
  btn.className = "replay";
  btn.textContent = "🔊";
  btn.title = "다시 듣기";
  btn.onclick = () => speak(text, lang);
  div.querySelector(".main").append(" ", btn);
}

let busy = false;
async function submit(from) {
  const box = $(from === "ko" ? "textKo" : "textAr");
  const text = box.value.trim();
  if (!text || busy) return;
  if (!settings.apiKey) {
    setStatus("먼저 ⚙ 설정에서 API 키를 입력하세요.", true);
    $("settings").showModal();
    return;
  }
  busy = true;
  box.value = "";

  const ownLog = $(from === "ko" ? "logKo" : "logAr");
  const otherLog = $(from === "ko" ? "logAr" : "logKo");
  bubble(ownLog, "me", from, text);
  const pending = bubble(otherLog, "them pending", from === "ko" ? "ar" : "ko", "…");
  setStatus("통역 중…");

  try {
    const r = await translate(from, text);
    pending.remove();
    // The listener sees only the translation; Hangul pronunciation is for the Korean side.
    const shown = bubble(otherLog, "them", r.to, r.translation, "", r.to === "ko" ? r.note : "");
    addReplay(shown, r.translation, r.to);
    // Korean speaker also sees how the Arabic reads, and any nuance note.
    if (r.to === "ar") {
      bubble(ownLog, "them", "ar", r.translation, r.pronunciation, r.note);
      addReplay(ownLog.lastElementChild, r.translation, "ar");
    }
    if (settings.autoSpeak) speak(r.translation, r.to);
    setStatus("");
  } catch (err) {
    pending.remove();
    box.value = text;
    setStatus(describeError(err), true);
  } finally {
    busy = false;
  }
}

function init() {
  loadSettingsForm();

  for (const p of PHRASES) {
    const b = document.createElement("button");
    b.textContent = p;
    b.onclick = () => { $("textKo").value = p; submit("ko"); };
    $("phrases").append(b);
  }

  $("micKo").onclick = () => startListening("ko");
  $("micAr").onclick = () => startListening("ar");
  $("sendKo").onclick = () => submit("ko");
  $("sendAr").onclick = () => submit("ar");
  for (const [id, lang] of [["textKo", "ko"], ["textAr", "ar"]]) {
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(lang); }
    });
  }

  $("autoSpeak").onchange = (e) => {
    settings.autoSpeak = e.target.checked;
    store.set("si.autoSpeak", settings.autoSpeak ? "1" : "0");
  };
  $("faceBtn").onclick = () => document.body.classList.toggle("face");
  $("settingsBtn").onclick = () => { loadSettingsForm(); $("settings").showModal(); };
  $("settings").addEventListener("close", () => {
    const v = $("settings").returnValue;
    if (v === "ok") saveSettingsForm();
    if (v === "clear") {
      history.length = 0;
      $("logKo").replaceChildren();
      $("logAr").replaceChildren();
    }
  });

  if (!settings.apiKey) setStatus("⚙ 설정에서 Anthropic API 키를 입력하세요.");
}

init();
