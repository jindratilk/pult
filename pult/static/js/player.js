// Pult: přehrávač. Video je jediné hodiny: nikdy se mu za běhu nemění rychlost kvůli synchronizaci
// (WebKit se při každé změně rychlosti i skoku na chvíli zasekne). Snímky se počítají z pevné
// frekvence náhledu, takže kresby sedí přesně na snímek, který člověk viděl.
import { $, $$, S, store, api, clientId, clock, emit, on, toast, fmtTC, frameOf, fpsOf, icon, dbg } from "./core.js";
import { OVERLAYS, overlaySvg } from "./zones.js";

export const vid = $("#vid"), img = $("#img"), wrap = $("#wrap"), viewport = $("#viewport"), stage = $("#stage"), cv = $("#cv");
export const hooks = { goTo: null, openBatch: null };
const RATES = [1, 1.5, 2];

export const item = () => S.batch && S.batch.items.find((i) => i.n === S.n);
export const isVideo = () => { const it = item(); return !!it && it.kind === "video" && it.state === "ready"; };
export const fps = () => fpsOf(item());
export const frames = () => { const it = item(); return Math.max(1, (it && it.frames) || Math.floor(((it && it.duration) || vid.duration || 0) * fps())); };
export const curFrame = () => (isVideo() ? Math.min(frameOf(vid.currentTime, fps()), frames() - 1) : 0);
export const curKey = () => `${S.n}:${curFrame()}`;
export const media = (rel) => `/media/${encodeURIComponent(S.batch.id)}/${rel.split("/").map(encodeURIComponent).join("/")}`;

let token = 0;
S.zoom = { k: 1, x: 0, y: 0 };

function waitFor(el, ev, ms) {
  return new Promise((res) => {
    const done = (e) => { clearTimeout(t); el.removeEventListener(ev, done); el.removeEventListener("error", done); res(e && e.type); };
    const t = setTimeout(() => done({ type: "timeout" }), ms);
    el.addEventListener(ev, done, { once: true });
    el.addEventListener("error", done, { once: true });
  });
}

// ---------- zobrazení položky ----------
export async function showItem() {
  const my = ++token, it = item();
  clearLoading();
  stopReverse(false);
  if (!vid.paused) vid.pause();
  resetZoom(false);
  $("#prep").hidden = true;
  if (!it || it.state !== "ready") {
    vid.hidden = img.hidden = true;
    wrap.hidden = true;
    showPrep(it);
    setTransportKind(it && it.kind);
    emit("frame");
    return;
  }
  wrap.hidden = false;
  setTransportKind(it.kind);
  if (it.kind === "video") {
    img.hidden = true; img.removeAttribute("src");
    vid.hidden = false;
    const src = media(it.file);
    if (vid.getAttribute("src") !== src) {
      vid.src = src;
      const r = await waitFor(vid, "loadedmetadata", 15000);
      if (my !== token) return;
      if (r !== "loadedmetadata") return showPrep({ ...it, state: "error", error: r === "timeout" ? "Video se nenačítá (vypršel čas)." : "Prohlížeč video nepřehraje." });
    }
    vid.playbackRate = S.rate; setPitch();
    seekFrame(0, false);
  } else {
    vid.hidden = true;
    if (vid.getAttribute("src")) { vid.removeAttribute("src"); vid.load(); }
    img.hidden = false;
    const src = media(it.file);
    if (img.getAttribute("src") !== src) {
      img.src = src;
      if (!img.complete) await waitFor(img, "load", 15000);
      if (my !== token) return;
    }
  }
  layout();
  updateTime();
  drawMarks();
  emit("frame");
}

function showPrep(it) {
  const p = $("#prep");
  if (!it) { p.hidden = true; return; }
  p.hidden = false;
  const err = it.state === "error";
  p.classList.toggle("err", err);
  $("#prepText").textContent = err ? "Tuhle položku se nepodařilo připravit" : it.state === "processing" ? "Připravuji náhled…" : "Čeká na přípravu…";
  $("#prepSub").textContent = err ? (it.error || "") : it.name || "";
  setPrepProgress(it.progress || 0);
}
export function setPrepProgress(p) { $("#prepArc").style.strokeDashoffset = String(97.4 * (1 - Math.max(0, Math.min(1, p)))); }

function setTransportKind(kind) {
  $("#transport").classList.toggle("img", kind !== "video");
  $("#kbar").classList.toggle("img", kind !== "video");
}

