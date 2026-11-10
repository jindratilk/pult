// Pult: most do nativní aplikace pro macOS (menu, Dock, tažení okna, oznámení). V prohlížeči nedělá nic.
// Nativní strana posílá příkazy přes PultNative.command(), web jí posílá stav (co menu smí nabídnout)
// a oblasti, za které jde okno táhnout (prvky s data-mac-drag bez tlačítek a otevřených dialogů).
import { $$ } from "./core.js";

const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pult;
export const isNative = !!bridge;
const post = (m) => { try { bridge.postMessage(m); } catch {} };

let getState = () => ({});
let commands = {};
let lastState = "";

const typingTarget = (el) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);

export function pushState() {
  if (!bridge) return;
  const s = { ...getState(), typing: typingTarget(document.activeElement) };
  const key = JSON.stringify(s);
  if (key === lastState) return;
  lastState = key;
  post({ t: "state", ...s });
}

// ---------- tažení okna ----------
const HOLES = "button, a, input, textarea, select, label, [role=button], [draggable=true], .people, .av, [data-mac-nodrag]";
const OVERLAYS = ".dlg, .menu, .claude-pop, .toast, .author-card";
let lastDrag = "", dragRaf = 0;
const box = (r) => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
function measureDrag() {
  dragRaf = 0;
  const drags = [], holes = [];
  for (const el of $$("[data-mac-drag]")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).visibility === "hidden") continue;
    drags.push(box(r));
    for (const h of el.querySelectorAll(HOLES)) { const q = h.getBoundingClientRect(); if (q.width && q.height) holes.push(box(q)); }
  }
  for (const o of $$(OVERLAYS)) { const q = o.getBoundingClientRect(); if (q.width && q.height) holes.push(box(q)); }
  const key = JSON.stringify([drags, holes]);
  if (key !== lastDrag) { lastDrag = key; post({ t: "drag", drags, holes }); }
}
export function updateDrag() { if (bridge && !dragRaf) dragRaf = requestAnimationFrame(measureDrag); }

// ---------- oznámení (nativní strana je ukáže, jen když Pult není vepředu) ----------
export function notify(title, body, batch) { if (bridge) post({ t: "notify", title, body: body || "", batch: batch || null }); }

export function init(opts) {
  if (!bridge) return;
  getState = opts.state;
  commands = opts.commands;
  window.PultNative = {
    command(name, arg) {
      const f = commands[name];
      if (!f) return;
      Promise.resolve().then(() => f(arg)).catch((e) => console.warn(e)).finally(() => setTimeout(pushState, 50));
    },
  };
  document.addEventListener("focusin", pushState);
  document.addEventListener("focusout", () => setTimeout(pushState, 0));
  for (const ev of ["play", "pause", "volumechange", "loadedmetadata", "emptied"]) document.addEventListener(ev, pushState, true);
  // Jen to, co mění menu nebo lištu: dialogy a nabídky, třídy aplikace (panely, kino) a obsah lišty.
  // Žádné sledování celého DOM: při přehrávání se mění každý snímek.
  const both = () => { pushState(); updateDrag(); };
  const mo = new MutationObserver(both);
  mo.observe(document.body, { childList: true });
  const layer = document.getElementById("layer");
  if (layer) mo.observe(layer, { childList: true });
  const app = document.getElementById("app");
  if (app) mo.observe(app, { attributes: true, attributeFilter: ["class"] });
  for (const el of $$("[data-mac-drag]")) mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
  addEventListener("resize", updateDrag);
  new ResizeObserver(updateDrag).observe(document.documentElement);
  setInterval(pushState, 1000);  // pojistka: stav, který se mění bez DOM (třeba seznam dávek)
  // Kontextové menu jen tam, kde dává smysl (text, pole, vlastní menu Pultu). Jinde nic, jako v nativní aplikaci.
  document.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented || typingTarget(e.target) || (e.target.closest && e.target.closest(".txt, code, pre, a[href]"))) return;
    if (String(getSelection() || "").trim()) return;
    e.preventDefault();
  });
  pushState();
  updateDrag();
}
