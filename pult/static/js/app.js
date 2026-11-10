// Pult: hlavní modul (spojení se serverem, navigace, pás položek, zkratky, lidé na pultu).
const VERSION = "2.10.8";
import { $, $$, S, store, api, dialog, clientId, clock, esc, icon, on, emit, toast, ago, plural, initials, isTouch, anyDialog, dialogs, closeMenu, menu, fmtTC, dbg, isEN } from "./core.js";
import * as P from "./player.js";
import * as D from "./draw.js";
import * as N from "./notes.js";
import { loadBatches, refreshSoon, renderList, pickFiles } from "./side.js";
import * as Side from "./side.js";
import * as Dict from "./dictate.js";
import { openSettings, openHelp, welcome, loadSettings } from "./settings.js";
import * as Native from "./native.js";

const app = $("#app");
if (isTouch) document.documentElement.classList.add("is-touch");

// ---------- otevření dávky a položky ----------
let openToken = 0;
async function openBatch(id, n = 1, remote = false) {
  const my = ++openToken;
  let r;
  try { r = await api("GET", `/api/batch/${encodeURIComponent(id)}`); }
  catch (e) { if (e.status === 404) { toast("Tahle dávka už neexistuje."); return showEmpty(); } throw e; }
  if (my !== openToken) return;
  const changed = !S.batch || S.batch.id !== id;
  S.batch = r.batch;
  N.setNotes(r.notes, id, true);
  if (changed) { D.resetHistory(); P.resetZoom(false); }
  store.set("batch", id);
  $("#empty").hidden = true;
  renderHeader(); renderStrip(); renderList(); N.render();
  await goTo(Math.min(Math.max(1, n), Math.max(1, S.batch.items.length)), remote, true);
}
P.hooks.openBatch = openBatch;

async function goTo(n, remote = false, force = false) {
  if (!S.batch) return;
  const it = S.batch.items.find((i) => i.n === n);
  if (!it && S.batch.items.length) return;
  if (!force && n === S.n && P.item()) return;
  S.n = n;
  history.replaceState(null, "", `#${S.batch.id}/${n}`);
  renderItembar(); markStrip(); N.render(); N.updateVerdict(); N.updateAnchor();
  const th = $(`.st[data-n="${n}"]`);
  if (th) th.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  await P.showItem();
  N.updateAnchor();
  presence();
  if (!remote) { P.publish(); P.publishFocus(); }
}
P.hooks.goTo = goTo;

function showEmpty() {
  S.batch = null; S.notes = { strokes: {}, comments: {}, verdicts: {} };
  P.vid.pause(); P.vid.removeAttribute("src"); P.vid.load();
  $("#wrap").hidden = true; $("#prep").hidden = true;
  $("#strip").innerHTML = "";
  const any = S.batches.some((b) => b.status === "open");
  $("#emptyTitle").textContent = S.batches.length && !any ? "Všechno prohlédnuto" : "Zatím tu nic není";
  $("#emptyText").textContent = S.local ? "Přetáhni sem obrázky nebo videa, nebo řekni Claudovi „pošli to na Pult“." : "Až někdo přidá dávku, objeví se tady.";
  $("#emptyAdd").hidden = false;
  $("#empty").hidden = false;
  history.replaceState(null, "", location.pathname);
  renderHeader(); renderItembar(); renderList(); N.render();
}

async function openNextOpen(exceptId) {
  await loadBatches();
  const next = S.batches.find((b) => b.status === "open" && b.id !== exceptId);
  if (next) await openBatch(next.id); else showEmpty();
}

