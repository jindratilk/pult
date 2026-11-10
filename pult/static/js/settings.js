// Pult: nastavení, tým (sdílení v síti), klávesové zkratky, první spuštění a instalace jako aplikace.
import { $, $$, S, store, api, esc, icon, emit, toast, dialog, confirmBox, copyText, fmtSize, COLORS, MOD, isTouch, initials } from "./core.js";
import { LANG, setLang } from "./i18n.js";
import { setLoop, setStopAtNotes, avDelayMs, setAvDelay, detectAudioOut, AV_BT_MS } from "./player.js";
import { setFinger } from "./draw.js";
import { mics, BT_MIC } from "./dictate.js";

let installPrompt = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; });
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true || /PultApp\//.test(navigator.userAgent);

export async function loadSettings() {
  try { S.settings = await api("GET", "/api/settings"); } catch { S.settings = { local: false }; }
  return S.settings;
}
async function save(changes) {
  try { S.settings = await api("POST", "/api/settings", { settings: changes }); toast("Uloženo", { ms: 1000 }); return true; }
  catch (e) { toast("Nastavení se nepodařilo uložit: " + e.message, { error: true }); return false; }
}

const toggle = (id, label, sub, on) => `<label class="toggle"><span class="lbl"><b>${label}</b>${sub ? `<small>${sub}</small>` : ""}</span><span class="sw-t"><input type="checkbox" id="${id}" ${on ? "checked" : ""}><i></i></span></label>`;
const browserName = () => /Edg\//.test(navigator.userAgent) ? "edge" : /Chrome\//.test(navigator.userAgent) ? "chrome" : /Safari\//.test(navigator.userAgent) ? "safari" : "other";

const TABS = [["profile", "Profil", "users"], ["library", "Knihovna", "folder"], ["playback", "Přehrávání", "play"], ["dictation", "Diktování", "mic"], ["team", "Tým", "link"], ["app", "Aplikace", "install"], ["about", "O Pultu", "gear"]];
const MODELS = [["whisper-large", "Whisper large-v3", "OpenAI, velký model. Nejpřesnější čeština, na Macu s Apple Silicon rychlý."],
  ["elevenlabs", "ElevenLabs Scribe v2 (cloud)", "Nejpřesnější, kvalita jako diktování v ChatGPT. Zvuk se posílá do ElevenLabs a platí se podle minut. Potřebuje API klíč níže."],
  ["whisper-turbo", "Whisper large-v3-turbo", "Menší a rychlejší, ale v češtině dělá víc chyb."],
  ["parakeet-v3", "NVIDIA Parakeet TDT 0.6B v3", "Menší a rychlejší, dělí řeč na kratší věty s přesnějšími časy."]];

export async function openSettings(tab = "profile") {
  await loadSettings();
  const v = S.settings, local = v.local;
  const body = document.createElement("div");
  body.className = "settings";
  body.innerHTML = `<nav>${TABS.filter(([k]) => local || !["library", "about"].includes(k)).map(([k, l, i]) => `<button data-tab="${k}">${icon(i)}${l}</button>`).join("")}</nav><section></section>`;
  const d = dialog({ title: "Nastavení", body, wide: true });
  const sec = $("section", body);
  const show = (t) => { $$("nav button", body).forEach((b) => b.classList.toggle("on", b.dataset.tab === t)); sec.innerHTML = ""; PANES[t](sec, d); };
  $$("nav button", body).forEach((b) => (b.onclick = () => show(b.dataset.tab)));
  show(TABS.some(([k]) => k === tab) && (local || !["library", "about"].includes(tab)) ? tab : "profile");
  return d;
}

