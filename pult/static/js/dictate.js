// Pult: diktování připomínek. Zapneš mikrofon (D), pouštíš si video, zastavuješ, mluvíš, kreslíš.
// Nahrává se pořád, ale na server odchází jen úsek, ve kterém se mluvilo (konec úseku = chvíle ticha).
// K úseku se zapisuje, kde ve videu člověk zrovna byl, takže server přepis vloží jako komentář
// přesně ke snímku, kde začal mluvit. Přepis dělá Whisper na počítači s Pultem, nic nejde na internet.
import { $, S, api, clientId, toast, emit, on, dbg, store } from "./core.js";
import * as P from "./player.js";

const st = { on: false, stream: null, ctx: null, proc: null, seg: null, started: 0, sr: 48000,
  floor: -60, speechMs: 0, quietMs: 0, onset: 0, pending: new Set(), uiTimer: 0 };
const BUF = 2048;  // vzorků na jedno zpracování (~43 ms)

const dict = () => (S.settings && S.settings.dictation) || null;
export const isOn = () => st.on;
export const busy = () => st.on || st.pending.size > 0;

export function toggle() { st.on ? stop() : start(); }

async function start() {
  if (!S.batch) return toast("Nejdřív otevři dávku.");
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !AC) {
    toast("Mikrofon prohlížeč pustí jen na zabezpečené adrese (https). Postup je v Nastavení › Diktování.", { ms: 6000 });
    emit("open-settings", "dictation");
    return;
  }
  const d = dict();
  if (!d || !d.ready) return toast((d && d.reason) || "Diktování není připravené. Řekni Claudovi „zapni v Pultu diktování“.", { ms: 6000, error: true });
  if (!S.me.name) { emit("need-name"); return; }
  st.ctx = new AC();  // hned při kliknutí: iPad jinak zvuk nepustí
  try {
    st.stream = await openMic();
  } catch (e) {
    try { st.ctx.close(); } catch {}
    st.ctx = null;
    return toast(e && e.name === "NotAllowedError" ? "Prohlížeč nepovolil mikrofon. Povol ho u adresy Pultu (ikona zámku vlevo v adresním řádku)." : "Mikrofon nejde zapnout: " + (e && e.message), { error: true, ms: 6000 });
  }
  st.on = true;
  api("POST", "/api/dict-claim", { from: clientId, by: S.me.name }).catch(() => {});  // tvoje další zařízení diktování vypnou
  st.started = performance.now();
  if (st.ctx.state === "suspended") await st.ctx.resume().catch(() => {});
  st.sr = st.ctx.sampleRate;
  // přímo vzorky z mikrofonu: přesný čas každého vzorku (nahrávač prohlížeče na začátku úseků ztrácí zvuk)
  const src = st.ctx.createMediaStreamSource(st.stream);
  st.proc = st.ctx.createScriptProcessor(BUF, 1, 1);
  st.proc.onaudioprocess = (e) => onAudio(e.inputBuffer.getChannelData(0));
  src.connect(st.proc);
  st.proc.connect(st.ctx.destination);  // výstup je ticho, jen aby zpracování běželo
  newSegment();
  st.uiTimer = setInterval(() => timerUi(performance.now()), 250);
  api("POST", "/api/dictation/warm", {}).catch(() => {});  // model se načte, zatímco člověk začne mluvit
  ui();
  if (!seenHint()) toast("Diktuji. Mluv, kdy chceš: přepis se objeví v připomínkách u snímku, kde začneš mluvit. Vypneš klávesou D. Nejlíp se sluchátky.", { ms: 6000 });
}
// Mikrofon: Bluetooth sluchátka (AirPods) při zapnutém mikrofonu přepnou do režimu hovoru a hrají
// roboticky a v nízké kvalitě. Proto se diktuje do vestavěného mikrofonu, když je k dispozici
// (Nastavení › Diktování › Mikrofon to umí změnit). Volba se pamatuje v prohlížeči (pult.mic).
const AUDIO = { echoCancellation: true, noiseSuppression: false, autoGainControl: true, channelCount: 1 };
export const BT_MIC = /airpods|bluetooth|headset|hands-?free|buds|beats|bose|jabra|wh-1000|wf-1000|hfp/i;
const BUILTIN_MIC = /macbook|built-?in|vestav|intern|ipad|iphone (micro|mikro)/i;
export async function mics() {
  try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "communications"); } catch { return []; }
}
async function openMic() {
  const want = store.get("mic", "auto");
  const open = (id) => navigator.mediaDevices.getUserMedia({ audio: id ? { ...AUDIO, deviceId: { exact: id } } : AUDIO });
  let list = await mics();
  if (want !== "auto" && want !== "default" && list.some((d) => d.deviceId === want)) return open(want).catch(() => open());
  if (want === "default") return open();
  // automaticky: bez názvů (prohlížeč je ukáže až po prvním povolení) nejdřív otevřít výchozí a zjistit, co to je
  let s = null;
  if (!list.some((d) => d.label)) { s = await open(); list = await mics(); }
  const def = list.find((d) => d.deviceId === "default") || list[0];
  const curLabel = s ? ((s.getAudioTracks()[0] || {}).label || "") : (def ? def.label : "");
  const builtin = list.find((d) => d.deviceId !== "default" && BUILTIN_MIC.test(d.label) && !BT_MIC.test(d.label));
  if (BT_MIC.test(curLabel) && builtin) {
    if (s) s.getTracks().forEach((t) => t.stop());
    dbg("dict: mikrofon " + builtin.label + " místo " + curLabel);
    if (!store.get("micHint", false)) { store.set("micHint", true); toast(`Diktuju do mikrofonu ${builtin.label}, ne do sluchátek: AirPods by jinak přepnuly do režimu hovoru a hrály roboticky. Změníš v Nastavení › Diktování.`, { ms: 7000 }); }
    return open(builtin.deviceId).catch(() => open());
  }
  return s || open();
}
function seenHint() { try { const v = localStorage.getItem("pult.dictHint"); localStorage.setItem("pult.dictHint", "1"); return v; } catch { return "1"; } }