// ---------- hlavička, položka, pás ----------
function renderHeader() {
  const b = S.batch;
  $("#batchTitle").textContent = b ? b.title : "";
  $("#batchTitle").hidden = !b;
  const meta = [];
  if (b) {
    meta.push(plural(b.items.length, "položka", "položky", "položek"));
    if (b.status === "done") meta.push("odesláno");
    if (b.status === "dismissed") meta.push("smazáno");
    meta.push(ago(b.created));
  }
  $("#batchMeta").textContent = meta.join(" · ");
  document.title = b ? `${b.title} · Pult` : "Pult";
  renderWait();
}
// ---------- kdo Pult udělal: jednou, po třetí odeslané revizi ----------
export const AUTHOR = { web: "https://janpils.com", webEn: "https://janpils.com", call: "mailto:hello@janpils.com", github: "https://github.com/jan-visual/pult" };
function authorCardSoon() {
  const n = store.get("submits", 0) + 1;
  store.set("submits", n);
  if (n >= 3 && window.PULT_AUTHOR !== false && !store.get("authorSeen", false)) setTimeout(authorCard, 1800);
}
function authorCard() {
  if ($("#authorCard") || window.PULT_AUTHOR === false) return;
  store.set("authorSeen", true);
  const en = document.documentElement.lang === "en";
  const el = document.createElement("div");
  el.id = "authorCard"; el.className = "author-card";
  el.innerHTML = `<button class="ib ac-x" title="Zavřít">${icon("x")}</button>
    <p><b data-noi18n>Jan Pils</b><br>Stříhám a stavím nástroje pro tvůrce. Když chceš, ať tvůj tým takhle pracuje s AI, nebo potřebuješ nástroj na míru, ozvi se.</p>
    <a class="btn sm" href="${en ? AUTHOR.webEn : AUTHOR.web}" target="_blank" rel="noopener">Více o mně</a>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("in"));
  $(".ac-x", el).onclick = () => { el.classList.remove("in"); setTimeout(() => el.remove(), 250); };
}
on("show-author", authorCard);

// ---------- stopy AI v metadatech (C2PA, IPTC…): Instagram a YouTube podle nich značí „AI“ ----------
const aiCache = new Map();
async function renderAiMeta(it) {
  const chip = $("#aiChip");
  chip.hidden = true;
  if (!it || it.state !== "ready" || !S.batch) return;
  const key = `${S.batch.id}/${it.n}`, bid = S.batch.id;
  let found = Array.isArray(it.ai_meta) ? it.ai_meta : aiCache.get(key);
  if (!found) {
    try { found = (await api("GET", `/api/ai-meta/${encodeURIComponent(bid)}/${it.n}`)).found || []; } catch { found = []; }
    aiCache.set(key, found);
  }
  const cur = P.item();
  if (!cur || cur.n !== it.n || !S.batch || S.batch.id !== bid) return;
  chip.hidden = !found.length;
  chip.onclick = () => aiMetaDialog(it, found);
}
function aiMetaDialog(it, found) {
  const body = document.createElement("div");
  body.className = "aimeta";
  body.innerHTML = `<p>V metadatech souboru <b data-noi18n>${esc(it.name)}</b> jsou stopy po AI. Instagram, YouTube a TikTok podle nich můžou video nebo obrázek označit jako vytvořený pomocí AI.</p>
    <ul>${found.map((f) => `<li><b>${esc(f.what)}</b><code data-noi18n>${esc(f.hint || "")}</code></li>`).join("")}</ul>
    <p class="dim">Čistá kopie má stejný obraz i zvuk, jen bez metadat. Uloží se vedle originálu, originál zůstane beze změny.</p>`;
  const foot = document.createElement("div");
  foot.style.display = "contents";
  foot.innerHTML = `<button class="btn" data-close>Zavřít</button>${S.local ? `<button class="btn primary" data-ok>Vytvořit čistou kopii</button>` : ""}`;
  const d = dialog({ title: "AI metadata", body, foot });
  const ok = $("[data-ok]", d.el);
  if (ok) ok.onclick = async () => {
    ok.disabled = true; ok.textContent = "Čistím…";
    try {
      const r = await api("POST", "/api/ai-meta/clean", { id: S.batch.id, n: it.n });
      d.close();
      toast(r.left && r.left.length ? `Kopie hotová, ale pořád obsahuje: ${r.left.map((x) => x.what).join(", ")}` : `Čistá kopie hotová: ${r.name}`, { ms: 5000 });
    } catch (e) { toast("Čištění se nepovedlo: " + e.message, { error: true, ms: 6000 }); ok.disabled = false; ok.textContent = "Vytvořit čistou kopii"; }
  };
}

// Claude spustil `pult wait`: revize po odeslání dorazí rovnou do jeho chatu.
// Po odeslání si ji převezme a pracuje (pult progress = co právě dělá), pult archive = hotovo.
const DONE_SHOW = 30 * 60e3;
const mins = (iso) => { const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60e3)); return m < 1 ? "právě začal" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const recentDone = (b) => !b.working && b.claude_done && Date.now() - new Date(b.claude_done.at).getTime() < DONE_SHOW;
function claudeState(b) {
  if (!b) return null;
  if (b.working) return { kind: "work", head: `Claude pracuje · ${mins(b.working.since)}`, text: b.working.text || "Zapracovává tvoji revizi" };
  if (recentDone(b)) return { kind: "done", head: `Claude hotovo · ${ago(b.claude_done.at)}`, text: b.claude_done.text || "Revize je zapracovaná" };
  if (b.waiting && b.status === "open") return { kind: "wait", head: "Claude čeká na tvoji revizi", text: "" };
  return null;
}
function renderClaude() {
  const work = S.batches.filter((b) => b.working), done = S.batches.filter(recentDone);
  const btn = $("#claudeBtn");
  btn.hidden = !work.length && !done.length;
  btn.classList.toggle("work", !!work.length);
  btn.classList.toggle("done", !work.length && !!done.length);
  $("#claudeLbl").textContent = work.length ? (work.length > 1 ? `Claude pracuje · ${work.length}` : "Claude pracuje") : "Claude hotovo";
  btn.title = work.length ? "Na čem Claude právě pracuje" : "Co Claude nedávno dodělal";
  if ($("#claudePop")) claudePop(true);
}
function claudePop(refresh = false) {
  const old = $("#claudePop");
  if (old && !refresh) { old.remove(); return; }
  const list = [...S.batches.filter((b) => b.working), ...S.batches.filter(recentDone)];
  if (!list.length) { if (old) old.remove(); return; }
  const p = old || document.createElement("div");
  p.id = "claudePop"; p.className = "claude-pop";
  p.innerHTML = `<div class="cp-h">${icon("spark")}Claude</div>` + list.map((b) => { const c = claudeState(b);
    return `<button class="cp-row ${c.kind}" data-id="${esc(b.id)}"><i class="cp-dot"></i><span class="cp-b"><b>${esc(b.title)}</b><span class="cp-s">${esc(c.head)}</span><span class="cp-t">${esc(c.text)}</span></span></button>`; }).join("");
  if (!old) {
    $("#layer").appendChild(p);
    const r = $("#claudeBtn").getBoundingClientRect();
    p.style.top = r.bottom + 8 + "px"; p.style.left = Math.max(8, Math.min(innerWidth - 348, r.left - 40)) + "px";
    setTimeout(() => document.addEventListener("pointerdown", function out(e) { if (!p.contains(e.target) && !e.target.closest("#claudeBtn")) { p.remove(); document.removeEventListener("pointerdown", out, true); } }, true), 0);
  }
  p.onclick = (e) => { const r = e.target.closest(".cp-row"); if (r) { p.remove(); openBatch(r.dataset.id); } };
}
$("#claudeBtn").onclick = () => claudePop();
setInterval(() => { if (S.batches.some((b) => b.working || b.claude_done)) { renderClaude(); renderWait(); } }, 30e3);
function renderWait() {
  renderClaude();
  const s = S.batch && S.batches.find((x) => x.id === S.batch.id), c = claudeState(s), on = !!c;
  const el = $("#waitBadge");
  el.hidden = !on;
  el.className = "wait-badge" + (c ? " " + c.kind : "");
  el.innerHTML = c ? `<span>${esc(c.head)}</span>${c.text && c.kind !== "wait" ? `<small>${esc(c.text)}</small>` : ""}` : "";
  el.title = c && c.kind === "wait" ? "Až klikneš na Odeslat revizi, dorazí rovnou do chatu, který dávku poslal." : c ? c.text : "";
  $("#submitBtn").title = c && c.kind === "wait" ? "Odeslat revizi Claudovi do chatu (⌘Enter)" : "Uložit revizi pro Clauda (⌘Enter). Uvidí ji, až mu napíšeš „koukni na pult“.";
}
on("batches-loaded", renderWait);
function renderItembar() {
  const it = P.item();
  $("#itemNo").textContent = it ? `#${String(it.n).padStart(2, "0")}` : "";
  $("#itemName").textContent = it ? it.name : "";
  renderAgentNote();
  renderAiMeta(it);
  const fb = $("#fileBtn");
  fb.hidden = !(it && it.state === "ready");
  if (it) {
    const what = it.kind === "video" ? "video" : "obrázek";
    fb.title = isTouch ? `Sdílet nebo stáhnout ${what}` : `Sdílet ${what}: přetáhni ho do Zpráv, Mailu nebo Finderu, nebo klikni (zkopírovat, ukázat ve Finderu…)`;
  }
  // jako ikona dokumentu v titulku okna na Macu: za název položky jde soubor rovnou vytáhnout
  $("#itemId").draggable = !!(it && it.state === "ready" && !isTouch);
  $("#itemId").title = it && it.state === "ready" && !isTouch ? "Přetáhni do Zpráv, Mailu nebo Finderu" : "";
  const m = [];
  if (it && it.state === "ready") {
    const w = it.src_width || it.width, h = it.src_height || it.height;
    if (w) m.push(`${w}×${h}`);
    if (it.kind === "video") { m.push(`${+(+it.fps).toFixed(3)} fps`); m.push(fmtTC(Math.max(0, it.duration - 0.5 / it.fps), it.fps)); if (!it.audio) m.push("bez zvuku"); }
  } else if (it) m.push(it.state === "error" ? "chyba přípravy" : "připravuje se");
  if (S.batch && S.batch.items.length > 1 && it) m.push(`${it.n} z ${S.batch.items.length}`);
  $("#itemMeta").textContent = m.join(" · ");
  $(".itembar").style.visibility = it ? "" : "hidden";
}
// ---------- soubor ven z Pultu: přetáhnout do Zpráv, Mailu nebo Finderu, zkopírovat, sdílet ----------
const fileUrl = (it) => `/api/file/${encodeURIComponent(S.batch.id)}/${it.n}`;
const MIME = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic" };
const mimeOf = (name) => MIME[(name.split(".").pop() || "").toLowerCase()] || "application/octet-stream";
function fileDrag(e, it) {
  if (!it || it.state !== "ready") return e.preventDefault();
  const url = location.origin + fileUrl(it), name = it.name.replace(/[:\\/]/g, "-");
  // Chrome a Edge: soubor se stáhne až při puštění (Zprávy, Mail, Finder, plocha)
  e.dataTransfer.setData("DownloadURL", `${mimeOf(name)}:${name}:${url}`);
  e.dataTransfer.setData("text/uri-list", url);
  e.dataTransfer.effectAllowed = "copy";
  const th = it.thumb && $(`#strip .st[data-n="${it.n}"] img`);
  if (th && th.complete) e.dataTransfer.setDragImage(th, th.width / 2, th.height / 2);
}
async function shareFile(it) {
  toast("Připravuju soubor…");
  try {
    const blob = await (await fetch(fileUrl(it))).blob();
    const f = new File([blob], it.name, { type: mimeOf(it.name) });
    if (!navigator.canShare || !navigator.canShare({ files: [f] })) return toast("Tenhle prohlížeč sdílení souborů neumí");
    await navigator.share({ files: [f], title: it.name });
  } catch (e) { if (e && e.name !== "AbortError") toast("Sdílení se nepovedlo"); }
}
function fileMenu(anchor, it) {
  const local = S.local;
  menu(anchor, [
    local && { label: "Kopírovat soubor (pak ⌘V ve Zprávách)", icon: "copy", run: async () => {
      const r = await api("POST", "/api/copy-file", { id: S.batch.id, n: it.n }).catch(() => null);
      toast(r && r.ok ? "Zkopírováno. Ve Zprávách dej ⌘V" : "Kopírování se nepovedlo");
    } },
    local && { label: "Ukázat ve Finderu", icon: "folder", run: () => api("POST", "/api/open", { what: "source", id: S.batch.id, n: it.n }) },
    navigator.share && { label: "Sdílet…", icon: "send", run: () => shareFile(it) },
    { label: "Stáhnout", icon: "install", run: () => { const a = document.createElement("a"); a.href = fileUrl(it); a.download = it.name; a.click(); } },
  ]);
}
$("#fileBtn").addEventListener("dragstart", (e) => fileDrag(e, P.item()));
$("#itemId").addEventListener("dragstart", (e) => fileDrag(e, P.item()));
$("#fileBtn").addEventListener("click", (e) => { const it = P.item(); if (it) fileMenu(e.currentTarget, it); });
$("#strip").addEventListener("dragstart", (e) => { const el = e.target.closest(".st"); if (el) fileDrag(e, S.batch.items.find((x) => x.n === +el.dataset.n)); });