export function layout() {
  const it = item();
  if (!it || wrap.hidden) return;
  const w = (it.kind === "image" && img.naturalWidth) || it.width || vid.videoWidth || 16;
  const h = (it.kind === "image" && img.naturalHeight) || it.height || vid.videoHeight || 9;
  const kino = S.kino, narrow = innerWidth < 760;
  const padL = kino ? 0 : narrow ? 52 : 72, pad = kino ? 0 : 20;
  const vw = viewport.clientWidth - padL - pad, vh = viewport.clientHeight - pad * 2;
  let k = Math.max(0.01, Math.min(vw / w, vh / h));
  // s překryvem sítě se širší video (4:5, 1:1, 16:9) vejde do telefonu na šířku: zmenšit tak, aby byl vidět celý telefon
  if (OVERLAYS[S.zones] && w / h >= FILL_MAX) k = Math.max(0.01, Math.min(vw * 978 / 1080 / w, vh * 978 / 1920 / w));
  const W = Math.round(w * k), H = Math.round(h * k);
  wrap.style.width = W + "px"; wrap.style.height = H + "px";
  wrap.style.marginLeft = (padL - pad) + "px";
  sizeCanvas();
  applyZoom();
  drawZones();
}
export function sizeCanvas() {
  const W = wrap.clientWidth, H = wrap.clientHeight, dpr = window.devicePixelRatio || 1;
  const k = Math.min(S.zoom.k, 4096 / Math.max(1, W * dpr), 4096 / Math.max(1, H * dpr));
  const pw = Math.round(W * dpr * k), ph = Math.round(H * dpr * k);
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  emit("redraw");
}
window.addEventListener("resize", () => layout());
new ResizeObserver(() => layout()).observe(viewport);

// ---------- přehrávání ----------
export function setPitch() {
  // „Zachovat výšku tónu“ zní ve WebKitu po startu roboticky; při 1× ho nepotřebujeme
  const keep = S.rate !== 1;
  try { vid.preservesPitch = keep; vid.webkitPreservesPitch = keep; vid.mozPreservesPitch = keep; } catch {}
}
function safePlay() {
  const p = vid.play();
  if (p && p.catch) p.catch((e) => {
    if (e && e.name === "NotAllowedError" && !vid.muted) {
      vid.muted = true; updateVolume();
      vid.play().catch(() => {});
      toast("Prohlížeč pustil video bez zvuku. Zvuk zapneš tlačítkem reproduktoru nebo klávesou M.");
    }
  });
}
export function play(pub = true) {
  if (!isVideo()) return;
  stopReverse(false);
  emit("before-play");
  if (vid.ended || curFrame() >= frames() - 1) seekFrame(0, false);
  safePlay();
  if (pub) publish({ playing: true });
}
export function pause(pub = true) {
  if (!isVideo()) return;
  if (rev) return stopReverse(true, pub);
  vid.pause();
  seekFrame(curFrame(), false);
  if (pub) publish({ playing: false });
}
export function toggle() { if (isVideo()) vid.paused && !rev ? play() : pause(); }
export function seekFrame(f, pub = true) {
  if (!isVideo()) return;
  if (rev) stopReverse(false);
  f = Math.max(0, Math.min(Math.round(f), frames() - 1));
  vid.currentTime = (f + 0.5) / fps();
  updateTime();
  if (pub) publish();
}
export function step(d) { if (!isVideo()) return; emit("before-play"); if (!vid.paused) vid.pause(); seekFrame(curFrame() + d); }
export function jump(sec) {
  if (!isVideo()) return;
  const t = Math.max(0, Math.min(vid.currentTime + sec, (vid.duration || 0) - 0.5 / fps()));
  if (vid.paused) seekFrame(frameOf(t, fps()));
  else { vid.currentTime = t; publish(); }
}
export function goEdge(end) { if (!isVideo()) return; if (!vid.paused) vid.pause(); seekFrame(end ? frames() - 1 : 0); }

