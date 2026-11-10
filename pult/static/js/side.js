// Pult: seznam dávek, nahrávání souborů (tlačítko i přetažení, klidně celé složky) a akce s dávkou.
import { $, $$, S, store, api, clientId, esc, icon, emit, on, toast, ago, plural, fmtSize, dialog, confirmBox, menu, copyText, isEN, isApple } from "./core.js";

const EXT = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif", "tif", "tiff", "bmp", "tga", "jfif",
  "mp4", "mov", "m4v", "webm", "mkv", "avi", "mxf", "mts", "m2ts", "wmv", "mpg", "mpeg"]);
const supported = (name) => EXT.has(String(name).split(".").pop().toLowerCase()) && !String(name).startsWith(".");
const open = store.get("groups", { open: true, done: false, dismissed: false });

// ---------- seznam ----------
export async function loadBatches() {
  const r = await api("GET", "/api/batches");
  S.batches = r.batches;
  renderList();
  emit("batches-loaded");
  return S.batches;
}
let listTimer = 0;
export function refreshSoon() { clearTimeout(listTimer); listTimer = setTimeout(() => loadBatches().catch(() => {}), 250); }

// barevné štítky dávek: stejné klávesy 1 až 6 jako barvy pera (po kliknutí do seznamu), 0 nebo stejná klávesa barvu sundá
const LABELS = { red: "#ff3b30", yellow: "#ffcc00", green: "#34c759", blue: "#2f7bff", white: "#e8e8ea", black: "#6e6e73" };
const LABEL_KEYS = ["red", "yellow", "green", "blue", "white", "black"];
const LABEL_NAMES = { red: "Červená", yellow: "Žlutá", green: "Zelená", blue: "Modrá", white: "Bílá", black: "Šedá" };
async function setLabel(ids, label) {
  const all = ids.map((id) => S.batches.find((x) => x.id === id)).filter(Boolean);
  if (!all.length) return;
  if (label && all.every((b) => b.label === label)) label = null;  // stejná barva znovu = sundat
  for (const b of all) b.label = label;
  renderList();
  await Promise.all(all.map((b) => api("POST", `/api/batch/${encodeURIComponent(b.id)}/label`, { label }).catch(() => toast("Barvu se nepodařilo uložit"))));
}