// poznámka od Clauda (pult add -m / --item-note, pult note): k dávce a k právě otevřené položce
function renderAgentNote() {
  const el = $("#agentNote"), an = (S.batch && S.batch.agent_notes) || {}, it = P.item();
  const parts = [];
  if (an["0"]) parts.push(`<div class="an-t">${esc(an["0"])}</div>`);
  if (it && an[String(it.n)]) parts.push(`<div class="an-t">${S.batch.items.length > 1 ? `<b>#${String(it.n).padStart(2, "0")}</b> ` : ""}${esc(an[String(it.n)])}</div>`);
  el.hidden = !parts.length;
  el.innerHTML = parts.length ? `<div class="an-h">${icon("spark")}<span>Claude</span></div>${parts.join("")}` : "";
  $("#notesBtn").classList.toggle("has-agent", parts.length > 0);
}

function renderStrip() {
  const strip = $("#strip");
  if (!S.batch || S.batch.items.length < 2 && S.batch.items.every((x) => x.state === "ready")) { strip.innerHTML = ""; return; }
  strip.innerHTML = S.batch.items.map((it) => {
    const ready = it.state === "ready" && it.thumb;
    const inner = ready ? `<img loading="lazy" src="${P.media(it.thumb)}" alt="">` : icon(it.state === "error" ? "x" : it.kind === "video" ? "film" : "image");
    const w = ready && it.width && it.height ? Math.round(Math.min(160, Math.max(36, (64 * it.width) / it.height))) : 96;
    return `<button class="st${ready ? "" : " ph"}" data-n="${it.n}" title="${esc(it.name)}${ready ? " (přetáhni do Zpráv nebo Finderu)" : ""}" draggable="${ready}" style="width:${w}px">${inner}<span class="no">#${String(it.n).padStart(2, "0")}</span>
      ${it.kind === "video" && ready ? `<span class="kind">${icon("play")}</span>` : ""}<span class="v"></span><span class="dots"></span>
      ${!ready && it.state !== "error" ? `<span class="pbar"><i style="width:${Math.round((it.progress || 0) * 100)}%"></i></span>` : ""}</button>`;
  }).join("");
  markStrip();
}
function markStrip() {
  if (!S.batch) return;
  const draw = new Set(Object.values(S.notes.strokes).map((s) => s.n)), com = new Set(Object.values(S.notes.comments).map((c) => c.n));
  $$("#strip .st").forEach((el) => {
    const n = +el.dataset.n, v = S.notes.verdicts[n];
    el.classList.toggle("on", n === S.n);
    const vb = $(".v", el);
    vb.className = "v" + (v ? " v-" + v.v : "");
    vb.innerHTML = v ? icon(v.v === "ok" ? "check" : "x") : "";
    $(".dots", el).innerHTML = (draw.has(n) ? "<i></i>" : "") + (com.has(n) ? '<i class="c"></i>' : "");
  });
}
$("#strip").addEventListener("click", (e) => { const el = e.target.closest(".st"); if (el) goTo(+el.dataset.n); });
on("strip", markStrip);

// ---------- živé zprávy ze serveru ----------
let esRetry = 0;
function connect() {
  const es = new EventSource(`/api/events?c=${encodeURIComponent(clientId)}`);
  es.onopen = () => { S.online = true; esRetry = 0; N.setNet(); N.flush(); };
  es.onerror = () => {
    S.online = false; N.setNet();
    if (es.readyState !== EventSource.CLOSED) return; // prohlížeč se připojí sám
    // spojení skončilo natrvalo (server odmítl, třeba nový kód): zkusit znovu, při 401 požádat o kód
    es.close();
    fetch("/api/time", { cache: "no-store" }).then((r) => { if (r.status === 401) N.askCode(); }).catch(() => {});
    setTimeout(connect, Math.min(15000, 1500 * 2 ** esRetry++));
  };
  es.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handle(m).catch((e) => console.warn(e));
  };
}
async function handle(m) {
  switch (m.type) {
    case "hello": {
      if (m.version && m.version !== VERSION && sessionStorage.getItem("pult.reloadFor") !== m.version) {
        try { sessionStorage.setItem("pult.reloadFor", m.version); } catch {}
        return location.reload();
      }
      S.local = m.local;
      app.classList.toggle("remote", !m.local);
      clock.sync();
      await loadSettings();
      await loadBatches();
      if (S.batch) refreshBatch(); // po výpadku spojení jen dočíst data, obraz zůstane, kde byl
      else await initialOpen(m);
      presence();
      if (!S.me.name) welcome();
      break;
    }
    case "batches": {
      refreshSoon();
      if (m.agent) {  // agent odklidil dávku vyřešenou v chatu: říct to a nabídnout vrácení
        toast(`Claude odklidil „${m.title}“${m.note ? ": " + m.note : ""}`, { ms: 8000, action: "Vrátit", onAction: async () => {
          await api("POST", `/api/batch/${encodeURIComponent(m.batch)}/status`, { status: "open", from: clientId });
          await loadBatches();
          openBatch(m.batch);
        } });
      }
      if (S.batch && m.batch === S.batch.id) {
        if (m.status && m.from !== clientId && m.status !== S.batch.status) {
          if (m.status === "dismissed") {
            if (!m.agent) toast(`Dávku „${S.batch.title}“ někdo smazal.`);
            return m.replacedBy ? openBatch(m.replacedBy) : openNextOpen(S.batch.id);
          }
        }
        refreshBatch();
      } else if (m.new && !S.batch) {
        await loadBatches();
        if (m.batch) openBatch(m.batch);
      } else if (m.new) {
        const b = (await loadBatches()).find((x) => x.id === m.batch);
        if (b) toast(`Nová dávka: ${b.title}`, { action: "Otevřít", onAction: () => openBatch(b.id) });
        if (b) Native.notify(isEN() ? "New batch on Pult" : "Nová dávka na Pultu", b.title, b.id);
      }
      break;
    }
    case "item": {
      if (!S.batch || m.batch !== S.batch.id) return;
      const i = S.batch.items.findIndex((x) => x.n === m.item.n);
      if (i < 0) { S.batch.items.push(m.item); renderStrip(); renderHeader(); return; }
      const was = S.batch.items[i].state;
      S.batch.items[i] = m.item;
      if (was !== "ready" && m.item.state === "ready" && m.item.kind === "video" && S.batch.items.every((x) => x.state === "ready" || x.state === "error"))
        Native.notify(isEN() ? "Previews are ready" : "Náhledy jsou připravené", S.batch.title, S.batch.id);
      renderStrip();
      if (m.item.n === S.n) { renderItembar(); if (was !== m.item.state || m.item.state !== "ready") P.showItem().then(() => N.updateAnchor()); }
      break;
    }
    case "items": if (S.batch && m.batch === S.batch.id) refreshBatch(); break;
    case "agent-notes": if (S.batch && m.batch === S.batch.id) { S.batch.agent_notes = m.notes; renderAgentNote(); } break;
    case "progress": {
      if (!S.batch || m.batch !== S.batch.id) return;
      const it = S.batch.items.find((x) => x.n === m.n);
      if (it) it.progress = m.progress;
      const bar = $(`.st[data-n="${m.n}"] .pbar i`);
      if (bar) bar.style.width = Math.round(m.progress * 100) + "%";
      if (m.n === S.n) { P.setPrepProgress(m.progress); $("#prepText").textContent = `Připravuji náhled… ${Math.round(m.progress * 100)} %`; }
      break;
    }
    case "notes": if (S.batch && m.batch === S.batch.id && m.from !== clientId) N.applyChange(m.change, false); break;
    case "live": D.onLive(m); break;
    case "dict-claim": Dict.onClaim(m); break;
    case "presence": S.people = m.people; renderPeople(); break;
    case "sync": if (m.from !== clientId) P.applyRemote(m); break;
    case "focus": if (m.from !== clientId) P.applyFocus(m); break;
    case "submitted": {
      refreshSoon();
      if (S.batch && m.batch === S.batch.id && m.from !== clientId) {
        toast(`${m.by || "Někdo"} odeslal revizi této dávky.`);
        refreshBatch();
      }
      break;
    }
    case "dictation": Dict.onMessage(m); break;
    case "reload": location.reload(); break;
  }
}
let refreshTimer = 0;
function refreshBatch() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (!S.batch) return;
    try {
      const r = await api("GET", `/api/batch/${encodeURIComponent(S.batch.id)}`);
      const before = JSON.stringify(S.batch.items.map((x) => [x.n, x.state]));
      S.batch = r.batch;
      N.setNotes(r.notes, S.batch.id);
      renderHeader(); N.render(); N.summary();
      if (JSON.stringify(S.batch.items.map((x) => [x.n, x.state])) !== before) { renderStrip(); renderItembar(); if (!P.item() || P.item().state !== "ready" || $("#wrap").hidden) P.showItem(); }
      else markStrip();
    } catch {}
  }, 200);
}
async function initialOpen(hello) {
  const h = decodeURIComponent(location.hash.slice(1)).split("/");
  const want = h[0] && S.batches.find((b) => b.id === h[0]);
  if (want) return openBatch(want.id, +h[1] || 1, true);
  if (S.together && hello.sync && S.batches.some((b) => b.id === hello.sync.batch)) {
    await openBatch(hello.sync.batch, hello.sync.n || 1, true);
    return P.applyRemote({ ...hello.sync, playing: false, from: "server" });
  }
  const last = store.get("batch");
  const b = S.batches.find((x) => x.id === last && x.status === "open") || S.batches.find((x) => x.status === "open");
  if (b) return openBatch(b.id, 1, true);
  showEmpty();
}
addEventListener("hashchange", () => {
  const h = decodeURIComponent(location.hash.slice(1)).split("/");
  if (h[0] && (!S.batch || S.batch.id !== h[0])) openBatch(h[0], +h[1] || 1);
  else if (S.batch && +h[1] && +h[1] !== S.n) goTo(+h[1]);
});