// ---------- J / K / L jako ve střižně ----------
// L: dopředu 1× → 1,5× → 2× → 1×. J: pozpátku 1× → 2× → 1×. K: stop.
// Pozpátku prohlížeč video přehrát neumí, takže se plynule převíjí skoky po snímcích (bez zvuku).
let rev = null;
const rateText = (r) => String(r).replace(".", ",") + "×";
export const reversing = () => !!rev;
export function shuttle(dir) {
  if (!isVideo()) return;
  if (dir > 0) {
    const from = rev ? 0 : vid.paused ? 0 : S.rate;
    stopReverse(false);
    setRate(from === 1 ? 1.5 : from === 1.5 ? 2 : 1);
    if (vid.paused) play();
    toast(`▶ ${rateText(S.rate)}`, { ms: 900 });
  } else {
    if (rev) rev.rate = rev.rate === 1 ? 2 : 1;
    else startReverse();
    toast(`◀ pozpátku ${rateText(rev.rate)}`, { ms: 900 });
  }
  kbarPoke();
}
function startReverse() {
  emit("before-play");
  if (!vid.paused) vid.pause();
  rev = { rate: 1, t: vid.currentTime, last: performance.now(), busy: false, raf: 0, pubAt: 0 };
  const tick = (now) => {
    if (!rev) return;
    rev.t = Math.max(0, rev.t - ((now - rev.last) / 1000) * rev.rate);
    rev.last = now;
    if (!rev.busy) { rev.busy = true; vid.currentTime = rev.t; }  // další skok až po dokončení předchozího
    updateTime();
    if (now - rev.pubAt > 250) { rev.pubAt = now; publish({ playing: false }); }
    if (rev.t <= 0) return stopReverse(true);
    rev.raf = requestAnimationFrame(tick);
  };
  rev.raf = requestAnimationFrame(tick);
  $("#playBtn").classList.add("rev");
}
vid.addEventListener("seeked", () => { if (rev) rev.busy = false; });
export function stopReverse(snap = true, pub = true) {
  if (!rev) return;
  cancelAnimationFrame(rev.raf);
  const t = rev.t;
  rev = null;
  $("#playBtn").classList.remove("rev");
  if (snap) seekFrame(frameOf(t, fps()), pub);
}

export function setRate(r, pub = true) {
  S.rate = r;
  vid.defaultPlaybackRate = r; vid.playbackRate = r;
  setPitch();
  $$(".rates button").forEach((b) => b.classList.toggle("on", +b.dataset.r === r));
  if (pub) publish();
}
export function rateStep(d) { const i = RATES.indexOf(S.rate); setRate(RATES[Math.max(0, Math.min(RATES.length - 1, (i < 0 ? 0 : i) + d))]); toast(`Rychlost ${rateText(S.rate)}`, { ms: 1000 }); }
$$(".rates button").forEach((b) => (b.onclick = () => { setRate(+b.dataset.r); kbarPoke(); }));

export function setLoop(v) { S.loop = v; store.set("loop", v); vid.loop = v; $("#loopBtn").classList.toggle("on", v); }
export function setStopAtNotes(v) { S.stopAtNotes = v; store.set("stopAtNotes", v); $("#stopNotesBtn").classList.toggle("on", v); $("#stopNotesBtn").title = v ? "Zastavuje na připomínkách (zapnuto)" : "Zastavit na připomínkách"; }
$("#loopBtn").onclick = () => { setLoop(!S.loop); toast(S.loop ? "Smyčka zapnutá" : "Smyčka vypnutá", { ms: 1200 }); };
$("#stopNotesBtn").onclick = () => { setStopAtNotes(!S.stopAtNotes); toast(S.stopAtNotes ? "Přehrávání se zastaví na každé připomínce" : "Přehrávání se na připomínkách nezastavuje", { ms: 1600 }); };

// hlasitost
vid.volume = store.get("volume", 1);
vid.muted = store.get("muted", false);
export function updateVolume() {
  $("#muteBtn").innerHTML = icon(vid.muted || vid.volume === 0 ? "mute" : "vol");
  $("#volume").value = vid.muted ? 0 : vid.volume;
  store.set("volume", vid.volume); store.set("muted", vid.muted);
}
export function toggleMute() { vid.muted = !vid.muted; if (!vid.muted && vid.volume === 0) vid.volume = 1; updateVolume(); }
$("#muteBtn").onclick = toggleMute;
$("#volume").oninput = (e) => { vid.volume = +e.target.value; vid.muted = vid.volume === 0; updateVolume(); };

