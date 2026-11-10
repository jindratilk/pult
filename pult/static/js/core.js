// Pult: sdílený stav a pomocné funkce (síť, hodiny serveru, dialogy, oznámení, formátování).

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Mac OS/.test(navigator.userAgent);
// iPad se hlásí jako Mac: rozhoduje dotyková obrazovka bez jemného ukazatele
export const isTouch = navigator.maxTouchPoints > 1 && !matchMedia("(pointer: fine)").matches;
export const MOD = isApple ? "⌘" : "Ctrl";

export const store = {
  get(k, d) { try { const v = localStorage.getItem("pult." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("pult." + k, JSON.stringify(v)); } catch {} },
};

// jedno id na kartu prohlížeče (vlastní zprávy se poznají a neaplikují dvakrát)
export const clientId = (() => {
  let id = null;
  try { id = sessionStorage.getItem("pult.cid"); } catch {}
  if (!id) { id = Math.random().toString(36).slice(2, 10); try { sessionStorage.setItem("pult.cid", id); } catch {} }
  return id;
})();

export const COLORS = ["#ff6b5e", "#ffb020", "#32d17a", "#2fc6ff", "#5b8cff", "#a27bff", "#ff6fb5", "#c9c9d1"];

export const S = {
  me: { name: store.get("name", ""), color: store.get("color", COLORS[Math.floor(Math.random() * COLORS.length)]) },
  local: false, online: false,
  batches: [], batch: null, notes: { strokes: {}, comments: {}, verdicts: {} }, n: 1,
  tool: store.get("tool", "pen"), color: store.get("pen", "#ff3b30"), size: store.get("size", 0.006),
  finger: store.get("finger", false),
  together: store.get("together", false), leader: false,
  rate: 1, loop: store.get("loop", false), stopAtNotes: store.get("stopAtNotes", false), hold: store.get("hold", 0.5),
  zones: 0, kino: false, scope: store.get("scope", "item"),
  people: [], live: {}, settings: null,
};

export function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
export function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
export const icon = (name, cls = "i") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
// Počty a časy přímo v jazyce rozhraní (překladová vrstva je u jmen lidí přeskakuje)
export const isEN = () => document.documentElement.lang === "en";
const NOUN = { "položka": ["item", "items"], "kresba": ["drawing", "drawings"], "tah": ["stroke", "strokes"], "komentář": ["comment", "comments"],
  "připomínka": ["note", "notes"], "dávka": ["batch", "batches"], "dávku": ["batch", "batches"], "soubor": ["file", "files"],
  "video": ["video", "videos"], "obrázek": ["image", "images"], "revize": ["review", "reviews"] };
export function plural(n, one, few, many) {
  if (isEN() && NOUN[one]) return `${n} ${n === 1 ? NOUN[one][0] : NOUN[one][1]}`;
  return `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
}
export function initials(name) { const p = String(name || "?").trim().split(/\s+/); return ((p[0] || "?")[0] + (p[1] ? p[1][0] : "")).toUpperCase(); }

export async function api(method, url, body, opts = {}) {
  const r = await fetch(url, { method, headers: { "X-Pult-Lang": document.documentElement.lang || "cs", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store", ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `Chyba ${r.status}`); e.status = r.status; throw e; }
  return j;
}

// ---------- čas ----------
export function fpsOf(it) { return (it && it.fps) || 30; }
export function frameOf(t, fps) { return Math.max(0, Math.floor((t || 0) * fps + 1e-4)); }
// mm:ss:ff jako ve střižně (snímek v rámci vteřiny)
export function fmtTC(t, fps) {
  const r = Math.max(1, Math.round(fps)), f = frameOf(Math.max(0, t || 0), fps), s = Math.floor(f / r);
  const p2 = (x) => String(x).padStart(2, "0");
  return `${p2(Math.floor(s / 60))}:${p2(s % 60)}:${p2(f % r)}`;
}
export function fmtDur(t) { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60); return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`; }
export function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!isFinite(s)) return "";
  const en = isEN();
  if (s < 50) return en ? "now" : "teď";
  if (s < 3600) return en ? `${Math.round(s / 60)} min ago` : `před ${Math.round(s / 60)} min`;
  if (s < 86400) return en ? `${Math.round(s / 3600)} h ago` : `před ${Math.round(s / 3600)} h`;
  const d = new Date(iso);
  if (s < 7 * 86400) return en ? `${Math.round(s / 86400)} d ago` : `před ${Math.round(s / 86400)} d`;
  return en ? d.toLocaleDateString("en", { month: "short", day: "numeric" }) : `${d.getDate()}. ${d.getMonth() + 1}.`;
}
export function fmtSize(b) { return b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`; }

// Hodiny serveru: odhad posunu proti hodinám tohoto zařízení (iPad a Mac se klidně liší o stovky ms).
export const clock = {
  offset: 0,
  now() { return Date.now() / 1000 + this.offset; },
  async sync() {
    let best = null;
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now() / 1000;
      try {
        const r = await api("GET", "/api/time");
        const t1 = Date.now() / 1000, rtt = t1 - t0;
        if (!best || rtt < best.rtt) best = { rtt, off: r.t - (t0 + t1) / 2 };
      } catch { return; }
    }
    if (best) this.offset = best.off;
  },
};

// ---------- události mezi moduly ----------
const bus = new EventTarget();
export const on = (type, fn) => bus.addEventListener(type, (e) => fn(e.detail));
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

// ---------- oznámení ----------
export function toast(msg, opts = {}) {
  const box = $("#toasts"), t = document.createElement("div");
  t.className = "toast" + (opts.error ? " err" : "");
  const span = document.createElement("span"); span.textContent = msg; t.appendChild(span);
  let timer;
  const close = () => { clearTimeout(timer); t.remove(); };
  if (opts.action) {
    const b = document.createElement("button"); b.textContent = opts.action;
    b.onclick = () => { close(); opts.onAction && opts.onAction(); };
    t.appendChild(b);
  }
  box.appendChild(t);
  while (box.children.length > 3) box.firstChild.remove();
  timer = setTimeout(close, opts.ms || (opts.action ? 8000 : 3500));
  return close;
}

// ---------- dialogy a nabídky ----------
export function dialog({ title, body, wide = false, foot = null, onClose = null, dismiss = true }) {
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.innerHTML = `<div class="dlg${wide ? " wide" : ""}" role="dialog" aria-modal="true">${title ? `<div class="dlg-h"><h3>${esc(title)}</h3><div class="grow"></div><button class="ib" data-close title="Zavřít (Esc)">${icon("x")}</button></div>` : ""}<div class="dlg-b"></div>${foot ? '<div class="dlg-f"></div>' : ""}</div>`;
  const b = $(".dlg-b", scrim);
  if (typeof body === "string") b.innerHTML = body; else if (body) b.appendChild(body);
  if (foot) { const f = $(".dlg-f", scrim); if (typeof foot === "string") f.innerHTML = foot; else f.appendChild(foot); }
  const close = () => { if (!scrim.isConnected) return; scrim.remove(); dialogs.splice(dialogs.indexOf(close), 1); onClose && onClose(); };
  scrim.addEventListener("pointerdown", (e) => { if (dismiss && e.target === scrim) close(); });
  scrim.querySelectorAll("[data-close]").forEach((x) => (x.onclick = close));
  $("#layer").appendChild(scrim);
  dialogs.push(close);
  const first = scrim.querySelector("input:not([type=hidden]), textarea, select");
  if (first && !(first.type === "checkbox")) setTimeout(() => first.focus(), 30);
  return { el: scrim, close };
}
export const dialogs = [];
export const anyDialog = () => dialogs.length > 0 || !!$(".menu");

export function confirmBox(title, text, okLabel = "Pokračovat", danger = false) {
  return new Promise((res) => {
    const foot = document.createElement("div");
    foot.style.display = "contents";
    foot.innerHTML = `<button class="btn" data-close>Zrušit</button><button class="btn ${danger ? "danger" : "primary"}" data-ok>${esc(okLabel)}</button>`;
    let ok = false;
    const d = dialog({ title, body: `<p>${esc(text)}</p>`, foot, onClose: () => res(ok) });
    $("[data-ok]", d.el).onclick = () => { ok = true; d.close(); };
    $("[data-ok]", d.el).focus();
  });
}

export function menu(anchor, items) {
  closeMenu();
  const m = document.createElement("div");
  m.className = "menu";
  for (const it of items) {
    if (it === "-") { m.appendChild(document.createElement("hr")); continue; }
    if (!it) continue;
    const b = document.createElement("button");
    if (it.danger) b.className = "danger";
    b.innerHTML = (it.icon ? icon(it.icon) : it.dot ? `<i class="mdot" style="--c:${esc(it.dot)}"></i>` : "") + `<span>${esc(it.label)}</span>`;
    b.onclick = () => { closeMenu(); it.run(); };
    m.appendChild(b);
  }
  $("#layer").appendChild(m);
  const r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw)) + "px";
  m.style.top = (r.bottom + mh + 8 < innerHeight ? r.bottom + 6 : Math.max(8, r.top - mh - 6)) + "px";
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  function outside(e) { if (!m.contains(e.target)) closeMenu(); }
  m._off = () => document.removeEventListener("pointerdown", outside, true);
}
export function closeMenu() { const m = $(".menu"); if (m) { m._off && m._off(); m.remove(); return true; } return false; }

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const t = document.createElement("textarea"); t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); } catch {}
    t.remove();
  }
  toast("Zkopírováno");
}

// chyby v prohlížeči jdou do debug.log na serveru (Nastavení › O Pultu ukazuje složku); nejvýš 20 za načtení
let errCount = 0;
function reportError(kind, msg, where) {
  if (++errCount > 20) return;
  fetch("/api/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client: clientId, ua: navigator.userAgent, error: { kind, msg: String(msg).slice(0, 500), where: String(where || "").slice(0, 300) } }) }).catch(() => {});
}
addEventListener("error", (e) => reportError("error", e.message, `${e.filename}:${e.lineno}:${e.colno}`));
addEventListener("unhandledrejection", (e) => reportError("promise", e.reason && (e.reason.stack || e.reason.message || e.reason)));

// diagnostika (?debug=1): události se posílají na server do debug.log
const dbgOn = /[?&]debug=1/.test(location.search) || store.get("debug", false);
const dbgBuf = [];
export function dbg(...a) { if (dbgOn) { dbgBuf.push([Date.now() % 100000, ...a]); if (dbgBuf.length > 400) dbgBuf.shift(); } }
if (dbgOn) setInterval(() => { if (dbgBuf.length) api("POST", "/api/log", { client: clientId, ua: navigator.userAgent, events: dbgBuf.splice(0) }).catch(() => {}); }, 3000);