export async function stop() {
  if (!st.on) return;
  st.on = false;
  clearInterval(st.uiTimer);
  try { st.proc.onaudioprocess = null; st.proc.disconnect(); } catch {}
  closeSegment();
  try { st.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { st.ctx.close(); } catch {}
  st.stream = st.ctx = st.proc = null;
  ui();
}

// ---------- úseky ----------
function where() {
  const it = P.item();
  return { n: S.n, v: it && it.kind === "video" ? P.vid.currentTime : 0, p: !!(it && it.kind === "video" && !P.vid.paused && !P.vid.ended), r: S.rate || 1 };
}
function newSegment() {
  st.seg = { id: Math.random().toString(36).slice(2, 12), pcm: [], samples: 0, log: [{ t: 0, ...where() }], onsets: [], speech: false, bid: S.batch && S.batch.id };
  st.speechMs = st.quietMs = 0;
}
function closeSegment() {
  const seg = st.seg;
  st.seg = null;
  if (seg && seg.speech && seg.samples) upload(seg);
}
function logPosition(seg, t) {
  const w = where(), lastE = seg.log[seg.log.length - 1];
  const predicted = lastE.p ? lastE.v + ((t - lastE.t) / 1000) * lastE.r : lastE.v;
  if (w.n !== lastE.n || w.p !== lastE.p || w.r !== lastE.r || Math.abs(w.v - predicted) > 0.12) seg.log.push({ t: Math.round(t), ...w });
}

// každých ~43 ms: uložit vzorky, změřit hlasitost (kdy se mluví; práh se přizpůsobí hluku v místnosti)
function onAudio(data) {
  if (!st.on) return;
  if (!st.seg) newSegment();
  let seg = st.seg;
  if (S.batch && seg.bid !== S.batch.id) { closeSegment(); newSegment(); seg = st.seg; }
  const t = (seg.samples / st.sr) * 1000, dt = (data.length / st.sr) * 1000;
  logPosition(seg, t);
  seg.pcm.push(new Float32Array(data));
  seg.samples += data.length;
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  const db = 10 * Math.log10(sum / data.length + 1e-12);
  st.floor = db < st.floor ? db : st.floor + (db - st.floor) * 0.003;
  const talking = db > Math.max(-52, Math.min(-28, st.floor + 14));
  if (talking) {
    if (st.speechMs === 0) st.onset = t;  // možný začátek věty
    st.speechMs += dt; st.quietMs = 0;
    if (st.speechMs > 400) { seg.speech = true; if (seg.onsets[seg.onsets.length - 1] !== Math.round(st.onset)) seg.onsets.push(Math.round(st.onset)); }
  } else { st.quietMs += dt; if (st.quietMs > 600) st.speechMs = 0; }
  const len = t + dt;
  // úsek uzavřít po delší pauze (2,5 s), ať se věty netrhají; nejdéle po 75 s; dlouhé ticho zahodit
  if ((seg.speech && st.quietMs > 2500 && len > 3000) || (len > 40000 && st.quietMs > 700) || len > 75000 || (!seg.speech && len > 15000)) {
    closeSegment();
  }
  const lvl = Math.max(0, Math.min(1, (db - st.floor) / 30));
  for (const x of [$("#micBtn"), $("#kMic")]) x.style.setProperty("--lvl", talking ? lvl.toFixed(2) : "0");
}

// WAV 16 kHz mono (to Whisper chce). Převzorkuje prohlížeč přes OfflineAudioContext, který má pořádný
// filtr: prosté vynechávání vzorků by do řeči zaneslo zkreslení (aliasing) a přepis by byl horší.
async function wav16k(seg) {
  const all = new Float32Array(seg.samples);
  let o = 0;
  for (const c of seg.pcm) { all.set(c, o); o += c.length; }
  let pcm = all;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (st.sr !== 16000 && OAC) {
    try {
      const n = Math.ceil((all.length * 16000) / st.sr);
      const off = new OAC(1, n, 16000);
      const buf = off.createBuffer(1, all.length, st.sr);
      buf.getChannelData(0).set(all);
      const src = off.createBufferSource();
      src.buffer = buf; src.connect(off.destination); src.start();
      pcm = (await off.startRendering()).getChannelData(0);
    } catch { pcm = null; }
  }
  if (!pcm || pcm === all && st.sr !== 16000) return wavAt(all, st.sr);  // bez převzorkování: pošle se v původní frekvenci, server převede ffmpegem
  return wavAt(pcm, 16000);
}
function wavAt(pcm, rate) {
  const n = pcm.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (i, s) => { for (let k = 0; k < s.length; k++) v.setUint8(i + k, s.charCodeAt(k)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: "audio/wav" });
}

async function upload(seg) {
  if (!seg.bid) return;
  st.pending.add(seg.id);
  ui();
  try {
    const blob = await wav16k(seg);
    seg.pcm = null;
    const audio = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
    dbg("dict upload", seg.id, Math.round(blob.size / 1024) + " kB", seg.log.length, seg.onsets);
    await api("POST", `/api/dictation/${encodeURIComponent(seg.bid)}`, { id: seg.id, audio, log: seg.log, onsets: seg.onsets, by: S.me.name, byc: S.me.color, from: clientId });
  } catch (e) {
    st.pending.delete(seg.id);
    toast("Diktát se nepodařilo poslat: " + e.message, { error: true });
    ui();
  }
}

// zprávy ze serveru (přepis hotový / chyba)
export function onMessage(m) {
  if (m.state === "queued" || !st.pending.has(m.id)) return;
  st.pending.delete(m.id);
  if (m.state === "error") toast("Přepis diktátu selhal: " + (m.error || "neznámá chyba"), { error: true, ms: 6000 });
  else if (!m.count) toast("V diktátu jsem nerozpoznal žádná slova.", { ms: 2500 });
  ui();
}

// před odesláním revize: dokončit nahrávání a počkat na přepis
export async function flush(maxMs = 120000) {
  if (st.on) stop();
  const t0 = performance.now();
  while (st.pending.size && performance.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 200));
  return st.pending.size === 0;
}