// ---------- řádek dávky (jako vlákna v t3code: název, stav a čas na jednom řádku, akce při najetí) ----------
const pinned = new Set(store.get("pinned", []));
const savePins = () => store.set("pinned", [...pinned].filter((id) => S.batches.some((b) => b.id === id)));
const SHELF = 8;  // odeslané a smazané: prvních pár, zbytek po kliknutí
const more = { done: false, dismissed: false };
function when(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000, en = isEN();
  if (!isFinite(s)) return "";
  if (s < 60) return en ? "now" : "teď";
  if (s < 3600) return en ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 60)} min`;
  if (s < 86400) return en ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 3600)} h`;
  if (s < 7 * 86400) return en ? `${Math.floor(s / 86400)}d` : `${Math.floor(s / 86400)} d`;
  const d = new Date(iso);
  return en ? d.toLocaleDateString("en", { month: "short", day: "numeric" }) : `${d.getDate()}. ${d.getMonth() + 1}.`;
}
function status(b) {
  const busy = b.count - b.ready - b.errors;
  if (busy > 0) return `<i class="st-ic spin" title="Připravuji ${b.ready}/${b.count}"></i>`;
  if (b.working) return `<span class="st-ic cl work" title="${esc(b.working.text || "Claude zapracovává revizi")}">${icon("spark")}</span>`;
  if (b.errors) return `<span class="st-ic err" title="${b.errors} ⚠">⚠</span>`;
  if (b.status === "open" && b.unsent) return `<i class="st-ic dot warn" title="Rozpracováno, ještě neodesláno"></i>`;
  if (b.status === "open" && b.waiting) return `<i class="st-ic dot wait" title="Claude čeká na tvoji revizi"></i>`;
  if (b.claude_done && Date.now() - new Date(b.claude_done.at).getTime() < 30 * 60e3) return `<span class="st-ic cl done" title="${esc(b.claude_done.text || "Claude revizi zapracoval")}">${icon("check")}</span>`;
  return "";
}
function row(b, jump) {
  const busy = b.count - b.ready - b.errors;
  const meta = [];
  if (busy > 0) meta.push(`<span>Připravuji ${b.ready}/${b.count}</span>`);
  else meta.push(`<span>${b.videos === b.count ? plural(b.count, "video", "videa", "videí") : b.videos ? `${b.count} položek` : plural(b.count, "obrázek", "obrázky", "obrázků")}</span>`);
  if (b.drawings) meta.push(`<span class="pill">${icon("pen")}${b.drawings}</span>`);
  if (b.comments) meta.push(`<span class="pill">${icon("chat")}${b.comments}</span>`);
  if (b.approved) meta.push(`<span class="pill ok">✓${b.approved}</span>`);
  if (b.rejected) meta.push(`<span class="pill no">✕${b.rejected}</span>`);
  const th = b.thumb ? `style="background-image:url('${esc(b.thumb)}')"` : "";
  const lc = LABELS[b.label], pin = pinned.has(b.id);
  return `<button class="brow${S.batch && S.batch.id === b.id ? " on" : ""}${sel.size > 1 && sel.has(b.id) ? " sel" : ""}" data-id="${esc(b.id)}" title="${esc(b.title)}"${lc ? ` data-label="${b.label}" style="--lc:${lc}"` : ""}>
    <span class="th" ${th}>${b.thumb ? "" : icon(b.videos ? "film" : "image")}${busy > 0 ? `<span class="bar"><i style="width:${Math.round((b.ready / b.count) * 100)}%"></i></span>` : ""}</span>
    <span class="rb"><span class="l1"><span class="t">${esc(b.title)}</span>${status(b)}<span class="when">${esc(when(b.status !== "open" && b.status_at ? b.status_at : b.created))}</span>
      <span class="acts"><span role="button" class="act" data-act="pin" title="${pin ? "Odepnout" : "Připnout"}">${icon(pin ? "x" : "pin")}</span>${b.status !== "dismissed" ? `<span role="button" class="act" data-act="del" title="Smazat dávku">${icon("trash")}</span>` : ""}</span></span>
      <span class="l2">${meta.join("")}</span></span>
    ${jump ? `<kbd class="jump">${MODK}${jump}</kbd>` : ""}</button>`;
}

export function renderList() {
  const q = $("#search").value.trim().toLowerCase();
  const list = S.batches.filter((b) => !q || b.title.toLowerCase().includes(q));
  const pins = list.filter((b) => pinned.has(b.id) && b.status !== "dismissed");
  const groups = [["pinned", "Připnuté", pins], ["open", "K revizi", list.filter((b) => b.status === "open" && !pinned.has(b.id))],
    ["done", "Odeslané", list.filter((b) => b.status === "done" && !pinned.has(b.id))], ["dismissed", "Smazané", list.filter((b) => b.status === "dismissed")]];
  let html = "", n = 0;
  for (const [key, label, items] of groups) {
    if (!items.length && key !== "open") continue;
    const isOpen = key === "pinned" || open[key] || !!q;
    html += `<div class="group-h">${key === "pinned" ? `<span class="g-l">${label}</span>` : `<button data-g="${key}" class="${isOpen ? "" : "closed"}">${icon("chev-d")}${label}</button>`}<span>${items.length || ""}</span></div>`;
    if (!isOpen) continue;
    if (!items.length) html += `<div class="side-empty">${q ? "Nic nenalezeno." : "Všechno prohlédnuto. 🎉<br>Nové dávky se tu objeví samy."}</div>`;
    const cap = key === "open" || key === "pinned" || more[key] || q ? 500 : SHELF;
    html += items.slice(0, cap).map((b) => row(b, ++n <= 9 ? n : 0)).join("");
    if (items.length > cap) html += `<button class="side-more" data-more="${key}">Zobrazit další (${items.length - cap})</button>`;
  }
  for (const id of [...sel]) if (!S.batches.some((b) => b.id === id)) sel.delete(id);
  if (sel.size > 1) html += `<div class="selbar"><span>Vybráno ${plural(sel.size, "dávka", "dávky", "dávek")}</span>
    <button class="btn sm danger" data-selact="del" title="Smazat (⌫)">${icon("trash")}Smazat</button><button class="btn sm" data-selact="clear">Zrušit</button></div>`;
  $("#batchList").innerHTML = html;
}
$("#search").addEventListener("input", renderList);
$("#search").addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { e.target.value = ""; renderList(); e.target.blur(); } });