const PANES = {
  profile(sec) {
    sec.innerHTML = `<h4>Profil</h4>
      <label class="field"><span>Jméno</span><input class="inp" id="stName" maxlength="40" placeholder="Jak tě uvidí ostatní a Claude"><small>Podepisuje kresby a komentáře. Uložené jen v tomhle prohlížeči.</small></label>
      <div class="field"><span>Jazyk</span><select class="inp" id="stLang" data-noi18n><option value="cs">Čeština</option><option value="en">English</option></select></div>
      <div class="field"><span>Barva</span><div class="colors">${COLORS.map((c) => `<button data-c="${c}" style="--c:${c}" class="${c === S.me.color ? "on" : ""}"></button>`).join("")}</div></div>`;
    $("#stLang", sec).value = LANG;
    $("#stLang", sec).onchange = (e) => setLang(e.target.value);
    const n = $("#stName", sec);
    n.value = S.me.name;
    n.onkeydown = (e) => e.stopPropagation();
    n.onchange = () => setMe({ name: n.value.trim() });
    $$(".colors button", sec).forEach((b) => (b.onclick = () => { setMe({ color: b.dataset.c }); $$(".colors button", sec).forEach((x) => x.classList.toggle("on", x === b)); }));
  },
  library(sec) {
    const v = S.settings, s = v.settings;
    sec.innerHTML = `<h4>Knihovna</h4>
      <div class="field"><span>Složka knihovny</span><div class="row"><input class="inp" id="stLib" spellcheck="false"><button class="btn" id="stLibPick">Vybrat…</button><button class="ib" id="stLibOpen" title="Otevřít">${icon("folder")}</button></div>
        <small>Sem Pult ukládá dávky, náhledy a revize pro Clauda (podsložky davky, revize, archiv). Po změně se starší dávky zobrazí, až složku vrátíš.</small></div>
      ${toggle("stInbox", "Složka Vstup", "Co do ní nahraješ (třeba export z Premiere), objeví se na Pultu. Podsložka = jedna dávka.", s.inbox_enabled)}
      <div class="field" id="stInboxRow" ${s.inbox_enabled ? "" : "hidden"}><div class="row"><input class="inp" id="stInboxPath" spellcheck="false"><button class="btn" id="stInboxPick">Vybrat…</button><button class="ib" id="stInboxOpen" title="Otevřít">${icon("folder")}</button></div></div>
      ${toggle("stCopy", "Kopírovat originály do knihovny", "Pro soubory přidané Claudem. Vypnuto = originál zůstane na svém místě a Pult si udělá jen náhled.", s.copy_originals)}
      <div class="field"><span>Úklid</span><select class="inp" id="stClean">${[[0, "Nikdy"], [7, "Po 7 dnech"], [14, "Po 14 dnech"], [30, "Po 30 dnech"], [90, "Po 90 dnech"]].map(([d, l]) => `<option value="${d}">${l}</option>`).join("")}</select>
        <small>Odeslané a smazané dávky se po této době přesunou do koše (složka kos v knihovně). Natrvalo nic nemaže.</small></div>
      <div class="row"><span class="dim grow">Koš: ${fmtSize(v.trash || 0)}</span><button class="btn danger sm" id="stTrash" ${v.trash ? "" : "disabled"}>Vysypat koš</button></div>`;
    $("#stLib", sec).value = v.library; $("#stInboxPath", sec).value = v.inbox; $("#stClean", sec).value = String(s.cleanup_days);
    for (const id of ["#stLib", "#stInboxPath"]) $(id, sec).onkeydown = (e) => e.stopPropagation();
    $("#stLib", sec).onchange = (e) => save({ library: e.target.value });
    $("#stInboxPath", sec).onchange = (e) => save({ inbox: e.target.value });
    $("#stLibPick", sec).onclick = async () => { const r = await api("POST", "/api/pick-folder", { initial: v.library }); if (r.path) { $("#stLib", sec).value = r.path; await save({ library: r.path }); emit("batches-changed"); } };
    $("#stInboxPick", sec).onclick = async () => { const r = await api("POST", "/api/pick-folder", { initial: v.inbox }); if (r.path) { $("#stInboxPath", sec).value = r.path; save({ inbox: r.path }); } };
    $("#stLibOpen", sec).onclick = () => api("POST", "/api/open", { what: "library" });
    $("#stInboxOpen", sec).onclick = () => api("POST", "/api/open", { what: "inbox" });
    $("#stInbox", sec).onchange = (e) => { $("#stInboxRow", sec).hidden = !e.target.checked; save({ inbox_enabled: e.target.checked }); };
    $("#stCopy", sec).onchange = (e) => save({ copy_originals: e.target.checked });
    $("#stClean", sec).onchange = (e) => save({ cleanup_days: +e.target.value });
    $("#stTrash", sec).onclick = async () => {
      if (!await confirmBox("Vysypat koš?", `Natrvalo se smaže ${fmtSize(v.trash)} starých dávek z koše. Vrátit to nepůjde.`, "Vysypat", true)) return;
      await api("POST", "/api/trash/empty", {}); toast("Koš vysypán"); v.trash = 0; PANES.library(sec);
    };
  },
  playback(sec) {
    const v = S.settings, s = v.settings || {};
    sec.innerHTML = `<h4>Přehrávání</h4>
      ${v.local ? `<div class="field"><span>Kvalita náhledů videa</span><select class="inp" id="stProxy"><option value="720">720p (nejlehčí, pro pomalou Wi-Fi)</option><option value="1080">1080p (doporučeno)</option><option value="1440">1440p</option><option value="2160">4K (náročné)</option></select>
        <small>Platí pro nově přidaná videa. Originál zůstává beze změny, Claude dostane přesné snímky.</small></div>` : ""}
      <div class="field"><span>Kresby při přehrávání</span><select class="inp" id="stHold"><option value="0">Jen na svém snímku</option><option value="0.5">Drží 0,5 s</option><option value="1">Drží 1 s</option><option value="2">Drží 2 s</option></select>
        <small>Kreslí se vždy do jednoho přesného snímku. Při přehrávání ji můžeš nechat chvíli svítit, ať ji stihneš vidět.</small></div>
      <div class="field"><span>Směr posouvání dvěma prsty</span><select class="inp" id="stScrub"><option value="forward">Prsty doprava = dopředu</option><option value="back">Prsty doprava = dozadu</option></select>
        <small>Posouvání ve videu dvěma prsty na trackpadu. Platí jen pro toto zařízení.</small></div>
      ${toggle("stStop", "Zastavit na připomínkách", "Přehrávání se samo zastaví na každém snímku s kresbou nebo komentářem.", S.stopAtNotes)}
      ${toggle("stLoop", "Smyčka", "Video se po konci přehraje znovu.", S.loop)}
      ${isTouch ? toggle("stFinger", "Kreslit i prstem", "Jinak prst přehrává a přepíná položky a kreslí jen Apple Pencil.", S.finger) : ""}
      <div class="field avd"><span>Posun zvuku (Spolu)</span>
        <div class="row"><input type="range" id="stAv" min="-300" max="600" step="10"><b id="stAvVal" class="av-val"></b></div>
        <div class="row"><label class="chk"><input type="checkbox" id="stAvAuto"> Automaticky</label><span id="stAvHint" class="dim grow"></span></div>
        <small>Když video koukáš na iPadu a zvuk posloucháš z tohohle zařízení (třeba AirPods na Macu), musí tohle zařízení hrát o kousek napřed. Posuň, dokud nesedí rty na zvuk. Platí jen pro toto zařízení a jen se zapnutým Spolu.</small></div>`;
    if ($("#stProxy", sec)) { $("#stProxy", sec).value = String(s.proxy || 1080); $("#stProxy", sec).onchange = (e) => save({ proxy: +e.target.value }); }
    $("#stHold", sec).value = String(S.hold);
    $("#stHold", sec).onchange = (e) => { S.hold = +e.target.value; store.set("hold", S.hold); emit("redraw"); };
    $("#stScrub", sec).value = store.get("scrubDir", "forward");
    $("#stScrub", sec).onchange = (e) => store.set("scrubDir", e.target.value);
    $("#stStop", sec).onchange = (e) => setStopAtNotes(e.target.checked);
    $("#stLoop", sec).onchange = (e) => setLoop(e.target.checked);
    if ($("#stFinger", sec)) $("#stFinger", sec).onchange = (e) => setFinger(e.target.checked);
    const av = $("#stAv", sec), avAuto = $("#stAvAuto", sec), avVal = $("#stAvVal", sec), avHint = $("#stAvHint", sec);
    const avShow = () => {
      av.value = String(avDelayMs()); avAuto.checked = S.avDelay == null;
      avVal.textContent = `${avDelayMs() > 0 ? "+" : ""}${avDelayMs()} ms`;
      avHint.textContent = S.avOut.bluetooth ? `Doporučeno ${AV_BT_MS} ms (${S.avOut.name || "Bluetooth sluchátka"})` : S.avOut.name ? `Doporučeno 0 ms (${S.avOut.name})` : "Doporučeno 0 ms, pro AirPods asi 200 ms";
    };
    av.oninput = () => { setAvDelay(+av.value); avShow(); };
    avAuto.onchange = () => { setAvDelay(avAuto.checked ? null : avDelayMs()); avShow(); };
    avShow(); detectAudioOut().then(avShow);
  },
  dictation(sec, dlg) {
    const v = S.settings, d = v.dictation || {}, h = v.https || {};
    const how = `<p>Zapneš klávesou <kbd>D</kbd> nebo mikrofonem vedle přehrávání, jednou na celou revizi. Pak pouštěj, posouvej a zastavuj video a mluv, kdy chceš: každá věta se přepíše do komentáře ke snímku, kde jsi ji začal říkat. Přepis běží na počítači s Pultem, nic nejde na internet. Nejlíp se sluchátky.</p>`;
    const ipadSteps = h.ready ? `<ol class="steps">
        <li>Na iPadu otevři <a href="${esc(h.ca)}" target="_blank"><b>certifikát Pultu</b></a> (<code>${esc((h.urls[0] || "").replace(/^https/, "http").replace(/:\d+\/.*$/, ":" + (h.port - 1)))}/pult-ca.crt</code>, otevři v Safari) a stažení povol.</li>
        <li>Nastavení iPadu › <b>Stažený profil</b> › Pult › Instalovat.</li>
        <li>Nastavení › Obecné › Informace › <b>Důvěryhodnost certifikátů</b> › zapni Pult.</li>
        <li>Otevři zabezpečený odkaz a přidej si ho na plochu (Sdílet › Přidat na plochu):</li></ol>
        ${(h.urls || []).map((u) => `<div class="linkrow"><code>${esc(u)}</code><button class="ib" data-copy="${esc(u)}" title="Zkopírovat">${icon("copy")}</button></div>`).join("")}` : `<small>${esc(h.reason || "")}</small>`;
    if (!v.local) {
      sec.innerHTML = `<h4>Diktování</h4>${how}
        ${window.isSecureContext ? `<p class="ok-t">✓ Na téhle adrese mikrofon funguje.</p>` : `<div class="note-box">Safari na iPadu pustí mikrofon jen na zabezpečené adrese (https). Jednou si nainstaluj certifikát Pultu, pak používej zabezpečený odkaz.</div>${ipadSteps}`}
        <div class="field"><span>Přepis</span><span class="dim">${d.ready ? esc(d.model || "") : esc(d.reason || "není připravený")}</span></div>
        <div class="field"><span>Mikrofon</span><select class="inp" id="stMic"><option value="auto">Automaticky (počítač, když máš sluchátka)</option><option value="default">Výchozí v systému</option></select><small>Bluetooth sluchátka (AirPods) při zapnutém mikrofonu přepnou do režimu hovoru a zvuk videa pak zní roboticky. Automatika proto diktuje do mikrofonu počítače a sluchátka dál hrají v plné kvalitě.</small></div>`;
      $$("[data-copy]", sec).forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
      micSelect(sec);
      return;
    }
    const avail = d.available || [];
    sec.innerHTML = `<h4>Diktování</h4>${how}
      <div class="field"><span>Stav</span>${d.ready ? `<span class="ok-t">✓ Připravené · ${esc(d.engine)} · ${esc(d.model)}</span>` : `<span class="no-t">✗ ${esc(d.reason || "není připravené")}</span><small>Řekni Claudovi „zapni v Pultu diktování“ (<kbd>pult dictation install</kbd>).</small>`}</div>
      <div class="row" style="margin:-4px 0 12px"><button class="btn sm" id="stDictWizard">${icon("mic")}Průvodce nastavením</button></div>
      <div class="field"><span>Mikrofon</span><select class="inp" id="stMic"><option value="auto">Automaticky (počítač, když máš sluchátka)</option><option value="default">Výchozí v systému</option></select><small>Bluetooth sluchátka (AirPods) při zapnutém mikrofonu přepnou do režimu hovoru a zvuk videa pak zní roboticky. Automatika proto diktuje do mikrofonu počítače a sluchátka dál hrají v plné kvalitě.</small></div>
      <div class="field"><span>Model pro přepis</span>${MODELS.map(([k, l, sub]) => `<label class="radio${avail.includes(k) ? "" : " dim"}"><input type="radio" name="asrModel" value="${k}" ${(d.choice || "whisper-large") === k ? "checked" : ""} ${avail.includes(k) ? "" : "disabled"}> <span><b>${l}</b><br><small>${sub}${avail.includes(k) ? "" : " Není nainstalovaný."}</small></span></label>`).join("")}</div>
      <div class="field"><span>API klíč ElevenLabs (pro cloud)</span>${d.el_key
        ? `<div class="row"><span class="ok-t grow">✓ Uložený a ověřený: <code>${esc(d.el_key)}</code></span><button class="btn sm danger" id="stElDel">Smazat</button></div>`
        : `<div class="row"><input class="inp" id="stElKey" type="password" autocomplete="off" spellcheck="false" placeholder="sk_…"><button class="btn sm primary" id="stElSave">Uložit a ověřit</button></div>`}
        <small>Klíč zůstane jen na tomhle počítači (v nastavení Pultu, čitelný jen pro tvůj účet). Na ElevenLabs stačí klíč s právem Speech to Text.</small></div>
      <div class="field"><span>Mikrofon na iPadu a u kolegů v síti</span><small>Prohlížeč pustí mikrofon jen na zabezpečené adrese (https). Pult ji má, když je zapnuté sdílení v síti (záložka Tým).</small>${ipadSteps}</div>`;
    micSelect(sec);
    $$("input[name=asrModel]", sec).forEach((r) => (r.onchange = async () => { if (await save({ asr_model: r.value })) { await loadSettings(); PANES.dictation(sec); } }));
    if ($("#stDictWizard", sec)) $("#stDictWizard", sec).onclick = () => { if (dlg && dlg.close) dlg.close(); dictationSetup(); };
    const keyInp = $("#stElKey", sec);
    if (keyInp) {
      keyInp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") $("#stElSave", sec).click(); };
      $("#stElSave", sec).onclick = async (e) => {
        const b = e.currentTarget;
        if (!keyInp.value.trim()) return keyInp.focus();
        b.disabled = true; b.textContent = "Ověřuji…";
        try {
          await api("POST", "/api/dictation/key", { key: keyInp.value.trim() });
          keyInp.value = "";
          await save({ asr_model: "elevenlabs" });
          await loadSettings(); PANES.dictation(sec);
          toast("Klíč ověřený, přepis teď jde přes ElevenLabs.");
        } catch (err) { toast(err.message, { error: true, ms: 6000 }); b.disabled = false; b.textContent = "Uložit a ověřit"; }
      };
    }
    if ($("#stElDel", sec)) $("#stElDel", sec).onclick = async () => {
      if (!await confirmBox("Smazat klíč ElevenLabs?", "Přepis se přepne zpátky na Whisper v tomhle počítači.", "Smazat", true)) return;
      await api("POST", "/api/dictation/key", { delete: true });
      await save({ asr_model: "whisper-large" });
      await loadSettings(); PANES.dictation(sec);
    };
    $$("[data-copy]", sec).forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
  },
  team(sec, d) {
    const v = S.settings, s = v.settings || {};
    const people = S.people.filter((p) => p.name).map((p) => `<span class="av" style="--c:${esc(p.color || "#666")};margin:0" title="${esc(p.name)}">${esc(initials(p.name))}</span><span>${esc(p.name)}${p.local ? "" : " <span class='dim'>(přes síť)</span>"}</span>`);
    if (!v.local) {
      sec.innerHTML = `<h4>Tým</h4><p>Jsi připojený k Pultu na počítači <b>${esc(location.host)}</b>. Kresby a komentáře uvidí všichni, kdo jsou připojení, i Claude po odeslání revize.</p>
        <p class="dim">Tlačítko <b>Spolu</b> nahoře sdílí přehrávání: kdo pustí, posune nebo přepne položku, tomu se přidají všichni, kdo mají Spolu zapnuté.</p>
        <div class="field"><span>Kdo je na pultu</span><div style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:center">${people.join("") || "<span class='dim'>Jen ty.</span>"}</div></div>`;
      return;
    }
    sec.innerHTML = `<h4>Tým</h4>
      ${toggle("stShare", "Sdílet v síti", "Kolegové ve stejné síti (kancelář, Wi-Fi, Tailscale) otevřou Pult v prohlížeči a kreslí a komentují s tebou. Přístup chrání kód.", s.share)}
      <div id="stShareBox" ${s.share ? "" : "hidden"}>
        <div class="field" style="margin-top:14px"><span>Přístupový kód</span><div class="row"><span class="code">${esc(s.access_code || "")}</span><button class="btn sm" id="stNewCode">Nový kód</button></div><small>Nový kód odpojí všechny, kdo se připojili se starým.</small></div>
        <div class="field"><span>Odkaz pro kolegy (kód už obsahuje)</span>${(v.invite || []).map((u) => `<div class="linkrow"><code>${esc(u)}</code><button class="ib" data-copy="${esc(u)}" title="Zkopírovat">${icon("copy")}</button></div>`).join("") || "<small>Počítač teď nemá síťovou adresu.</small>"}</div>
        <div class="note-box">Na Windows se při zapnutí sdílení objeví dotaz brány firewall: povol přístup v <b>soukromé síti</b>. Mimo kancelář funguje Pult přes Tailscale (stejný odkaz s adresou z Tailscale).</div>
      </div>
      <div class="field" style="margin-top:12px"><span>Kdo je na pultu</span><div style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:center">${people.join("") || "<span class='dim'>Jen ty.</span>"}</div></div>
      <p class="dim">Tlačítko <b>Spolu</b> nahoře sdílí přehrávání mezi všemi, kdo ho mají zapnuté (třeba tvůj iPad a počítač, nebo celý tým na poradě).</p>`;
    $("#stShare", sec).onchange = async (e) => { await save({ share: e.target.checked }); await loadSettings(); PANES.team(sec, d); };
    const nc = $("#stNewCode", sec);
    if (nc) nc.onclick = async () => { await api("POST", "/api/settings", { new_code: true, settings: {} }); await loadSettings(); PANES.team(sec, d); toast("Nový kód nastaven"); };
    $$("[data-copy]", sec).forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
  },
  app(sec) {
    const v = S.settings, br = browserName();
    let how;
    if (v.native_app && !/PultApp\//.test(navigator.userAgent)) how = `<p>Na tomhle Macu je Pult nainstalovaný jako aplikace. Otevři ho z Docku, verzi z prohlížeče nepotřebuješ.</p>`;
    else if (standalone()) how = `<p class="ok-t">Pult už běží jako samostatná aplikace. 👍</p>`;
    else if (installPrompt) how = `<p>Nainstaluj Pult jako aplikaci: vlastní okno, ikona v Docku nebo na hlavním panelu, bez lišty prohlížeče.</p><button class="btn primary" id="stInstall">${icon("install")}Nainstalovat Pult</button>`;
    else if (br === "safari") how = `<p>V Safari: menu <b>Soubor › Přidat do Docku</b> (na iPadu: Sdílet › Přidat na plochu).</p>`;
    else if (br === "chrome" || br === "edge") how = `<p>V adresním řádku vpravo klikni na ikonu <b>Instalovat</b> (monitor se šipkou), nebo v menu ⋮ › <b>Uložit a sdílet › Instalovat Pult</b>.</p>`;
    else how = `<p>Otevři Pult v Chrome, Edge nebo Safari a nainstaluj ho jako aplikaci.</p>`;
    sec.innerHTML = `<h4>Aplikace</h4>${how}
      ${v.local ? `<div class="field" style="margin-top:16px"><span>Pult na iPadu nebo telefonu</span><small>Zapni v záložce Tým sdílení v síti a na iPadu otevři odkaz pro kolegy. Kreslit jde Apple Pencilem i prstem.</small></div>` : ""}
      <div class="field"><span>Klávesové zkratky</span><button class="btn sm" id="stKeys" style="justify-self:start">${icon("keys")}Zobrazit (?)</button></div>`;
    if ($("#stInstall", sec)) $("#stInstall", sec).onclick = async () => { installPrompt.prompt(); const r = await installPrompt.userChoice.catch(() => null); installPrompt = null; if (r && r.outcome === "accepted") toast("Pult je nainstalovaný"); PANES.app(sec); };
    $("#stKeys", sec).onclick = () => openHelp();
  },
  about(sec) {
    const v = S.settings;
    const ff = v.ffmpeg;
    const fix = v.platform === "windows" ? "winget install Gyan.FFmpeg" : "brew install ffmpeg";
    sec.innerHTML = `<h4>O Pultu</h4>
      <p><b>Pult ${esc(v.version)}</b><br><span class="dim">Revize obrázků a videí pro práci s Claudem: kresli, komentuj, schvaluj, odešli.</span></p>
      <div class="field"><span>ffmpeg (příprava videí)</span>${ff ? `<span class="ok-t">✓ ${esc(ff.version)} · ${esc(ff.path)}</span>` : `<span class="no-t">✗ Nenalezen. Videa se nepřipraví.</span><small>Řekni Claudovi „nainstaluj ffmpeg pro Pult“, nebo spusť: <kbd>${fix}</kbd></small>`}</div>
      <div class="field"><span>Knihovna</span><code class="dim">${esc(v.library)}</code></div>
      <div class="field"><span>Nastavení</span><code class="dim">${esc(v.config)}</code></div>
      <div class="field"><span>Python</span><span class="dim">${esc(v.python)}</span></div>
      <div class="field"><span>Diktování (přepis řeči)</span>${v.dictation && v.dictation.ready ? `<span class="ok-t">✓ ${esc(v.dictation.engine)} · ${esc(v.dictation.model)}${v.dictation.cached === false ? " (stáhne se při prvním použití, asi 1,6 GB)" : ""}</span>` : `<span class="no-t">✗ ${esc((v.dictation && v.dictation.reason) || "není připravené")}</span><small>Instalace: řekni Claudovi „zapni v Pultu diktování“ (spustí <kbd>install.py --dictation</kbd>).</small>`}</div>
      ${window.PULT_AUTHOR === false ? "" : `<div class="field"><span>Autor</span><div class="row"><span class="grow">Pult vytvořil <b data-noi18n>Jan Pils</b>. Stříhám a stavím nástroje pro tvůrce.</span></div>
        <div class="row" style="margin-top:6px"><a class="btn sm" href="https://janpils.com" target="_blank" rel="noopener">Více o mně</a></div></div>`}
      <div class="field"><span>Pro Clauda</span><small>Claude ovládá Pult příkazem <kbd>pult</kbd>: <kbd>pult add</kbd> přidá dávku, <kbd>pult status</kbd> ukáže nové revize, <kbd>pult archive</kbd> označí revizi jako zpracovanou.</small></div>`;
  },
};

export function setMe(ch) {
  Object.assign(S.me, ch);
  store.set("name", S.me.name); store.set("color", S.me.color);
  emit("me-changed");
}

// ---------- první spuštění ----------
export function welcome() {
  const body = document.createElement("div");
  body.innerHTML = `<p>Pult je místo, kde procházíš obrázky a videa (třeba z AI), kreslíš přímo do snímků, píšeš komentáře a schvaluješ. Jedním tlačítkem pak revizi pošleš Claudovi.</p>
    <label class="field"><span>Jak ti říkat?</span><input class="inp" id="wName" maxlength="40" placeholder="Jméno"><small>Podepisuje tvoje kresby a komentáře.</small></label>
    <div class="field"><span>Tvoje barva</span><div class="colors">${COLORS.map((c) => `<button data-c="${c}" style="--c:${c}" class="${c === S.me.color ? "on" : ""}"></button>`).join("")}</div></div>
    ${S.local ? `<div class="note-box">${icon("upload")} Soubory přidáš přetažením do okna nebo tlačítkem <b>Přidat</b>. Claudovi stačí říct <b>„pošli to na Pult“</b>.</div>` : ""}`;
  const foot = document.createElement("div");
  foot.style.display = "contents";
  foot.innerHTML = `<button class="btn primary" data-ok>Začít</button>`;
  const d = dialog({ title: "Vítej v Pultu", body, foot, dismiss: false });
  const inp = $("#wName", d.el);
  inp.value = S.me.name;
  $$(".colors button", d.el).forEach((b) => (b.onclick = () => { S.me.color = b.dataset.c; $$(".colors button", d.el).forEach((x) => x.classList.toggle("on", x === b)); }));
  const go = () => { const n = inp.value.trim(); if (!n) { inp.focus(); return; } setMe({ name: n, color: S.me.color }); d.close(); maybeDictationSetup(); };
  $("[data-ok]", d.el).onclick = go;
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") go(); };
}

// ---------- první nastavení diktování ----------
async function maybeDictationSetup() {
  if (!S.local || store.get("dictOnboard", false)) return;
  const v = await loadSettings();
  if (v.dictation && v.dictation.ready) { store.set("dictOnboard", true); return; }
  dictationSetup();
}
// výběr mikrofonu pro diktování (pamatuje se v tomhle prohlížeči)
async function micSelect(sec) {
  const sel = $("#stMic", sec);
  if (!sel) return;
  const list = await mics();
  list.filter((d) => d.deviceId !== "default").forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.deviceId; const name = d.label || `Mikrofon ${i + 1}`;
    o.textContent = BT_MIC.test(d.label) ? `${name} (sluchátka, zvuk bude jako při hovoru)` : name;
    sel.appendChild(o);
  });
  const cur = store.get("mic", "auto");
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "auto";
  sel.onchange = () => { store.set("mic", sel.value); toast("Mikrofon změněn. Platí od dalšího zapnutí diktování."); };
}
export function dictationSetup() {
  store.set("dictOnboard", true);
  const body = document.createElement("div");
  body.className = "dset";
  body.innerHTML = `<p>Připomínky nemusíš psát: zapneš mikrofon, pouštíš video a mluvíš. Každá věta se zapíše ke snímku, kde jsi ji začal říkat. Vyber, co bude řeč přepisovat:</p>
    <label class="dopt on"><input type="radio" name="dset" value="el" checked><span><b>ElevenLabs Scribe <em>Doporučeno</em></b><small>Nejpřesnější přepis, česky i anglicky. Nic se nestahuje. Zvuk se posílá do ElevenLabs a platí se podle minut nahrávky.</small></span></label>
    <div class="dpane" data-for="el">
      <ol class="steps">
        <li>Přihlas se na <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener">elevenlabs.io › API Keys</a> (účet zdarma stačí na vyzkoušení).</li>
        <li>Klikni na <b>Create API Key</b>, u oprávnění nech jen <b>Speech to Text</b>.</li>
        <li>Klíč vlož sem. Zůstane jen na tomhle počítači.</li>
      </ol>
      <div class="row"><input class="inp" id="dsKey" type="password" autocomplete="off" spellcheck="false" placeholder="sk_…" data-noi18n><button class="btn primary" id="dsSave">Uložit a ověřit</button></div>
    </div>
    <label class="dopt"><input type="radio" name="dset" value="local"><span><b>Whisper v počítači</b><small>Zdarma a soukromé, nic neodchází z počítače. Jednou se stáhne model (asi 1,6 GB), na Macu s Apple Silicon je rychlý.</small></span></label>
    <div class="dpane" data-for="local" hidden>
      <p class="dim">Instalaci udělá Claude. Pošli mu tuhle větu:</p>
      <div class="linkrow"><code data-noi18n id="dsAsk"></code><button class="ib" id="dsCopy" title="Zkopírovat">${icon("copy")}</button></div>
    </div>
    <label class="dopt"><input type="radio" name="dset" value="none"><span><b>Teď ne</b><small>Diktování zapneš kdykoli v Nastavení › Diktování.</small></span></label>`;
  const foot = document.createElement("div");
  foot.style.display = "contents";
  foot.innerHTML = `<button class="btn" data-ok>Hotovo</button>`;
  const d = dialog({ title: "Diktování připomínek", body, foot });
  const ask = LANG === "en" ? "Turn on dictation in Pult (local Whisper)." : "Zapni v Pultu diktování (lokální Whisper).";
  $("#dsAsk", d.el).textContent = ask;
  $("#dsCopy", d.el).onclick = () => { copyText(ask); toast("Zkopírováno"); };
  $$("input[name=dset]", d.el).forEach((r) => (r.onchange = () => {
    $$(".dopt", d.el).forEach((x) => x.classList.toggle("on", x.contains(r) && r.checked));
    $$(".dpane", d.el).forEach((x) => (x.hidden = x.dataset.for !== r.value));
  }));
  const key = $("#dsKey", d.el);
  key.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") $("#dsSave", d.el).click(); };
  $("#dsSave", d.el).onclick = async (e) => {
    const b = e.currentTarget;
    if (!key.value.trim()) return key.focus();
    b.disabled = true; b.textContent = "Ověřuji…";
    try {
      await api("POST", "/api/dictation/key", { key: key.value.trim() });
      key.value = "";
      await save({ asr_model: "elevenlabs", dictation: true });
      toast("Klíč ověřený, přepis teď jde přes ElevenLabs.");
      d.close();
    } catch (err) { toast(err.message, { error: true, ms: 6000 }); b.disabled = false; b.textContent = "Uložit a ověřit"; }
  };
  $("[data-ok]", d.el).onclick = () => d.close();
}