// ---------- lidé na pultu ----------
let presTimer = 0, presLast = "";
function presence() {
  clearTimeout(presTimer);
  presTimer = setTimeout(() => {
    const body = { from: clientId, name: S.me.name, color: S.me.color, batch: S.batch && S.batch.id, n: S.n, frame: P.isVideo() ? P.curFrame() : 0, playing: P.isVideo() && !P.vid.paused, together: S.together };
    const key = JSON.stringify(body);
    if (key === presLast) return;
    presLast = key;
    api("POST", "/api/presence", body).catch(() => {});
  }, 300);
}
setInterval(() => { presLast = ""; presence(); }, 20000);
on("frame", () => { if (P.vid.paused) presence(); });
on("playstate", presence);
on("me-changed", () => { presence(); renderPeople(); N.render(); });
function renderPeople() {
  const box = $("#people");
  const others = S.people.filter((p) => p.id !== clientId && p.name);
  const seen = new Set(), list = [];
  for (const p of others) { if (!seen.has(p.name)) { seen.add(p.name); list.push(p); } }
  box.innerHTML = list.slice(0, 6).map((p) => {
    const b = S.batches.find((x) => x.id === p.batch);
    const where = b ? `${b.title} · #${String(p.n).padStart(2, "0")}` : "na pultu";
    return `<span class="av${p.playing ? " play" : ""}" style="--c:${esc(p.color || "#666")}" data-id="${esc(p.id)}" title="${esc(p.name)}: ${esc(where)}${p.together ? " · Spolu" : ""} (klikni a přejdi tam)">${esc(initials(p.name))}</span>`;
  }).join("") + (list.length > 6 ? `<span class="av" style="--c:#444">+${list.length - 6}</span>` : "");
}
$("#people").addEventListener("click", async (e) => {
  const a = e.target.closest(".av[data-id]");
  const p = a && S.people.find((x) => x.id === a.dataset.id);
  if (!p || !p.batch) return;
  if (!S.batch || S.batch.id !== p.batch) await openBatch(p.batch, p.n || 1);
  else await goTo(p.n || 1);
  if (P.isVideo()) P.seekFrame(p.frame || 0, false);
});