// ⌘1 až ⌘9: skok na dávku podle pořadí v seznamu; když držíš ⌘, čísla se ukážou (jako v t3code)
const MODK = isApple ? "⌘" : "Ctrl+";
let hintTimer = 0;
const hints = (on) => { clearTimeout(hintTimer); if (on) hintTimer = setTimeout(() => $("#batchList").classList.add("jump-on"), 350); else $("#batchList").classList.remove("jump-on"); };
document.addEventListener("keydown", (e) => {
  if (e.key === "Meta" || (!isApple && e.key === "Control")) return hints(true);
  const mod = isApple ? e.metaKey : e.ctrlKey;
  if (!mod || e.shiftKey || e.altKey || !/^Digit[1-9]$/.test(e.code)) return;
  const to = visibleIds()[+e.code.slice(-1) - 1];
  if (!to) return;
  e.preventDefault(); e.stopPropagation(); hints(false);
  sel.clear(); sel.add(to); anchor = to;
  emit("open-batch", { id: to });
}, true);
document.addEventListener("keyup", (e) => { if (e.key === "Meta" || e.key === "Control") hints(false); });
addEventListener("blur", () => hints(false));

// ---------- šířka panelu: tažení za okraj, dvojklik vrátí výchozí ----------
const SIDE_MIN = 208, SIDE_DEF = 264;
function sideMax() { const notes = $("#app").classList.contains("no-notes") ? 0 : 328; return Math.max(SIDE_MIN, Math.min(480, innerWidth - notes - 640)); }
function setSideW(w, save) {
  const v = Math.round(Math.max(SIDE_MIN, Math.min(sideMax(), w)));
  $("#app").style.setProperty("--side-w", v + "px");
  if (save) store.set("sideW", v);
  emit("layout");
}
setSideW(store.get("sideW", SIDE_DEF), false);
addEventListener("resize", () => setSideW(store.get("sideW", SIDE_DEF), false));
$("#sideRail").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  const rail = e.currentTarget, x0 = e.clientX, w0 = $("#side").getBoundingClientRect().width;
  rail.setPointerCapture(e.pointerId);
  document.documentElement.classList.add("resizing");
  const mv = (ev) => setSideW(w0 + ev.clientX - x0, false);
  const up = (ev) => { rail.removeEventListener("pointermove", mv); rail.removeEventListener("pointerup", up); document.documentElement.classList.remove("resizing"); setSideW(w0 + ev.clientX - x0, true); };
  rail.addEventListener("pointermove", mv);
  rail.addEventListener("pointerup", up);
});
$("#sideRail").addEventListener("dblclick", () => setSideW(SIDE_DEF, true));

// ---------- výběr více dávek jako ve Finderu: ⌘/Ctrl klik přidá, ⇧ klik vybere rozsah, ⌫ smaže ----------
const sel = new Set();
let anchor = null, sideActive = false;
document.addEventListener("pointerdown", (e) => { sideActive = !!e.target.closest("#side"); }, true);
const visibleIds = () => [...document.querySelectorAll("#batchList .brow")].map((x) => x.dataset.id);
// kliknutá dávka má přednost před otevřenou: otevírá se až po načtení, klávesa hned po kliku by jinak mířila na předchozí
const selected = () => (sel.size > 1 ? [...sel] : anchor && sel.has(anchor) ? [anchor] : S.batch ? [S.batch.id] : [...sel]);
export function clearSelection() { if (sel.size) { sel.clear(); renderList(); } }
function selectRange(id) {
  const ids = visibleIds(), a = ids.indexOf(anchor || (S.batch && S.batch.id) || id), b = ids.indexOf(id);
  if (a < 0 || b < 0) return;
  sel.clear();
  ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => sel.add(x));
}