// ---------- vzhled ----------
let lastSec = -1;
function timerUi(now) {
  const s = Math.floor((now - st.started) / 1000);
  if (s === lastSec) return;
  lastSec = s;
  $("#dictTime").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
export function ui() {
  const b = $("#micBtn"), pill = $("#dictPill");
  for (const x of [b, $("#kMic")]) {
    x.classList.toggle("on", st.on);
    x.title = st.on ? "Diktuji · vypnout (D)" : "Diktovat připomínky mikrofonem (D)";
  }
  $("#micLabel").textContent = st.on ? "Diktuji" : st.pending.size ? "Přepisuji…" : "Diktovat";
  pill.hidden = !st.on && !st.pending.size;
  pill.classList.toggle("rec", st.on);
  $("#dictState").textContent = st.on ? "Diktuji" : "Přepisuji…";
  $("#dictTime").hidden = !st.on;
  $("#dictPend").textContent = st.on && st.pending.size ? `· přepisuji ${st.pending.size}` : "";
  if (!st.on) b.style.setProperty("--lvl", "0");
}
$("#micBtn").onclick = toggle;
$("#kMic").onclick = toggle;
$("#dictPill").onclick = () => { if (st.on) stop(); };
on("batch-left", () => { if (st.on) stop(); });
ui();

// Diktuješ na jiném svém zařízení (stejné jméno): tady mikrofon vypnout, ať nevznikají dvojité přepisy.
export function onClaim(m) {
  if (!st.on || !m || m.from === clientId || !S.me.name || m.by !== S.me.name) return;
  stop();
  toast("Diktuješ na jiném zařízení, tady jsem mikrofon vypnul.", { ms: 3500 });
}
