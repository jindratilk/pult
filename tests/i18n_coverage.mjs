// Kontrola překladu: najde české texty rozhraní, které anglická vrstva (i18n.js) nepřeloží.
// Spuštění: node tests/i18n_coverage.mjs   (exit 1, když něco chybí)
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "pult", "static");
let src = fs.readFileSync(path.join(root, "js", "i18n.js"), "utf8");
src = src.slice(0, src.indexOf("// --- překlad DOM ---")).replace(/^export /gm, "");
const ctx = { localStorage: { getItem: () => '"en"', setItem() {} }, navigator: { language: "en", languages: ["en"] }, window: {}, location: { reload() {} } };
vm.createContext(ctx);
vm.runInContext(src + ";this.tr=tr;", ctx);

// Záměrně česky: název jazyka v nastavení, české tvary, které plural() v angličtině nahradí, a text,
// který se ukazuje jen v češtině (větev pro isEN()).
const ALLOW = new Set(["Čeština", "položka", "položky", "položek", "obrázek", "obrázky", "obrázků", "komentář", "komentáře", "komentářů",
  "připomínka", "připomínky", "připomínek", "dávka", "dávky", "dávek", "dávku", "soubor", "soubory", "souborů", "videa", "videí",
  "kresba", "kresby", "kreseb", "tah", "tahy", "tahů", "revize", "revizí", "Česky"]);
const CZ = /[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/;
const found = new Map();
const clean = (v) => v.replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, "").replace(/\s+/g, " ").trim();
const add = (raw, where) => {
  if (/plural\(|\$\{[^}]*\?|" : "/.test(raw)) return;  // úlomek kódu, ne text (rozdělená šablona)
  raw = raw.replace(/["'`]\}+$/, "");
  const v = clean(raw.replace(/\$\{[^}]*\}/g, "{}"));
  if (!v || !CZ.test(v) || v.length > 260 || ALLOW.has(v)) return;
  if (!found.has(v)) found.set(v, where);
};
// místo ${…} zkusí několik typických hodnot (číslo, druh souboru, zkratka, název); stačí, když projde jedna
const SAMPLES = ["3", "video", "⌘", "Banner", ""];
// text složený z částí „a · b · c“ překládá i18n.js po částech; úlomek začínající oddělovačem je jedna z nich
const translated = (v) => SAMPLES.some((x) => { const t = clean(v.split("{}").join(x)); return !CZ.test(ctx.tr(t)) || !CZ.test(ctx.tr(t.replace(/^· /, ""))); });
const files = fs.readdirSync(path.join(root, "js")).filter((f) => f.endsWith(".js") && f !== "i18n.js").map((f) => path.join(root, "js", f));
files.push(path.join(root, "index.html"));
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    const where = `${path.basename(f)}:${i + 1}`;
    if (/\bdbg\(|console\./.test(line)) return;  // ladicí výpisy nejsou rozhraní
    const code = line.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/ .*$/, "").replace(/\/\*.*?\*\//g, "")
      // isEN() ? "English" : "česky": česká větev se v angličtině nikdy neukáže
      .replace(/isEN\(\)\s*\?\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g, "$1");
    if (/data-noi18n/.test(code) && !/</.test(code.replace(/data-noi18n[^>]*>[^<]*</g, ""))) return;
    if (f.endsWith(".html")) {
      for (const m of code.matchAll(/>([^<>]+)</g)) add(m[1], where);
      for (const m of code.matchAll(/(?:title|placeholder|aria-label)="([^"]+)"/g)) add(m[1], where);
      return;
    }
    for (const m of code.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`/g)) {
      const v = m[1] ?? m[2] ?? m[3];
      if (!CZ.test(v)) continue;
      if (/<[a-z]/i.test(v)) {
        for (const part of v.replace(/<[^>]*data-noi18n[^>]*>[^<]*</g, "<").split(/<[^>]*>/)) add(part, where);
        for (const q of v.matchAll(/(?:title|placeholder)="([^"]+)"/g)) add(q[1], where);
      } else add(v, where);
    }
  });
}
const missing = [...found].filter(([v]) => !translated(v));
for (const [v, where] of missing) console.log(`${where.padEnd(18)} ${v}`);
console.log(`\n${found.size} Czech UI strings checked, ${missing.length} not translated.`);
process.exit(missing.length ? 1 : 0);