// ---------- čas a časová osa ----------
export function updateTime() {
  const it = item();
  if (!it || it.kind !== "video") { $("#time").textContent = ""; $("#dur").textContent = ""; return; }
  const f = fps(), d = vid.duration || it.duration || 0, t = vid.currentTime;
  const pct = d ? Math.min(100, (t / d) * 100) : 0;
  $("#time").textContent = fmtTC(t, f);
  $("#dur").textContent = fmtTC(Math.max(0, d - 0.5 / f), f);
  for (const tr of [$("#track"), $("#kTrack")]) { $(".fill", tr).style.width = pct + "%"; $(".head", tr).style.left = pct + "%"; }
  const playing = !vid.paused;
  const want = playing ? "pause" : "play";
  if ($("#playBtn").dataset.i !== want) { $("#playBtn").dataset.i = want; $("#playBtn").innerHTML = icon(want); $("#kPlay").innerHTML = icon(want); }
  if (S.kino) { $("#kTime").textContent = fmtTC(t, f); $("#kDur").textContent = fmtTC(Math.max(0, d - 0.5 / f), f); }
}
function updateBuffered() {
  const d = vid.duration || 0;
  let end = 0;
  for (let i = 0; i < vid.buffered.length; i++) if (vid.buffered.start(i) <= vid.currentTime + 0.5) end = Math.max(end, vid.buffered.end(i));
  $("#track .buffered").style.width = d ? (end / d) * 100 + "%" : "0";
}
vid.addEventListener("progress", updateBuffered);

// značky připomínek na časové ose (barva autora; tečka nahoře = komentář)
export function noteFrames() {
  const out = new Map();
  for (const s of Object.values(S.notes.strokes)) if (s.n === S.n) out.set(s.frame, out.get(s.frame) || { c: s.byc, kind: "d" });
  for (const c of Object.values(S.notes.comments)) if (c.n === S.n && c.frame != null && !out.has(c.frame)) out.set(c.frame, { c: c.byc, kind: "c" });
  return out;
}
let markFrames = [];
export function drawMarks() {
  const it = item(), map = isVideo() ? noteFrames() : new Map();
  markFrames = [...map.keys()].sort((a, b) => a - b);
  const total = frames(), cf = vid.paused ? curFrame() : -1;
  for (const tr of [$("#track"), $("#kTrack")]) {
    const box = $(".marks", tr);
    box.innerHTML = "";
    if (!it || !isVideo()) continue;
    for (const [f, m] of map) {
      const el = document.createElement("div");
      el.className = "mk" + (m.kind === "c" ? " cm" : "") + (f === cf ? " cur" : "");
      el.style.left = ((f + 0.5) / total) * 100 + "%";
      el.style.setProperty("--c", m.c || "#f2f2f1");
      el.title = fmtTC((f + 0.5) / fps(), fps());
      el.onpointerdown = (e) => { e.stopPropagation(); e.preventDefault(); emit("before-play"); vid.pause(); seekFrame(f); };
      box.appendChild(el);
    }
  }
}
export function nextNote(d) {
  if (!isVideo() || !markFrames.length) return false;
  const cf = curFrame();
  const f = d > 0 ? markFrames.find((x) => x > cf) : [...markFrames].reverse().find((x) => x < cf);
  if (f == null) return false;
  emit("before-play"); vid.pause(); seekFrame(f);
  return true;
}

function scrubber(track) {
  let on = false, was = false, raf = 0, lastX = 0;
  const tip = $(".hover", track);
  const tAt = (x) => { const r = track.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / r.width)) * (vid.duration || 0); };
  let pubAt = 0;
  const apply = () => {
    raf = 0; vid.currentTime = Math.min(tAt(lastX), (vid.duration || 0) - 0.5 / fps()); updateTime(); emit("frame");
    if (Date.now() - pubAt > 120) { pubAt = Date.now(); publish({ playing: false }); }
  };
  track.addEventListener("pointerdown", (e) => {
    if (!isVideo() || e.button > 0) return;
    e.preventDefault();
    emit("before-play");
    on = true; was = !vid.paused; lastX = e.clientX;
    track.classList.add("drag");
    try { track.setPointerCapture(e.pointerId); } catch {}
    vid.pause();
    apply();
  });
  track.addEventListener("pointermove", (e) => {
    if (tip && e.pointerType === "mouse" && isVideo()) {
      const r = track.getBoundingClientRect();
      tip.hidden = false; tip.style.left = Math.min(r.width, Math.max(0, e.clientX - r.left)) + "px";
      tip.textContent = fmtTC(tAt(e.clientX), fps());
    }
    if (!on) return;
    lastX = e.clientX;
    if (!raf) raf = requestAnimationFrame(apply);
  });
  track.addEventListener("pointerleave", () => { if (tip) tip.hidden = true; });
  const up = () => {
    if (!on) return;
    on = false; track.classList.remove("drag");
    cancelAnimationFrame(raf); raf = 0;
    seekFrame(frameOf(Math.min(tAt(lastX), (vid.duration || 0) - 0.5 / fps()), fps()), false);
    if (was) play(); else publish({ playing: false });
  };
  track.addEventListener("pointerup", up);
  track.addEventListener("pointercancel", up);
}
scrubber($("#track"));
scrubber($("#kTrack"));