// ---------- spolu ----------
function setTogether(v, announce = true) {
  S.together = v; store.set("together", v);
  $("#togetherBtn").classList.toggle("on", v);
  if (v) P.publish(); else S.leader = false;
  presence();
  if (announce) toast(v ? "Přehrávání se sdílí se všemi, kdo mají zapnuté Spolu." : "Přehráváš sám.", { ms: 2200 });
}
$("#togetherBtn").onclick = () => setTogether(!S.together);
setTogether(S.together, false);

// ---------- panely ----------
function wide() { return innerWidth > 1180; }
function toggleSide() {
  if (wide()) { app.classList.toggle("no-side"); store.set("noSide", app.classList.contains("no-side")); }
  else { app.classList.remove("drawer-notes"); app.classList.toggle("drawer-side"); }
  requestAnimationFrame(P.layout);
}
function toggleNotes(force) {
  if (wide()) { app.classList.toggle("no-notes", force === undefined ? undefined : !force); store.set("noNotes", app.classList.contains("no-notes")); }
  else { app.classList.remove("drawer-side"); app.classList.toggle("drawer-notes", force); }
  requestAnimationFrame(P.layout);
}
if (store.get("noSide", false)) app.classList.add("no-side");
if (store.get("noNotes", false)) app.classList.add("no-notes");
$("#sideBtn").onclick = toggleSide;
$("#sideBtnTop").onclick = toggleSide;
$("#notesBtn").onclick = () => toggleNotes();
on("show-notes", () => toggleNotes(true));
on("layout", () => requestAnimationFrame(P.layout));
on("hide-drawers", () => app.classList.remove("drawer-side", "drawer-notes"));