$("#batchList").addEventListener("click", (e) => {
  const m = e.target.closest("[data-more]");
  if (m) { more[m.dataset.more] = true; renderList(); return; }
  const ra = e.target.closest("[data-act]");
  if (ra) {
    e.stopPropagation();
    const b = S.batches.find((x) => x.id === ra.closest(".brow").dataset.id);
    if (!b) return;
    if (ra.dataset.act === "pin") { pinned.has(b.id) ? pinned.delete(b.id) : pinned.add(b.id); savePins(); renderList(); }
    else removeBatches([b.id]);
    return;
  }
  const g = e.target.closest("[data-g]");
  if (g) { open[g.dataset.g] = !open[g.dataset.g]; store.set("groups", open); renderList(); return; }
  const act = e.target.closest("[data-selact]");
  if (act) { act.dataset.selact === "del" ? removeBatches([...sel]) : clearSelection(); return; }
  const r = e.target.closest(".brow");
  if (!r) return;
  const id = r.dataset.id;
  if (e.metaKey || e.ctrlKey) {
    if (!sel.size && S.batch) sel.add(S.batch.id);
    sel.has(id) ? sel.delete(id) : sel.add(id);
    anchor = id;
    renderList();
    return;
  }
  if (e.shiftKey) { selectRange(id); renderList(); return; }
  sel.clear(); sel.add(id); anchor = id;
  emit("open-batch", { id });
  if (innerWidth <= 1180) emit("hide-drawers");
});
$("#batchList").addEventListener("contextmenu", (e) => {
  const r = e.target.closest(".brow");
  if (!r) return;
  e.preventDefault();
  if (sel.size > 1 && sel.has(r.dataset.id)) {
    return menu(r, [
      ...LABEL_KEYS.map((k, i) => ({ label: `${LABEL_NAMES[k]} (${i + 1})`, dot: LABELS[k], run: () => setLabel([...sel], k) })),
      { label: "Bez barvy (0)", icon: "x", run: () => setLabel([...sel], null) },
      "-",
      { label: `Smazat ${plural(sel.size, "dávku", "dávky", "dávek")}`, icon: "trash", danger: true, run: () => removeBatches([...sel]) },
      { label: "Zrušit výběr", icon: "x", run: clearSelection },
    ]);
  }
  const b = S.batches.find((x) => x.id === r.dataset.id);
  if (b) batchMenu(r, b);
});

// Klávesy, když člověk naposledy klikl do seznamu dávek. Vrací true, když klávesu zpracoval.
export function keydown(e) {
  if (!sideActive) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === "Backspace" || e.key === "Delete") {
    const ids = selected();
    if (!ids.length) return false;
    e.preventDefault();
    removeBatches(ids);
    return true;
  }
  const dg = !mod && !e.altKey && /^(Digit|Numpad)[0-6]$/.test(e.code) ? +e.code.slice(-1) : -1;
  if (dg >= 0) {
    const ids = selected();
    if (!ids.length) return false;
    e.preventDefault();
    setLabel(ids, dg ? LABEL_KEYS[dg - 1] : null);
    return true;
  }
  if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); visibleIds().forEach((x) => sel.add(x)); renderList(); return true; }
  if (!mod && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    const ids = visibleIds(), cur = ids.indexOf(e.shiftKey && sel.size ? [...sel].pop() : S.batch && S.batch.id);
    const to = ids[Math.max(0, Math.min(ids.length - 1, cur + (e.key === "ArrowUp" ? -1 : 1)))];
    if (!to) return false;
    e.preventDefault();
    if (e.shiftKey) { if (!sel.size && S.batch) sel.add(S.batch.id); sel.add(to); renderList(); }
    else { sel.clear(); sel.add(to); anchor = to; emit("open-batch", { id: to }); }
    document.querySelector(`#batchList .brow[data-id="${CSS.escape(to)}"]`)?.scrollIntoView({ block: "nearest" });
    return true;
  }
  return false;
}