// ---------- smyčka snímků při přehrávání ----------
S.shownFrame = -1;
function onVideoFrame(now, meta) {
  vfcPending = false;
  if (!isVideo()) return;
  // mediaTime je přesný čas zobrazeného snímku: zaokrouhlit (floor by u 29,97 fps občas ukázal o snímek dřív)
  const f = Math.min(meta ? Math.round(meta.mediaTime * fps()) : frameOf(vid.currentTime, fps()), frames() - 1);
  if (f !== S.shownFrame) {
    const prev = S.shownFrame;
    S.shownFrame = f;
    if (S.stopAtNotes && !vid.paused && prev >= 0 && f > prev) {
      const hit = markFrames.find((x) => x > prev && x <= f);
      if (hit != null) { vid.pause(); seekFrame(hit, false); publish({ playing: false }); emit("frame"); updateTime(); return; }
    }
    emit("frame");
  }
  updateTime();
  if (!vid.paused) loopFrames();
}
let vfcPending = false; // vždy jen jedna čekající smyčka (rychlé pauza/přehrát by jinak pustilo dvě)
function loopFrames() {
  if (vfcPending) return;
  vfcPending = true;
  if (vid.requestVideoFrameCallback) vid.requestVideoFrameCallback(onVideoFrame); else requestAnimationFrame(() => onVideoFrame());
}
vid.addEventListener("play", () => { S.shownFrame = curFrame(); updateTime(); loopFrames(); emit("playstate"); });
vid.addEventListener("pause", () => { updateTime(); drawMarks(); emit("playstate"); emit("frame"); });
vid.addEventListener("seeked", () => { S.shownFrame = curFrame(); updateTime(); if (vid.paused) { drawMarks(); emit("frame"); } clearLoading(); });
vid.addEventListener("ended", () => { updateTime(); emit("playstate"); emit("frame"); });
vid.addEventListener("loadedmetadata", () => { vid.playbackRate = S.rate; setPitch(); vid.loop = S.loop; });

// načítání (jen když opravdu chybí data, ne při každém krátkém zaváhání)
let loadTimer = 0;
function clearLoading() { clearTimeout(loadTimer); loadTimer = 0; $("#loading").hidden = true; }
vid.addEventListener("waiting", () => { clearTimeout(loadTimer); loadTimer = setTimeout(() => { if (!vid.paused || vid.seeking) $("#loading").hidden = false; }, 350); });
for (const ev of ["playing", "canplay", "pause"]) vid.addEventListener(ev, clearLoading);
vid.addEventListener("error", () => { if (item() && item().kind === "video" && vid.getAttribute("src")) showPrep({ ...item(), state: "error", error: `Prohlížeč video nepřehraje (kód ${vid.error && vid.error.code}).` }); });

$("#playBtn").onclick = toggle;
$("#prevF").onclick = () => step(-1);
$("#nextF").onclick = () => step(1);