// iPad: Safari umí posunout celou stránku (klávesnice v panelu, zavření panelu) a nechat ji posunutou.
// Rozvržení se nikdy neposouvá, posouvají se jen seznamy uvnitř: všechno vrátit na místo.
const layoutBoxes = [document.scrollingElement, document.documentElement, document.body, app, $(".center"), $("#stage")];
function unscroll() {
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && window.visualViewport && visualViewport.height < innerHeight - 80) return;  // klávesnice je venku
  for (const el of layoutBoxes) if (el && (el.scrollTop || el.scrollLeft)) { el.scrollTop = 0; el.scrollLeft = 0; }
  if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
}
addEventListener("scroll", () => requestAnimationFrame(unscroll), { passive: true });
document.addEventListener("scroll", (e) => { if (layoutBoxes.includes(e.target)) requestAnimationFrame(unscroll); }, { capture: true, passive: true });
document.addEventListener("focusout", () => setTimeout(unscroll, 150));
if (window.visualViewport) visualViewport.addEventListener("resize", () => setTimeout(unscroll, 150));
new MutationObserver(() => setTimeout(unscroll, 80)).observe(app, { attributes: true, attributeFilter: ["class"] });
addEventListener("orientationchange", () => setTimeout(unscroll, 300));
$("#stage").addEventListener("pointerdown", () => { if (!wide()) app.classList.remove("drawer-side", "drawer-notes"); });
$("#settingsBtn").onclick = () => openSettings();
$("#teamBtn").onclick = () => openSettings("team");
on("open-settings", (tab) => openSettings(tab));
$("#helpBtn").onclick = openHelp;
$("#brand").onclick = (e) => { e.preventDefault(); if (!wide()) toggleSide(); };