async function removeBatches(ids) {
  const list = ids.map((id) => S.batches.find((x) => x.id === id)).filter((b) => b && b.status !== "dismissed");
  if (!list.length) return toast("Tyhle dávky už jsou smazané.", { ms: 1500 });
  try {
    for (const b of list) await api("POST", `/api/batch/${encodeURIComponent(b.id)}/status`, { status: "dismissed", from: clientId });
    sel.clear();
    const cur = S.batch && list.some((b) => b.id === S.batch.id) ? S.batch.id : null;
    await loadBatches();
    if (cur) emit("batch-left", { id: cur });
    toast(list.length === 1 ? `Smazáno: ${list[0].title}` : `Smazáno ${plural(list.length, "dávka", "dávky", "dávek")}`,
      { action: "Vrátit", onAction: () => restoreBatches(list) });
  } catch (e) { toast(e.message, { error: true }); }
}
async function restoreBatches(list) {
  try {
    for (const b of list) await api("POST", `/api/batch/${encodeURIComponent(b.id)}/status`, { status: b.status, from: clientId });
    await loadBatches();
  } catch (e) { toast(e.message, { error: true }); }
}

// ---------- akce s dávkou ----------
export function batchMenu(anchor, b) {
  b = b || (S.batch && S.batches.find((x) => x.id === S.batch.id)) || S.batch;
  if (!b) return;
  const st = b.status;
  menu(anchor, [
    { label: pinned.has(b.id) ? "Odepnout" : "Připnout nahoru", icon: "pin", run: () => { pinned.has(b.id) ? pinned.delete(b.id) : pinned.add(b.id); savePins(); renderList(); } },
    { label: "Přejmenovat", icon: "pen", run: () => renameBatch(b) },
    { label: "Přidat soubory do dávky", icon: "plus", run: () => pickFiles(b.id) },
    ...LABEL_KEYS.map((k, i) => ({ label: `${b.label === k ? "✓ " : ""}${LABEL_NAMES[k]} (${i + 1})`, dot: LABELS[k], run: () => setLabel([b.id], k) })),
    b.label && { label: "Bez barvy (0)", icon: "x", run: () => setLabel([b.id], null) },
    "-",
    S.local && { label: "Otevřít složku dávky", icon: "folder", run: () => api("POST", "/api/open", { what: "batch", id: b.id }) },
    S.settings && S.settings.settings && S.settings.settings.share && { label: "Zkopírovat odkaz pro tým", icon: "link", run: () => copyText(`${(S.settings.invite[0] || location.origin).split("/?")[0]}/#${b.id}`) },
    "-",
    st !== "open" && { label: "Znovu otevřít k revizi", icon: "refresh", run: () => setStatus(b, "open") },
    st !== "dismissed" && { label: "Smazat dávku", icon: "trash", danger: true, run: () => setStatus(b, "dismissed") },
  ]);
}
async function setStatus(b, status) {
  try {
    await api("POST", `/api/batch/${encodeURIComponent(b.id)}/status`, { status, from: clientId });
    await loadBatches();
    if (status === "dismissed") {
      emit("batch-left", { id: b.id });
      toast(`Smazáno: ${b.title}`, { action: "Vrátit", onAction: () => setStatus(b, "open") });
    } else {
      emit("open-batch", { id: b.id });
    }
  } catch (e) { toast(e.message, { error: true }); }
}
function renameBatch(b) {
  const foot = document.createElement("div");
  foot.style.display = "contents";
  foot.innerHTML = `<button class="btn" data-close>Zrušit</button><button class="btn primary" data-ok>Uložit</button>`;
  const d = dialog({ title: "Přejmenovat dávku", body: `<input class="inp" id="rnInput" maxlength="200">`, foot });
  const inp = $("#rnInput", d.el);
  inp.value = b.title; inp.select();
  const save = async () => {
    const t = inp.value.trim();
    if (!t) return;
    d.close();
    try { await api("POST", `/api/batch/${encodeURIComponent(b.id)}/rename`, { title: t }); await loadBatches(); emit("batch-renamed", { id: b.id, title: t }); }
    catch (e) { toast(e.message, { error: true }); }
  };
  $("[data-ok]", d.el).onclick = save;
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") save(); if (e.key === "Escape") d.close(); };
}
$("#batchTitle").onclick = () => { if (S.batch) renameBatch(S.batches.find((x) => x.id === S.batch.id) || S.batch); };
$("#batchMenuBtn").onclick = (e) => batchMenu(e.currentTarget);