// ---------- dva prsty na trackpadu: posun playheadu (jako QuickTime); s ⌘/Ctrl nebo sevřením zoom ----------
const wheel = { on: false, t: 0, was: false, timer: 0, pubAt: 0 };
function wheelEnd() {
  wheel.on = false; wheel.on2 = false;
  if (wheel.was) { vid.currentTime = wheel.t; play(); }
  else { seekFrame(frameOf(wheel.t, fps()), false); publish({ playing: false }); }
}
// Chrome stránce neřekne, jestli je zapnuté přirozené posouvání, tak se zeptáme Macu, na kterém Pult běží.
// Po návratu do okna znovu, kdyby se to mezitím přepnulo v Nastavení systému.
let macNatural = null;
if (!("webkitDirectionInvertedFromDevice" in WheelEvent.prototype)) {
  const readNatural = () => api("GET", "/api/scroll-direction").then((r) => { macNatural = r.natural; }).catch(() => {});
  readNatural();
  window.addEventListener("focus", readNatural);
}
document.addEventListener("wheel", (e) => {
  if (!e.target.closest || !e.target.closest("#stage, #transport")) return;
  const it = item();
  if (!it || it.state !== "ready" || $(".scrim")) return;
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  if ((e.ctrlKey || e.metaKey) && e.target.closest("#stage")) {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.01));
    return;
  }
  if (S.zoom.k > 1 && e.target.closest("#stage")) {
    e.preventDefault();
    S.zoom.x -= dx; S.zoom.y -= dy; applyZoom();
    return;
  }
  if (!isVideo() || (!wheel.on && Math.abs(dx) <= Math.abs(dy))) return;
  e.preventDefault(); // jinak by prohlížeč swipem šel na předchozí stránku
  if (!wheel.on) {
    emit("before-play");
    wheel.on = true; wheel.was = !vid.paused; wheel.t = vid.currentTime;
    wheel.dir = store.get("scrubDir", "forward") === "back" ? -1 : 1;  // Nastavení › Přehrávání
    if (wheel.was) vid.pause();
  }
  // prsty doprava = dopředu, ať je přirozené posouvání zapnuté nebo ne
  const finger = ((e.webkitDirectionInvertedFromDevice ?? macNatural) === false ? dx : -dx) * wheel.dir;
  // jako QuickTime: rychlost nezávisí na délce videa. Pomalý pohyb = po snímcích, rychlý tah zrychluje
  // (i u hodinového filmu se dá rychle přejet a pak přesně dojet na snímek)
  const d = vid.duration || 0, dt = Math.min(50, Math.max(4, e.timeStamp - (wheel.ts || 0)));
  wheel.ts = e.timeStamp;
  const v = Math.abs(dx) * 16 / dt;  // px za ~snímek obrazovky
  wheel.v = wheel.on2 ? wheel.v * 0.5 + v * 0.5 : v; wheel.on2 = true;
  const perPx = (1 / (fps() * 4)) * Math.min(50, 1 + Math.pow(wheel.v / 10, 2));
  wheel.t = Math.min(Math.max(0, wheel.t + finger * perPx), Math.max(0, d - 0.5 / fps()));
  vid.currentTime = wheel.t; updateTime(); emit("frame"); kbarPoke();
  const now = Date.now();
  if (now - wheel.pubAt > 120) { wheel.pubAt = now; publish({ playing: false }); }
  clearTimeout(wheel.timer); wheel.timer = setTimeout(wheelEnd, 180);
}, { passive: false });
// Safari: sevření prstů na trackpadu
let gScale = 1;
document.addEventListener("gesturestart", (e) => { if (e.target.closest && e.target.closest("#stage") && !("ontouchstart" in window)) { e.preventDefault(); gScale = 1; } }, { passive: false });
document.addEventListener("gesturechange", (e) => { if (e.target.closest && e.target.closest("#stage") && !("ontouchstart" in window)) { e.preventDefault(); zoomAt(e.clientX, e.clientY, e.scale / gScale); gScale = e.scale; } }, { passive: false });

// ---------- zoom ----------
export function zoomAt(cx, cy, factor) {
  const z = S.zoom, k2 = Math.max(1, Math.min(8, z.k * factor));
  const vr = viewport.getBoundingClientRect();
  const bx = vr.left + wrap.offsetLeft, by = vr.top + wrap.offsetTop;
  const ux = (cx - bx - z.x) / z.k, uy = (cy - by - z.y) / z.k;
  z.x = cx - bx - ux * k2; z.y = cy - by - uy * k2; z.k = k2;
  applyZoom();
  sizeCanvas();
}
export function applyZoom() {
  const z = S.zoom, W = wrap.clientWidth, H = wrap.clientHeight;
  if (z.k <= 1.001) { z.k = 1; z.x = 0; z.y = 0; }
  z.x = Math.min(0, Math.max(W * (1 - z.k), z.x));
  z.y = Math.min(0, Math.max(H * (1 - z.k), z.y));
  wrap.style.transform = z.k === 1 ? "" : `translate(${z.x}px, ${z.y}px) scale(${z.k})`;
}
export function resetZoom(redraw = true) { S.zoom = { k: 1, x: 0, y: 0 }; wrap.style.transform = ""; if (redraw) sizeCanvas(); }