// ---------- události mezi moduly ----------
on("open-batch", ({ id }) => openBatch(id));
on("goto", async ({ n, frame }) => {
  if (n !== S.n) await goTo(n);
  if (frame != null && P.isVideo()) { if (!P.vid.paused) P.vid.pause(); P.seekFrame(frame); }
});
on("clear-frame", () => D.clearFrame());
on("swipe-item", (d) => step(d));
on("submitted", ({ batch }) => { openNextOpen(batch); authorCardSoon(); });
on("batch-left", ({ id }) => { if (S.batch && S.batch.id === id) openNextOpen(id); });
on("batch-renamed", ({ id, title }) => { if (S.batch && S.batch.id === id) { S.batch.title = title; renderHeader(); } });
on("need-name", welcome);
on("kbar", P.kbarPoke);
on("zoom-pan", P.applyZoom);
on("before-play", () => {});

function step(d) {
  if (!S.batch) return;
  const to = S.n + d;
  if (to < 1 || to > S.batch.items.length) {
    $("#wrap").animate([{ transform: "translateX(0)" }, { transform: `translateX(${d < 0 ? 18 : -18}px)` }, { transform: "translateX(0)" }], { duration: 220, easing: "ease-out" });
    return toast(S.batch.items.length === 1 ? "V dávce je jen jedna položka." : d < 0 ? "Tohle je první položka." : "Tohle je poslední položka.", { ms: 1300 });
  }
  goTo(to);
}

// ---------- klávesové zkratky ----------
document.addEventListener("keydown", (e) => {
  const tag = e.target.tagName, typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable;
  const mod = e.metaKey || e.ctrlKey, k = e.key;
  if (k === "Escape") {
    if (closeMenu()) return;
    if (dialogs.length) { dialogs[dialogs.length - 1](); return; }
    if (S.kino) { P.setKino(false); return; }
    if (!wide()) app.classList.remove("drawer-side", "drawer-notes");
    return;
  }
  if (typing || anyDialog()) return;
  // Klávesy, které se na české (a jiné) klávesnici píšou jinak, se berou podle fyzické polohy (e.code):
  // čísla barev (na české klávesnici +ěščřž), [ ], \, čárka a tečka.
  const c = e.code || "";
  if (Side.keydown(e)) return;
  if (mod && k.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? D.redo() : D.undo(); return; }
  if (mod && k === "Enter") { e.preventDefault(); N.submit(); return; }
  if (mod && (c === "Digit0" || c === "Equal" || c === "Minus" || k === "+" || k === "-")) {
    e.preventDefault();
    const r = $("#viewport").getBoundingClientRect();
    if (c === "Digit0") P.resetZoom(); else P.zoomAt(r.left + r.width / 2, r.top + r.height / 2, c === "Minus" || k === "-" ? 1 / 1.25 : 1.25);
    return;
  }
  if (mod || e.altKey) return;
  const used = () => e.preventDefault();
  const digit = /^(Digit|Numpad)([0-9])$/.exec(c);
  if (digit) {
    used();
    if (digit[2] === "0") P.resetZoom();
    else if (+digit[2] <= 6) D.colorAt(+digit[2] - 1);
    return;
  }
  if (!e.shiftKey && (c === "Comma" || c === "Period")) { used(); P.isVideo() ? P.step(c === "Comma" ? -1 : 1) : step(c === "Comma" ? -1 : 1); return; }
  if (c === "BracketLeft" || c === "BracketRight") { used(); D.sizeStep(c === "BracketLeft" ? -1 : 1); return; }
  if (c === "Backslash") { used(); toggleNotes(); return; }
  switch (k) {
    case " ": used(); P.toggle(); P.kbarPoke(); break;
    case "k": case "K": used(); P.pause(); P.kbarPoke(); break;
    case "j": case "J": used(); P.shuttle(-1); break;
    case "l": used(); P.shuttle(1); break;
    case "L": used(); P.setLoop(!S.loop); toast(S.loop ? "Smyčka zapnutá" : "Smyčka vypnutá", { ms: 1200 }); break;
    case "ArrowLeft": used(); P.isVideo() ? P.jump(e.shiftKey ? -1 : -5) : step(-1); break;
    case "ArrowRight": used(); P.isVideo() ? P.jump(e.shiftKey ? 1 : 5) : step(1); break;
    case "ArrowUp": case "PageUp": used(); step(-1); break;
    case "ArrowDown": case "PageDown": used(); step(1); break;
    case "Home": used(); P.goEdge(false); break;
    case "End": used(); P.goEdge(true); break;
    case "<": used(); P.rateStep(-1); break;
    case ">": used(); P.rateStep(1); break;
    case "m": case "M": used(); P.toggleMute(); break;
    case "f": case "F": used(); P.setKino(!S.kino); break;
    case "d": case "D": used(); Dict.toggle(); break;
    case "n": used(); if (!P.nextNote(1)) toast("Další připomínka už není", { ms: 1200 }); break;
    case "N": used(); if (!P.nextNote(-1)) toast("Předchozí připomínka už není", { ms: 1200 }); break;
    case "c": case "C": used(); N.focusComposer(); break;
    case "s": case "S": used(); N.setVerdict("ok"); break;
    case "x": case "X": used(); N.setVerdict("no"); break;
    case "t": case "T": used(); setTogether(!S.together); break;
    case "g": case "G": used(); P.cycleZones(); break;
    case "p": case "P": used(); D.setTool("pen"); break;
    case "a": case "A": used(); D.setTool("arrow"); break;
    case "o": case "O": used(); D.setTool("ellipse"); break;
    case "r": case "R": used(); D.setTool("rect"); break;
    case "e": case "E": used(); D.setTool("eraser"); break;
    case "[": used(); D.sizeStep(-1); break;
    case "]": used(); D.sizeStep(1); break;
    case "Delete": case "Backspace": used(); D.clearFrame(); break;
    case "b": case "B": used(); toggleSide(); break;
    case "\\": used(); toggleNotes(); break;
    case "?": used(); openHelp(); break;
  }
});