// ---------- nahrávání ----------
let appendTo = null, uploading = 0;
export const busy = () => uploading > 0;
// nativní aplikace: soubory jako cesty na disku (puštěné do okna, z Docku, z panelu pro výběr), nic se nekopíruje
export function addPaths(files, title = "", useInputTarget = false) {
  dragDepth = 0; $("#drop").hidden = true;
  const bid = useInputTarget ? appendTo : null;
  appendTo = null;
  startUpload(files, title, bid);
}
export function pickFiles(bid = null) { appendTo = bid; $("#fileInput").click(); }
$("#addBtn").onclick = () => pickFiles(null);
$("#emptyAdd").onclick = () => pickFiles(null);
$("#fileInput").onchange = (e) => { const files = [...e.target.files]; e.target.value = ""; if (files.length) startUpload(files, "", appendTo); appendTo = null; };

// přetažení souborů a složek odkudkoli do okna
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $("#drop").hidden = false; });
addEventListener("dragover", (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("#drop").hidden = true; });
addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $("#drop").hidden = true;
  const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  let files = [], title = "";
  if (entries.length) {
    if (entries.length === 1 && entries[0].isDirectory) title = entries[0].name;
    for (const en of entries) files.push(...await walk(en));
  } else files = [...e.dataTransfer.files];
  if (files.length) startUpload(files, title, null);
});
async function walk(entry) {
  if (entry.isFile) return new Promise((res) => entry.file((f) => res([f]), () => res([])));
  if (!entry.isDirectory || entry.name.startsWith(".")) return [];
  const reader = entry.createReader(), out = [];
  for (;;) {
    const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
    if (!batch.length) break;
    for (const en of batch) out.push(...await walk(en));
  }
  return out;
}