// ---------- překryv sociálních sítí (Reels, TikTok, Shorts) ----------
// Telefon (978 × 1920 z plochy 1080 × 1920): video na výšku ho vyplní a po stranách se ořízne,
// širší video leží přes celou šířku uprostřed. Překryv jde posunout za úchyt nahoře (dvojklik vrátí).
const FILL_MAX = 0.66;
let zonesDy = 0;
export function cycleZones() { S.zones = (S.zones + 1) % OVERLAYS.length; zonesDy = 0; layout(); drawZones(); toast(OVERLAYS[S.zones] ? `Překryv: ${OVERLAYS[S.zones].name}` : "Překryv vypnutý", { ms: 1200 }); }
function drawZones() {
  const z = OVERLAYS[S.zones], box = $("#zones");
  $("#zonesBtn").classList.toggle("on", !!z);
  $("#zonesBtn").title = z ? `Překryv: ${z.name} (G přepne dál)` : "Překryv Instagram Reels, TikTok, YouTube Shorts (G)";
  box.hidden = !z || wrap.hidden;
  if (!z || wrap.hidden) return;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  const fill = W / H < FILL_MAX;
  const bh = fill ? H : (W * 1920) / 978, bw = (bh * 1080) / 1920;
  const bl = (W - bw) / 2, bt = (H - bh) / 2 + zonesDy * bh;
  Object.assign(box.style, { left: bl + "px", top: bt + "px", width: bw + "px", height: bh + "px", right: "auto", bottom: "auto" });
  const u = 1920 / bh, v = { x: -bl * u, y: -bt * u, w: W * u, h: H * u };
  const key = [S.zones, ...Object.values(v).map((x) => Math.round(x))].join(",");
  if (box.dataset.z !== key) {
    box.innerHTML = overlaySvg(z, v) + `<div class="zgrip" title="Posunout překryv (dvojklik vrátí doprostřed)"></div>`;
    box.dataset.z = key;
  }
}
$("#zonesBtn").onclick = cycleZones;
$("#zones").addEventListener("pointerdown", (e) => {
  if (!e.target.closest(".zgrip")) return;
  e.preventDefault(); e.stopPropagation();
  const box = $("#zones"), y0 = e.clientY, d0 = zonesDy, h = box.getBoundingClientRect().height || 1;
  const mv = (ev) => { zonesDy = Math.max(-0.45, Math.min(0.45, d0 + (ev.clientY - y0) / h)); drawZones(); };
  const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); };
  addEventListener("pointermove", mv); addEventListener("pointerup", up);
});
$("#zones").addEventListener("dblclick", (e) => { if (e.target.closest(".zgrip")) { zonesDy = 0; drawZones(); } });

// ---------- kino: jen obraz přes celou obrazovku ----------
let kbarTimer = 0;
export function kbarPoke() {
  if (!S.kino) return;
  $("#kbar").classList.add("show");
  $("#app").classList.remove("idle");
  clearTimeout(kbarTimer);
  kbarTimer = setTimeout(() => {
    if ($("#kbar").matches(":hover") || S.drawing || wheel.on || $("#kTrack").classList.contains("drag")) return kbarPoke();
    $("#kbar").classList.remove("show");
    $("#app").classList.add("idle");
  }, 2200);
}
export function setKino(on, fromBrowser = false) {
  on = !!on;
  if (S.kino === on) return;
  S.kino = on;
  $("#app").classList.toggle("kino", on);
  $("#app").classList.remove("idle");
  if (!fromBrowser) {
    const el = document.documentElement;
    try {
      if (on) { const r = (el.requestFullscreen || el.webkitRequestFullscreen).call(el); if (r && r.catch) r.catch(() => {}); }
      else if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } catch {}
  }
  $("#kCount").textContent = S.batch && S.batch.items.length > 1 ? `${S.n} / ${S.batch.items.length}` : "";
  requestAnimationFrame(() => { layout(); updateTime(); kbarPoke(); });
}
for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) document.addEventListener(ev, () => { if (S.kino && !(document.fullscreenElement || document.webkitFullscreenElement)) setKino(false, true); });
$("#kinoBtn").onclick = () => setKino(true);
$("#kExit").onclick = () => setKino(false);
$("#kPlay").onclick = () => { toggle(); kbarPoke(); };
document.addEventListener("pointermove", (e) => { if (S.kino && e.pointerType === "mouse") kbarPoke(); });
document.addEventListener("pointerdown", () => { if (S.kino) kbarPoke(); });