// ---------- nativní aplikace pro macOS: menu, Dock, okno ----------
const zoomCenter = (f) => { const r = $("#viewport").getBoundingClientRect(); P.zoomAt(r.left + r.width / 2, r.top + r.height / 2, f); };
Native.init({
  state: () => {
    const open = S.batches.filter((b) => b.status === "open");
    return {
      lang: document.documentElement.lang, version: VERSION, local: !!S.local,
      sidebar: wide() ? !app.classList.contains("no-side") : app.classList.contains("drawer-side"),
      notes: wide() ? !app.classList.contains("no-notes") : app.classList.contains("drawer-notes"),
      batch: !!S.batch, item: !!P.item(), video: P.isVideo(), playing: P.isVideo() && !P.vid.paused,
      loop: !!S.loop, stopAtNotes: !!S.stopAtNotes, muted: !!P.vid.muted, kino: !!S.kino, together: !!S.together,
      canSend: !!S.batch && S.batch.status === "open", modal: anyDialog(), busy: Side.busy(),
      toReview: open.length, batches: open.slice(0, 20).map((b) => ({ id: b.id, title: b.title })),
    };
  },
  commands: {
    "add-files": () => pickFiles(null),
    "add-to-batch": () => S.batch && pickFiles(S.batch.id),
    "add-paths": (a) => Side.addPaths(a.files, a.title, a.useInputTarget),
    "open-batch": (a) => openBatch(a.id, a.n || 1),
    "reveal-batch": () => S.batch && api("POST", "/api/open", { what: "batch", id: S.batch.id }),
    "reveal-library": () => api("POST", "/api/open", { what: "library" }),
    "send-review": () => N.submit(),
    find: () => { if (wide() ? app.classList.contains("no-side") : !app.classList.contains("drawer-side")) toggleSide(); const s = $("#search"); s.focus(); s.select(); },
    undo: () => D.undo(), redo: () => D.redo(),
    settings: () => openSettings(), help: () => openHelp(),
    "toggle-sidebar": () => toggleSide(), "toggle-notes": () => toggleNotes(),
    theater: () => P.setKino(!S.kino), zones: () => P.cycleZones(),
    "zoom-in": () => zoomCenter(1.25), "zoom-out": () => zoomCenter(1 / 1.25), "zoom-reset": () => P.resetZoom(),
    "play-pause": () => { P.toggle(); P.kbarPoke(); }, pause: () => P.isVideo() && P.pause(),
    "frame-prev": () => (P.isVideo() ? P.step(-1) : step(-1)), "frame-next": () => (P.isVideo() ? P.step(1) : step(1)),
    back: () => (P.isVideo() ? P.jump(-5) : step(-1)), forward: () => (P.isVideo() ? P.jump(5) : step(1)),
    start: () => P.goEdge(false), end: () => P.goEdge(true),
    "item-prev": () => step(-1), "item-next": () => step(1),
    "note-next": () => P.nextNote(1), "note-prev": () => P.nextNote(-1),
    slower: () => P.rateStep(-1), faster: () => P.rateStep(1),
    loop: () => P.setLoop(!S.loop), "stop-at-notes": () => P.setStopAtNotes(!S.stopAtNotes), mute: () => P.toggleMute(),
    together: () => setTogether(!S.together),
    approve: () => N.setVerdict("ok"), reject: () => N.setVerdict("no"),
    comment: () => N.focusComposer(), dictate: () => Dict.toggle(),
    tool: (t) => D.setTool(t), "clear-frame": () => D.clearFrame(),
  },
});

// ---------- start ----------
if ("serviceWorker" in navigator && (location.hostname === "localhost" || location.protocol === "https:" || location.hostname === "127.0.0.1")) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
dbg("load", VERSION, innerWidth + "x" + innerHeight, isTouch);
connect();