function startUpload(all, title, bid) {
  const files = all.filter((f) => supported(f.name)).sort((a, b) => a.name.localeCompare(b.name, "cs", { numeric: true }));
  const skipped = all.length - files.length;
  if (!files.length) return toast("Tyhle soubory Pult neumí. Obrázky: jpg, png, webp, heic, tif… Videa: mp4, mov, webm, mkv…", { error: true });
  const total = files.reduce((a, f) => a + f.size, 0);
  const byPath = files.every((f) => f.path);  // originály zůstanou na místě, server si je přečte sám
  const cur = S.batch && S.batch.status === "open" ? S.batch : null;
  const suggested = title || (files.length === 1 ? files[0].name.replace(/\.[^.]+$/, "") : "");
  const body = document.createElement("div");
  body.innerHTML = `
    <label class="field"><span>Název dávky</span><input class="inp" id="upTitle" maxlength="200" placeholder="Např. Banner podzim v3"></label>
    ${cur || bid ? `<label class="radio"><input type="radio" name="upMode" value="new" ${bid ? "" : "checked"}> Nová dávka</label>
    <label class="radio"><input type="radio" name="upMode" value="append" ${bid ? "checked" : ""}> Přidat do „${esc((bid && (S.batches.find((x) => x.id === bid) || {}).title) || (cur && cur.title) || "")}“</label>` : ""}
    <div class="files">${files.slice(0, 300).map((f) => `<div>${icon(/\.(mp4|mov|m4v|webm|mkv|avi|mxf|mts|m2ts|wmv|mpg|mpeg)$/i.test(f.name) ? "film" : "image")}<span>${esc(f.name)}</span><span class="dim">${fmtSize(f.size)}</span></div>`).join("")}${files.length > 300 ? `<div class="dim">… a dalších ${files.length - 300}</div>` : ""}</div>
    <div class="dim">${plural(files.length, "soubor", "soubory", "souborů")} · ${fmtSize(total)}${skipped ? ` · ${skipped} nepodporovaných vynechám` : ""}</div>
    ${byPath ? `<div class="dim">Originály zůstanou na místě, Pult si z nich připraví jen náhledy.</div>` : ""}
    <div id="upProg" hidden><div class="progress"><i></i></div><div class="dim" id="upStatus"></div></div>`;
  const foot = document.createElement("div");
  foot.style.display = "contents";
  foot.innerHTML = `<button class="btn" data-close>Zrušit</button><button class="btn primary" data-ok>${icon(byPath ? "plus" : "upload")}${byPath ? "Přidat na Pult" : "Nahrát na Pult"}</button>`;
  let xhr = null, cancelled = false;
  const d = dialog({ title: byPath ? "Přidat na Pult" : "Nahrát na Pult", body, foot, dismiss: false, onClose: () => { cancelled = true; if (xhr) xhr.abort(); } });
  const t = $("#upTitle", d.el);
  t.value = suggested;
  t.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") go(); if (e.key === "Escape") d.close(); };
  const modeEl = () => { const r = d.el.querySelector("input[name=upMode]:checked"); return r ? r.value : "new"; };
  d.el.querySelectorAll("input[name=upMode]").forEach((r) => (r.onchange = () => { t.disabled = modeEl() === "append"; }));
  if (bid) t.disabled = true;
  $("[data-ok]", d.el).onclick = go;
  async function go() {
    const ok = $("[data-ok]", d.el);
    if (ok.disabled) return;
    ok.disabled = true; t.disabled = true;
    $("#upProg", d.el).hidden = false;
    uploading++;
    try {
      let target = modeEl() === "append" ? (bid || (cur && cur.id)) : null;
      if (byPath) {
        const r = await api("POST", "/api/add", target ? { files: files.map((f) => f.path), batch: target } : { files: files.map((f) => f.path), title: t.value.trim() || suggested });
        d.close();
        await loadBatches();
        emit("open-batch", { id: r.batch });
        toast(`Přidáno ${plural(files.length, "soubor", "soubory", "souborů")}. Náhledy se připravují.`);
        return;
      }
      if (!target) target = (await api("POST", "/api/batches", { title: t.value.trim() || suggested, from: clientId })).batch;
      const paths = [];
      let done = 0;
      for (let i = 0; i < files.length; i++) {
        if (cancelled) return;
        $("#upStatus", d.el).textContent = `Nahrávám ${i + 1} z ${files.length}: ${files[i].name}`;
        paths.push(await put(target, files[i], (loaded) => { $(".progress i", d.el).style.width = ((done + loaded) / Math.max(1, total)) * 100 + "%"; }));
        done += files[i].size;
      }
      $("#upStatus", d.el).textContent = "Hotovo, připravuji náhledy…";
      await api("POST", `/api/batch/${encodeURIComponent(target)}/items`, { uploads: paths, from: clientId });
      d.close();
      await loadBatches();
      emit("open-batch", { id: target });
      toast(`Nahráno ${plural(files.length, "soubor", "soubory", "souborů")}. Náhledy se připravují.`);
    } catch (e) {
      if (!cancelled) { toast("Nahrávání selhalo: " + e.message, { error: true }); ok.disabled = false; }
    } finally { uploading--; }
  }
  function put(target, file, onProgress) {
    return new Promise((res, rej) => {
      xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/upload/${encodeURIComponent(target)}?name=${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => { let j = {}; try { j = JSON.parse(xhr.responseText); } catch {} xhr.status < 300 ? res(j.path) : rej(new Error(j.error || xhr.status)); };
      xhr.onerror = () => rej(new Error("spojení přerušeno"));
      xhr.onabort = () => rej(new Error("zrušeno"));
      xhr.send(file);
    });
  }
}
on("batches-changed", refreshSoon);