// ---------- přehrávat spolu (sdílené přehrávání mezi zařízeními a lidmi) ----------
// ---------- posun zvuku (video na iPadu, zvuk z Macu do AirPods) ----------
// Bluetooth sluchátka hrají se zpožděním, které prohlížeč ani macOS nehlásí. Zařízení se zvukem
// proto hraje o avDelay napřed a ven posílá čas, který je právě slyšet.
export const AV_BT_MS = 200;  // doporučeno pro AirPods a jiná Bluetooth sluchátka
S.avDelay = store.get("avDelay", null);  // ms; null = automaticky
S.avAuto = 0; S.avOut = { name: "", bluetooth: false };
export const avDelayMs = () => (S.avDelay == null ? S.avAuto : S.avDelay);
const avOff = () => avDelayMs() / 1000;
let avResync = false;
export async function detectAudioOut() {
  try { S.avOut = await api("GET", "/api/audio-output"); } catch { S.avOut = { name: "", bluetooth: false }; }
  const before = avDelayMs();
  S.avAuto = S.avOut.bluetooth ? AV_BT_MS : 0;
  if (avDelayMs() !== before) avChanged();
  return S.avOut;
}
export function setAvDelay(ms) {
  S.avDelay = ms == null ? null : Math.round(ms);
  store.set("avDelay", S.avDelay);
  avChanged();
}
function avChanged() {
  avResync = true;
  if (S.together && S.leader && isVideo() && !vid.paused) publish();
}
detectAudioOut();
addEventListener("focus", () => detectAudioOut());
setInterval(() => { if (S.together && document.visibilityState === "visible") detectAudioOut(); }, 15000);

export function publish(extra = {}) {
  if (!S.together || !S.batch) return;
  S.leader = true;
  const body = { from: clientId, batch: S.batch.id, n: S.n, t: isVideo() ? vid.currentTime : 0, playing: isVideo() && !vid.paused, rate: S.rate, by: S.me.name, ...extra };
  if (body.playing && isVideo()) body.t = Math.max(0, body.t - avOff() * (S.rate || 1));  // čas, který je teď slyšet
  api("POST", "/api/sync", body).catch(() => {});
}
setInterval(() => { if (S.together && S.leader && isVideo() && !vid.paused && !vid.seeking) publish({ tick: true }); }, 2000);

// Moje další zařízení (stejné jméno) přepínají položky se mnou, i když Spolu není zapnuté.
export function publishFocus() {
  if (!S.batch || !S.me.name) return;
  api("POST", "/api/focus", { from: clientId, by: S.me.name, batch: S.batch.id, n: S.n }).catch(() => {});
}
export function applyFocus(st) {
  applying = applying.then(async () => {
    if (!st || st.from === clientId || !st.batch || !st.n || !S.me.name || st.by !== S.me.name) return;
    if (!S.batch || S.batch.id !== st.batch) { if (hooks.openBatch) await hooks.openBatch(st.batch, st.n, true); }
    else if (S.n !== st.n && hooks.goTo) await hooks.goTo(st.n, true);
  }).catch((e) => console.warn(e));
}

let applying = Promise.resolve();
export function applyRemote(st) {
  applying = applying.then(async () => {
    if (!S.together || !st || st.from === clientId) return;
    S.leader = false;
    if (!S.batch || S.batch.id !== st.batch) { if (hooks.openBatch) await hooks.openBatch(st.batch, st.n, true); }
    else if (S.n !== st.n && hooks.goTo) await hooks.goTo(st.n, true);
    if (!S.batch || S.batch.id !== st.batch || S.n !== st.n) return;
    if (st.rate && st.rate !== S.rate) setRate(st.rate, false);
    if (!isVideo()) return;
    if (st.playing) {
      const lag = st.server_time ? Math.min(1, Math.max(0, clock.now() - st.server_time)) : 0;
      const target = st.t + (lag + avOff()) * (st.rate || 1);
      const tol = avResync ? 0.03 : st.tick ? 0.35 : 0.1;
      avResync = false;
      if (Math.abs(vid.currentTime - target) > tol) { vid.currentTime = target; if (st.tick) dbg("drift", +(vid.currentTime - target).toFixed(3)); }
      if (vid.paused) safePlay();
    } else {
      if (!vid.paused) vid.pause();
      const f = frameOf(st.t, fps());
      if (curFrame() !== f || Math.abs(vid.currentTime - st.t) > 0.5 / fps()) seekFrame(f, false);
    }
  }).catch((e) => console.warn(e));
}

on("redraw-marks", drawMarks);
setRate(1, false);
setLoop(S.loop);
setStopAtNotes(S.stopAtNotes);
updateVolume();