// ---------- klávesové zkratky ----------
export function openHelp() {
  const k = (...keys) => `<span>${keys.map((x) => `<kbd>${x}</kbd>`).join("")}</span>`;
  const rows = [
    ["Přehrávání"],
    ["Přehrát / pauza", k("mezerník")], ["Stop", k("K")],
    ["Dopředu 1× → 1,5× → 2× → 1×", k("L")], ["Pozpátku 1× → 2× → 1×", k("J")],
    ["O snímek zpět / vpřed", k(","), k(".")], ["O 5 s zpět / vpřed", k("←"), k("→")], ["O vteřinu zpět / vpřed", k("⇧←"), k("⇧→")],
    ["Začátek / konec", k("Home"), k("End")], ["Rychlost 1× / 1,5× / 2×", k("tlačítka u časové osy")], ["Smyčka", k("⇧L")], ["Ztlumit", k("M")], ["Celá obrazovka (kino)", k("F")],
    ["Posun dvěma prsty", k("trackpad ⟷")], ["Přiblížit / oddálit", k(`${MOD} + kolečko`), k("sevřít prsty")], ["Přizpůsobit obraz", k("0")],
    ["Položky a připomínky"],
    ["Předchozí / další položka", k("↑"), k("↓")], ["Předchozí / další připomínka", k("⇧N"), k("N")], ["Napsat komentář k snímku", k("C")],
    ["Diktovat mikrofonem (zapnout / vypnout)", k("D")],
    ["Schválit / zamítnout položku", k("S"), k("X")], ["Odeslat revizi Claudovi", k(`${MOD} Enter`)], ["Přehrávat spolu", k("T")],
    ["Kreslení"],
    ["Pero, šipka, kroužek, obdélník", k("P"), k("A"), k("O"), k("R")], ["Guma", k("E")], ["Barvy", k("1 až 6")],
    ["Tenčí / silnější", k("["), k("]")], ["Zpět / znovu", k(`${MOD}Z`), k(`⇧${MOD}Z`)], ["Smazat kresbu na snímku", k("Delete")],
    ["Kruh / čtverec", k("⇧ při tažení")],
    ["Okno"],
    ["Dávky / připomínky", k("B"), k("\\")], ["Překryv Instagram Reels, TikTok, Shorts", k("G")], ["Zkratky", k("?")],
    ["Dávky"],
    ["Vybrat víc dávek", k(`${MOD} klik`), k("⇧ klik")], ["Smazat vybrané (po kliknutí do seznamu)", k("⌫")], ["Vybrat všechny", k(`${MOD}A`)],
  ];
  const html = `<div class="keys">${rows.map((r) => (r.length === 1 ? `<h5>${r[0]}</h5>` : `<div><span>${r[0]}</span>${r.slice(1).join("").replace(/<\/span><span>/g, "")}</div>`)).join("")}</div>`;
  dialog({ title: "Klávesové zkratky", body: html, wide: true });
}
