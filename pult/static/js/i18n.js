// Pult: jazyk rozhraní. Aplikace vykresluje česky, tahle vrstva v angličtině přeloží texty a popisky
// přímo v DOM (dřív, než se vykreslí). Uživatelský obsah (komentáře, názvy dávek a souborů) se nepřekládá.
const KEY = "pult.lang";
function pick() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "null"); if (v === "cs" || v === "en") return v; } catch {}
  if (window.PULT_DEFAULT_LANG === "cs" || window.PULT_DEFAULT_LANG === "en") return window.PULT_DEFAULT_LANG;
  const l = (navigator.languages && navigator.languages[0]) || navigator.language || "en";
  return /^(cs|sk)\b/i.test(l) ? "cs" : "en";
}
export const LANG = pick();
export function setLang(l) { try { localStorage.setItem(KEY, JSON.stringify(l)); } catch {} location.reload(); }

// přesné texty (oříznuté o mezery)
const EN = {
  "ElevenLabs: předplatné má nezaplacenou fakturu. Klíč je v pořádku, dokonči platbu na elevenlabs.io.": "ElevenLabs: your subscription has an unpaid invoice. The key is fine, complete the payment on elevenlabs.io.", "ElevenLabs: došel kredit. Klíč je v pořádku.": "ElevenLabs: out of credits. The key is fine.",
  "Mikrofon": "Microphone", "Automaticky (počítač, když máš sluchátka)": "Automatic (computer mic when you wear headphones)", "Výchozí v systému": "System default",
  "Bluetooth sluchátka (AirPods) při zapnutém mikrofonu přepnou do režimu hovoru a zvuk videa pak zní roboticky. Automatika proto diktuje do mikrofonu počítače a sluchátka dál hrají v plné kvalitě.": "Bluetooth headphones (AirPods) switch to call mode while their microphone is on, and the video sound turns robotic. Automatic mode dictates into the computer's microphone, so the headphones keep playing at full quality.",
  "Mikrofon změněn. Platí od dalšího zapnutí diktování.": "Microphone changed. It applies the next time you turn dictation on.",
  // obecné
  "Pult": "Pult", "Zrušit": "Cancel", "Uložit": "Save", "Uloženo": "Saved", "Smazat": "Delete", "Smazáno": "Deleted", "Vrátit": "Undo",
  "Otevřít": "Open", "Zavřít (Esc)": "Close (Esc)", "Pokračovat": "Continue", "Začít": "Get started", "Přidat": "Add", "Přidat (Enter)": "Add (Enter)",
  "Přejmenovat": "Rename", "Zkopírovat": "Copy", "Zkopírováno": "Copied", "Stáhnout": "Download", "Sdílet": "Share", "Sdílet…": "Share…",
  "Načítám…": "Loading…", "Ukládám": "Saving", "Ověřuji…": "Verifying…", "Odesílám…": "Sending…", "Nahrávám": "Uploading", "Nahráno": "Uploaded",
  "Doporučeno": "Recommended", "Tlačítko": "Button", "teď": "now", "právě začal": "just started", "neznámá chyba": "unknown error",
  "Nastavení": "Settings", "Profil": "Profile", "Knihovna": "Library", "Přehrávání": "Playback", "Diktování": "Dictation", "Tým": "Team",
  "Aplikace": "App", "O Pultu": "About Pult", "Jméno": "Name", "Barva": "Color", "Jazyk": "Language",
  // horní lišta a panely
  "Dávky": "Batches", "Dávky (B)": "Batches (B)", "Připomínky": "Notes", "Připomínky (\\)": "Notes (\\)", "Dávky / připomínky": "Batches / notes",
  "Spolu": "Together", "Přehrávat spolu": "Play together",
  "Přehrávat spolu: přehrávání, posun a přepínání se sdílí s ostatními zařízeními (T)": "Play together: playback, seeking and switching are shared with your other devices (T)",
  "Tým a sdílení": "Team and sharing", "Klávesové zkratky": "Keyboard shortcuts", "Klávesové zkratky (?)": "Keyboard shortcuts (?)",
  "Hledat dávku": "Search batches", "K REVIZI": "TO REVIEW", "K revizi": "To review", "Odeslané": "Sent", "Smazané": "Deleted",
  "Spojení se serverem": "Server connection", "Připojeno, vše uloženo": "Connected, everything saved", "Bez spojení se serverem Pultu": "No connection to the Pult server",
  "Zkouším se znovu připojit…": "Reconnecting…", "spojení přerušeno": "connection lost",
  "Na čem Claude právě pracuje": "What Claude is working on", "Co Claude nedávno dodělal": "What Claude recently finished",
  "Claude pracuje": "Claude is working", "Claude hotovo": "Claude is done", "Claude čeká na tvoji revizi": "Claude is waiting for your review",
  "Zapracovává tvoji revizi": "Working on your review", "Revize je zapracovaná": "Review is done", "pracuje": "working", "hotovo": "done",
  "Až klikneš na Odeslat revizi, dorazí rovnou do chatu, který dávku poslal.": "When you click Send review, it goes straight to the chat that sent this batch.",
  // položky a přehrávání
  "Schválit": "Approve", "Zamítnout": "Reject", "Schválit (S)": "Approve (S)", "Zamítnout (X)": "Reject (X)", "Líbí se": "Like", "Nelíbí se": "Dislike",
  "Schválit / zamítnout položku": "Approve / reject item", "schváleno": "approved", "zamítnuto": "rejected",
  "Sdílet nebo stáhnout": "Share or download", "Přetáhni do Zpráv, Mailu nebo Finderu": "Drag into Messages, Mail or Finder",
  "Kopírovat soubor (pak ⌘V ve Zprávách)": "Copy file (then ⌘V in Messages)", "Ukázat ve Finderu": "Show in Finder",
  "Zkopírováno. Ve Zprávách dej ⌘V": "Copied. Press ⌘V in Messages", "Kopírování se nepovedlo": "Copy failed", "Sdílení se nepovedlo": "Sharing failed",
  "Tenhle prohlížeč sdílení souborů neumí": "This browser can't share files", "Připravuju soubor…": "Preparing file…",
  "Přehrát / pauza": "Play / pause", "Přehrát / pauza (mezerník)": "Play / pause (space)", "O snímek zpět (,)": "Previous frame (,)", "O snímek vpřed (.)": "Next frame (.)",
  "O snímek zpět / vpřed": "Frame back / forward", "O vteřinu zpět / vpřed": "One second back / forward", "O 5 s zpět / vpřed": "5 s back / forward",
  "Minuty:sekundy:snímek": "Minutes:seconds:frame", "Rychlost přehrávání": "Playback speed", "Rychlost (L zrychluje, J pozpátku)": "Speed (L faster, J reverse)",
  "Smyčka": "Loop", "Smyčka (Shift+L)": "Loop (Shift+L)", "Smyčka zapnutá": "Loop on", "Smyčka vypnutá": "Loop off",
  "Zastavit na připomínkách": "Stop at notes", "Zastavuje na připomínkách (zapnuto)": "Stops at notes (on)",
  "Přehrávání se zastaví na každé připomínce": "Playback stops at every note", "Přehrávání se na připomínkách nezastavuje": "Playback doesn't stop at notes",
  "Přehrávání se sdílí se všemi, kdo mají zapnuté Spolu.": "Playback is shared with everyone who has Together on.", "Přehráváš sám.": "You're playing on your own.",
  "Celá obrazovka (kino)": "Full screen (cinema)", "Celá obrazovka, jen obraz (F)": "Full screen, picture only (F)", "Zpět (F nebo Esc)": "Back (F or Esc)",
  "Překryv vypnutý": "Overlay off", "Překryv Instagram Reels, TikTok, Shorts": "Instagram Reels, TikTok, Shorts overlay",
  "Překryv Instagram Reels, TikTok, YouTube Shorts (G)": "Instagram Reels, TikTok, YouTube Shorts overlay (G)", "Bezpečné zóny pro Reels, TikTok a Shorts (G)": "Safe zones for Reels, TikTok and Shorts (G)",
  "Prohlížeč pustil video bez zvuku. Zvuk zapneš tlačítkem reproduktoru nebo klávesou M.": "The browser started the video muted. Turn sound on with the speaker button or the M key.",
  "Prohlížeč video nepřehraje.": "The browser can't play this video.", "Video se nenačítá (vypršel čas).": "The video isn't loading (timed out).",
  "Připravuji náhled…": "Preparing preview…", "Čeká na přípravu…": "Waiting to be prepared…", "Hotovo, připravuji náhledy…": "Done, preparing previews…",
  "Tuhle položku se nepodařilo připravit": "This item couldn't be prepared", "chyba přípravy": "preparation error", "připravuje se": "preparing",
  "Tohle je první položka.": "This is the first item.", "Tohle je poslední položka.": "This is the last item.", "V dávce je jen jedna položka.": "There's only one item in this batch.",
  "Předchozí / další položka": "Previous / next item", "Předchozí / další připomínka": "Previous / next note",
  "Předchozí připomínka už není": "No previous note", "Další připomínka už není": "No more notes", "Všechno prohlédnuto": "All reviewed",
  "Přiblížit / oddálit": "Zoom in / out", "Přizpůsobit obraz": "Fit to screen", "Posun dvěma prsty": "Two-finger pan", "sevřít prsty": "pinch",
  "Začátek / konec": "Start / end", "Dopředu 1× → 1,5× → 2× → 1×": "Forward 1× → 1.5× → 2× → 1×", "Pozpátku 1× → 2× → 1×": "Reverse 1× → 2× → 1×",
  "Posun zvuku (Spolu)": "Audio offset (Together)", "Automaticky": "Automatic",
  "Když video koukáš na iPadu a zvuk posloucháš z tohohle zařízení (třeba AirPods na Macu), musí tohle zařízení hrát o kousek napřed. Posuň, dokud nesedí rty na zvuk. Platí jen pro toto zařízení a jen se zapnutým Spolu.":
    "When you watch on an iPad but listen through this device (e.g. AirPods on a Mac), this device has to play slightly ahead. Move the slider until lips match the sound. Applies only to this device and only with Together on.",
  "Doporučeno 0 ms, pro AirPods asi 200 ms": "Recommended 0 ms, about 200 ms for AirPods", "Bluetooth sluchátka": "Bluetooth headphones",
  // kreslení
  "Kreslení": "Drawing", "Pero, šipka, kroužek, obdélník": "Pen, arrow, ellipse, rectangle", "Šipka (A)": "Arrow (A)", "Kroužek (O)": "Ellipse (O)", "Obdélník (R)": "Rectangle (R)",
  "Kruh / čtverec": "Circle / square", "Tenká ([)": "Thin ([)", "Střední": "Medium", "Silná (])": "Thick (])", "Tenčí / silnější": "Thinner / thicker",
  "Červená": "Red", "Žlutá": "Yellow", "Zelená": "Green", "Modrá": "Blue", "Bílá": "White", "Černá": "Black", "Šedá": "Gray", "Šedá (6)": "Gray (6)", "Bez barvy (0)": "No color (0)", "Bez barvy": "No color",
  "Červená (1)": "Red (1)", "Žlutá (2)": "Yellow (2)", "Zelená (3)": "Green (3)", "Modrá (4)": "Blue (4)", "Bílá (5)": "White (5)", "Černá (6)": "Black (6)",
  "Zpět (⌘Z)": "Undo (⌘Z)", "Zpět / znovu": "Undo / redo", "Není co vrátit": "Nothing to undo", "Není co zopakovat": "Nothing to redo",
  "Smazat kresbu na snímku": "Clear drawing on this frame", "Smazat kresbu na tomto snímku (Delete)": "Clear drawing on this frame (Delete)",
  "Na tomhle snímku není žádná kresba": "There's no drawing on this frame", "Kresba smazána": "Drawing deleted",
  "Prst kreslí": "Finger draws", "Prst přehrává a přepíná, kreslí jen Pencil": "Finger plays and switches, only Pencil draws",
  "Kreslit i prstem (jinak prst přehrává a přepíná)": "Draw with finger too (otherwise finger plays and switches)", "Kreslit i prstem": "Draw with finger",
  "Jinak prst přehrává a přepíná položky a kreslí jen Apple Pencil.": "Otherwise your finger plays and switches items and only Apple Pencil draws.",
  "⇧ při tažení": "⇧ while dragging",
  // připomínky
  "Napiš připomínku… (C)": "Write a note… (C)", "Napsat komentář k snímku": "Write a comment on this frame", "Ke kterému místu se komentář váže": "What the comment refers to",
  "Komentář k celému videu": "Comment on the whole video", "Komentář k obrázku": "Comment on the image", "Komentář ke snímku": "Comment on frame",
  "Komentář smazán": "Comment deleted", "Celá dávka": "Whole batch", "Tahle položka": "This item", "Položky a připomínky": "Items and notes",
  "K téhle položce zatím nic.": "Nothing on this item yet.", "Zatím žádné připomínky.": "No notes yet.", "Kresli přímo do obrazu, nebo napiš komentář dole.": "Draw right on the picture, or write a comment below.",
  "Nadiktováno mikrofonem": "Dictated by microphone", "Pořadí, v jakém připomínka vznikla": "Order in which the note was created",
  "Odeslat revizi": "Send review", "Uložit revizi": "Save review", "bez připomínek": "no notes", "Bez připomínek: odesláním dávku schválíš.": "No notes: sending approves the batch.",
  "Uložit revizi pro Clauda (⌘Enter). Uvidí ji, až mu napíšeš „koukni na pult“.": "Save the review for Claude (⌘Enter). Claude sees it when you say “check Pult”.",
  "Odeslat revizi Claudovi do chatu (⌘Enter)": "Send the review to Claude's chat (⌘Enter)",
  "Odesláno": "Sent", "odesláno": "sent", "Znovu otevřít k revizi": "Reopen for review", "Vráceno, dávka je zase otevřená.": "Reopened, the batch is open again.",
  "Tuhle revizi už Claude zpracoval, vrátit nejde.": "Claude already processed this review, it can't be undone.",
  "Přepis diktátu ještě neskončil. Zkus odeslat za chvilku.": "Dictation is still being transcribed. Try sending in a moment.",
  "Claude": "Claude",
  // diktování
  "Diktovat": "Dictate", "Diktuji": "Dictating", "Přepisuji…": "Transcribing…", "Diktovat připomínky mikrofonem (D)": "Dictate notes with the microphone (D)",
  "Diktuji · vypnout (D)": "Dictating · turn off (D)", "Vypnout diktování (D)": "Turn off dictation (D)", "Dokončuji přepis diktátu…": "Finishing transcription…",
  "V diktátu jsem nerozpoznal žádná slova.": "No words were recognized in the dictation.",
  "Diktování není připravené. Řekni Claudovi „zapni v Pultu diktování“.": "Dictation isn't set up. Ask Claude to “turn on dictation in Pult”.",
  "Diktuji. Mluv, kdy chceš: přepis se objeví v připomínkách u snímku, kde začneš mluvit. Vypneš klávesou D. Nejlíp se sluchátky.": "Dictating. Talk whenever you like: the transcript appears as a note on the frame where you started speaking. Press D to stop. Works best with headphones.",
  "Prohlížeč nepovolil mikrofon. Povol ho u adresy Pultu (ikona zámku vlevo v adresním řádku).": "The browser blocked the microphone. Allow it for the Pult address (lock icon on the left of the address bar).",
  "Mikrofon prohlížeč pustí jen na zabezpečené adrese (https). Postup je v Nastavení › Diktování.": "Browsers only allow the microphone on a secure (https) address. See Settings › Dictation.",
  "Model pro přepis": "Transcription model", "Stav": "Status", "není připravené": "not ready", "Přepis": "Transcript",
  "API klíč ElevenLabs (pro cloud)": "ElevenLabs API key (cloud)", "Smazat klíč ElevenLabs?": "Delete the ElevenLabs key?",
  "Klíč ověřený, přepis teď jde přes ElevenLabs.": "Key verified, transcription now uses ElevenLabs.", "Uložit a ověřit": "Save and verify",
  "Přepis se přepne zpátky na Whisper v tomhle počítači.": "Transcription will switch back to Whisper on this computer.",
  "Klíč zůstane jen na tomhle počítači (v nastavení Pultu, čitelný jen pro tvůj účet). Na ElevenLabs stačí klíč s právem Speech to Text.": "The key stays only on this computer (in Pult's settings, readable only by your account). An ElevenLabs key with Speech to Text permission is enough.",
  "OpenAI, velký model. Nejpřesnější čeština, na Macu s Apple Silicon rychlý.": "OpenAI, large model. Very accurate, fast on Apple Silicon Macs.",
  "Nejpřesnější, kvalita jako diktování v ChatGPT. Zvuk se posílá do ElevenLabs a platí se podle minut. Potřebuje API klíč níže.": "Most accurate, like dictation in ChatGPT. Audio is sent to ElevenLabs and billed per minute. Needs the API key below.",
  "Menší a rychlejší, ale v češtině dělá víc chyb.": "Smaller and faster, but makes more mistakes in some languages.",
  "Menší a rychlejší, dělí řeč na kratší věty s přesnějšími časy.": "Smaller and faster, splits speech into shorter sentences with more precise timing.",
  "Mikrofon na iPadu a u kolegů v síti": "Microphone on iPad and for colleagues on the network",
  "Prohlížeč pustí mikrofon jen na zabezpečené adrese (https). Pult ji má, když je zapnuté sdílení v síti (záložka Tým).": "Browsers only allow the microphone on a secure (https) address. Pult has one when network sharing is on (Team tab).",
  "Diktování (přepis řeči)": "Dictation (speech to text)", "(stáhne se při prvním použití, asi 1,6 GB)": "(downloads on first use, about 1.6 GB)",
  "✓ Na téhle adrese mikrofon funguje.": "✓ The microphone works on this address.",
  // knihovna, nahrávání, dávky
  "Složka knihovny": "Library folder", "Vybrat…": "Choose…", "Složka Vstup": "Inbox folder", "Kopírovat originály do knihovny": "Copy originals into the library", "Úklid": "Cleanup",
  "Nikdy": "Never", "Po 7 dnech": "After 7 days", "Po 14 dnech": "After 14 days", "Po 30 dnech": "After 30 days", "Po 90 dnech": "After 90 days",
  "Vysypat koš": "Empty trash", "Vysypat koš?": "Empty the trash?", "Vysypat": "Empty", "Koš vysypán": "Trash emptied", "Koš:": "Trash:",
  "Sem Pult ukládá dávky, náhledy a revize pro Clauda (podsložky davky, revize, archiv). Po změně se starší dávky zobrazí, až složku vrátíš.": "Pult stores batches, previews and reviews for Claude here (subfolders davky, revize, archiv). After a change, older batches show up again when you switch back.",
  "Co do ní nahraješ (třeba export z Premiere), objeví se na Pultu. Podsložka = jedna dávka.": "Whatever you put in it (e.g. a Premiere export) shows up in Pult. One subfolder = one batch.",
  "Pro soubory přidané Claudem. Vypnuto = originál zůstane na svém místě a Pult si udělá jen náhled.": "For files added by Claude. Off = the original stays where it is and Pult only makes a preview.",
  "Odeslané a smazané dávky se po této době přesunou do koše (složka kos v knihovně). Natrvalo nic nemaže.": "Sent and deleted batches move to the trash after this time (kos folder in the library). Nothing is deleted permanently.",
  "Kvalita náhledů videa": "Video preview quality", "720p (nejlehčí, pro pomalou Wi-Fi)": "720p (lightest, for slow Wi-Fi)", "1080p (doporučeno)": "1080p (recommended)", "4K (náročné)": "4K (heavy)",
  "Platí pro nově přidaná videa. Originál zůstává beze změny, Claude dostane přesné snímky.": "Applies to newly added videos. The original stays untouched, Claude gets exact frames.",
  "Kresby při přehrávání": "Drawings during playback", "Jen na svém snímku": "Only on their frame", "Drží 0,5 s": "Hold 0.5 s", "Drží 1 s": "Hold 1 s", "Drží 2 s": "Hold 2 s",
  "Kreslí se vždy do jednoho přesného snímku. Při přehrávání ji můžeš nechat chvíli svítit, ať ji stihneš vidět.": "Drawings always belong to one exact frame. During playback you can keep them visible a little longer so you catch them.",
  "Na tomhle Macu je Pult nainstalovaný jako aplikace. Otevři ho z Docku, verzi z prohlížeče nepotřebuješ.": "Pult is installed as an app on this Mac. Open it from the Dock, you don't need the browser version.",
  "Směr posouvání dvěma prsty": "Two-finger scrub direction", "Prsty doprava = dopředu": "Fingers right = forward", "Prsty doprava = dozadu": "Fingers right = backward",
  "Posouvání ve videu dvěma prsty na trackpadu. Platí jen pro toto zařízení.": "Scrubbing through a video with two fingers on a trackpad. Applies to this device only.",
  "Přehrávání se samo zastaví na každém snímku s kresbou nebo komentářem.": "Playback pauses on every frame with a drawing or comment.", "Video se po konci přehraje znovu.": "The video starts again when it ends.",
  "Nahrát na Pult": "Upload to Pult", "Pusť soubory na Pult": "Drop files on Pult", "Obrázky a videa, klidně celou složku": "Images and videos, even a whole folder",
  "Nahrát obrázky nebo videa (nebo je přetáhni do okna)": "Upload images or videos (or drag them into the window)", "Přidat soubory do dávky": "Add files to the batch",
  "Nová dávka": "New batch", "Název dávky": "Batch name", "Nahrávání selhalo:": "Upload failed:",
  "Tyhle soubory Pult neumí. Obrázky: jpg, png, webp, heic, tif… Videa: mp4, mov, webm, mkv…": "Pult can't open these files. Images: jpg, png, webp, heic, tif… Videos: mp4, mov, webm, mkv…",
  "Zatím tu nic není": "Nothing here yet", "Vybrat soubory": "Choose files", "Až někdo přidá dávku, objeví se tady.": "When someone adds a batch, it shows up here.",
  "smazáno": "deleted", "Někdo": "Someone", "Vyřešeno": "Resolved", "Znovu otevřít": "Reopen", "Smazat kresbu na tomto snímku": "Clear drawing on this frame",
  "Posunout překryv (dvojklik vrátí doprostřed)": "Move the overlay (double-click to center it)", "není připravený": "isn't ready", "(přes síť)": "(over the network)",
  "Jsi připojený k Pultu na počítači": "You're connected to Pult on the computer", ". Kresby a komentáře uvidí všichni, kdo jsou připojení, i Claude po odeslání revize.": ". Everyone connected sees drawings and comments, and so does your agent after you send the review.",
  "(na iPadu: Sdílet › Přidat na plochu).": "(on iPad: Share › Add to Home Screen).", "✗ Nenalezen. Videa se nepřipraví.": "✗ Not found. Videos won't be prepared.",
  "Řekni Claudovi „nainstaluj ffmpeg pro Pult“, nebo spusť:": "Ask your agent to “install ffmpeg for Pult”, or run:", "Zapni v Pultu diktování (lokální Whisper).": "Turn on dictation in Pult (local Whisper).",
  "Claude zapracovává revizi": "Claude is working on the review", "Rozpracováno, ještě neodesláno": "In progress, not sent yet", "Všechno prohlédnuto. 🎉": "All reviewed. 🎉",
  "Nové dávky se tu objeví samy.": "New batches show up here on their own.", "Nic nenalezeno.": "Nothing found.", "Např. Banner podzim v3": "e.g. Autumn banner v3", "zrušeno": "cancelled",
  "Na iPadu otevři": "On the iPad open", ", otevři v Safari) a stažení povol.": ", open it in Safari) and allow the download.", "Nastavení iPadu ›": "iPad Settings ›",
  "Nastavení › Obecné › Informace ›": "Settings › General › About ›", "Otevři zabezpečený odkaz a přidej si ho na plochu (Sdílet › Přidat na plochu):": "Open the secure link and add it to your Home Screen (Share › Add to Home Screen):",
  "Safari na iPadu pustí mikrofon jen na zabezpečené adrese (https). Jednou si nainstaluj certifikát Pultu, pak používej zabezpečený odkaz.": "Safari on iPad allows the microphone only on a secure (https) address. Install Pult's certificate once, then use the secure link.",
  "(přetáhni do Zpráv nebo Finderu)": "(drag into Messages or Finder)", "Čištění se nepovedlo:": "Cleaning failed:",
  "Soubory přidáš přetažením do okna nebo tlačítkem": "Add files by dragging them into the window or with the", ". Claudovi stačí říct": " button. Or just tell Claude", "„pošli to na Pult“": "“send it to Pult”",
  "Přetáhni sem obrázky nebo videa, nebo řekni Claudovi „pošli to na Pult“.":"Drag images or videos here, or ask Claude to “send it to Pult”.",
  "Nejdřív otevři dávku.": "Open a batch first.", "Tahle dávka už neexistuje.": "This batch no longer exists.", "Tyhle dávky už jsou smazané.": "These batches are already deleted.",
  "Přejmenovat dávku": "Rename batch", "Smazat dávku": "Delete batch", "Otevřít složku dávky": "Open batch folder", "Další akce": "More actions",
  "Vybrat víc dávek": "Select multiple batches", "Vybrat všechny": "Select all", "Zrušit výběr": "Clear selection", "Vybráno": "Selected",
  "Smazat vybrané (po kliknutí do seznamu)": "Delete selected (after clicking in the list)", "Barevný štítek": "Color label", "Bez štítku": "No label",
  "Zatím nic": "Nothing yet",
  // tým, aplikace, o pultu
  "Přístupový kód": "Access code", "Nový kód": "New code", "Nový kód nastaven": "New code set", "Nový kód odpojí všechny, kdo se připojili se starým.": "A new code disconnects everyone who joined with the old one.",
  "Odkaz pro kolegy (kód už obsahuje)": "Link for colleagues (includes the code)", "Zkopírovat odkaz pro tým": "Copy team link", "Sdílení v síti": "Network sharing",
  "Pult chce přístupový kód (nejspíš se změnil). Rozpracované kresby jsou uložené.": "Pult needs the access code (it probably changed). Your drawings in progress are saved.",
  "Počítač teď nemá síťovou adresu.": "This computer has no network address right now.", "soukromé síti": "private network",
  "Důvěryhodnost certifikátů": "Certificate Trust Settings", "certifikát Pultu": "Pult certificate", "Stažený profil": "Profile Downloaded",
  "Nainstalovat Pult": "Install Pult", "Pult je nainstalovaný": "Pult is installed", "Pult už běží jako samostatná aplikace. 👍": "Pult is already running as a standalone app. 👍",
  "Nainstaluj Pult jako aplikaci: vlastní okno, ikona v Docku nebo na hlavním panelu, bez lišty prohlížeče.": "Install Pult as an app: its own window, an icon in the Dock or taskbar, no browser bar.",
  "Otevři Pult v Chrome, Edge nebo Safari a nainstaluj ho jako aplikaci.": "Open Pult in Chrome, Edge or Safari and install it as an app.",
  "Soubor › Přidat do Docku": "File › Add to Dock", "Uložit a sdílet › Instalovat Pult": "Save and share › Install Pult",
  "Pult neběží": "Pult isn't running", "Pult teď neběží": "Pult isn't running right now", "Server Pultu teď není dostupný. Všechno je uložené, zkus to za chvilku.": "The Pult server isn't available right now. Everything is saved, try again in a moment.",
  "Není nainstalovaný.": "Not installed.", "ffmpeg (příprava videí)": "ffmpeg (video preparation)", "Sledování": "Monitoring", "Odebírat": "Subscribe",
  "Vítej v Pultu": "Welcome to Pult", "Jak ti říkat?": "What should we call you?", "Podepisuje tvoje kresby a komentáře.": "Signs your drawings and comments.",
  "Podepisuje kresby a komentáře. Uložené jen v tomhle prohlížeči.": "Signs drawings and comments. Stored only in this browser.",
  "Jak tě uvidí ostatní a Claude": "How others and Claude will see you",
  "Pult je místo, kde procházíš obrázky a videa (třeba z AI), kreslíš přímo do snímků, píšeš komentáře a schvaluješ. Jedním tlačítkem pak revizi pošleš Claudovi.": "Pult is where you go through images and videos (from AI or anywhere), draw right on the frames, write comments and approve. One button sends the review to Claude.",
  "Revize obrázků a videí pro práci s Claudem: kresli, komentuj, schvaluj, odešli.": "Image and video review for working with Claude: draw, comment, approve, send.",
  "Claude ovládá Pult příkazem": "Claude controls Pult with the command", "Zapneš klávesou": "Toggle with the key", "mezerník": "space", "tlačítka u časové osy": "the buttons by the timeline",
  "Název shortu nebo odkaz na video": "Short title or video link",
  // překryv sociálních sítí (náhled)
  "Popisek videa, který se tady zkrátí…": "Video caption that gets cut off here…", "Popisek, který se tady zkrátí…": "Caption that gets cut off here…",
  "Sledovat": "Follow", "Líbí se uživateli kamarad a dalším 25 517": "Liked by friend and 25,517 others", "tvuj_ucet · Původní zvuk": "your_account · Original audio", "původní zvuk · tvuj_ucet": "original audio · your_account",
  "tvuj_ucet": "your_account", "Původní zvuk": "Original audio", "Odběr": "Subscribe",
  // doplněno po kontrole
  "Barvy": "Colors", "Guma": "Eraser", "Guma (E)": "Eraser (E)", "Pero (P)": "Pen (P)", "Hlasitost": "Volume", "Ztlumit": "Mute", "Ztlumit (M)": "Mute (M)",
  "Instalovat": "Install", "Kdo je na pultu": "Who's on Pult", "Pro Clauda": "For Claude", "Upravit": "Edit", "Zkratky": "Shortcuts", "Tvoje barva": "Your color",
  "Diktovat (D)": "Dictate (D)", "Diktovat mikrofonem (zapnout / vypnout)": "Dictate with the microphone (on / off)", "Odeslat revizi Claudovi": "Send review to Claude",
  "Odeslat revizi Claudovi (⌘Enter)": "Send review to Claude (⌘Enter)", "Rychlost 1× / 1,5× / 2×": "Speed 1× / 1.5× / 2×", "Smazat (⌫)": "Delete (⌫)", "Znovu (⇧⌘Z)": "Redo (⇧⌘Z)",
  "V Safari: menu": "In Safari: menu", "› Pult › Instalovat.": "› Pult › Install.", "› zapni Pult.": "› turn on Pult.", "1 až 6": "1 to 6",
  "Sdílet v síti": "Share on the network", "Pult na iPadu nebo telefonu": "Pult on iPad or phone",
  "Kolegové ve stejné síti (kancelář, Wi-Fi, Tailscale) otevřou Pult v prohlížeči a kreslí a komentují s tebou. Přístup chrání kód.": "Colleagues on the same network (office, Wi-Fi, Tailscale) open Pult in a browser and draw and comment with you. Access is protected by a code.",
  "Na Windows se při zapnutí sdílení objeví dotaz brány firewall: povol přístup v": "On Windows, turning sharing on shows a firewall prompt: allow access on a",
  ". Mimo kancelář funguje Pult přes Tailscale (stejný odkaz s adresou z Tailscale).": ". Outside the office Pult works over Tailscale (same link with the Tailscale address).",
  "nahoře sdílí přehrávání mezi všemi, kdo ho mají zapnuté (třeba tvůj iPad a počítač, nebo celý tým na poradě).": "at the top shares playback between everyone who has it on (e.g. your iPad and computer, or the whole team in a meeting).",
  "nahoře sdílí přehrávání: kdo pustí, posune nebo přepne položku, tomu se přidají všichni, kdo mají Spolu zapnuté.": "at the top shares playback: whoever plays, seeks or switches an item, everyone with Together on follows.",
  "V adresním řádku vpravo klikni na ikonu": "In the address bar on the right, click the", "(monitor se šipkou), nebo v menu ⋮ ›": "icon (monitor with an arrow), or in the ⋮ menu ›",
  "Zapni v záložce Tým sdílení v síti a na iPadu otevři odkaz pro kolegy. Kreslit jde Apple Pencilem i prstem.": "Turn on network sharing in the Team tab and open the colleague link on the iPad. You can draw with Apple Pencil or your finger.",
  "nebo mikrofonem vedle přehrávání, jednou na celou revizi. Pak pouštěj, posouvej a zastavuj video a mluv, kdy chceš: každá věta se přepíše do komentáře ke snímku, kde jsi ji začal říkat. Přepis běží na počítači s Pultem, nic nejde na internet. Nejlíp se sluchátky.":
    "or the microphone next to playback, once for the whole review. Then play, seek and pause and talk whenever you like: every sentence becomes a comment on the frame where you started saying it. Local models transcribe on the Pult computer. Works best with headphones.",
  "Diktování je vypnuté v nastavení.": "Dictation is turned off in settings.", "Řekni Claudovi „zapni v Pultu diktování“ (": "Ask Claude to “turn on dictation in Pult” (",
  "Zapni sdílení v síti (Nastavení › Tým).": "Turn on network sharing (Settings › Team).", "Instalace: řekni Claudovi „zapni v Pultu diktování“ (spustí": "Install: ask Claude to “turn on dictation in Pult” (runs",
  "přidá dávku,": "adds a batch,", "ukáže nové revize,": "shows new reviews,", "označí revizi jako zpracovanou.": "marks a review as done.", "⌘ + kolečko": "⌘ + scroll wheel",
  "Ctrl + kolečko": "Ctrl + scroll wheel", "1,5×": "1.5×", "Diktuješ na jiném zařízení, tady jsem mikrofon vypnul.": "You started dictating on another device, so the mic here is off.", "Odeslat znovu": "Send again", "Odeslat revizi (⌘Enter)": "Send review (⌘Enter)",
  "Autor Pultu": "Creator of Pult", "Zavolejme si": "Book a call", "Napiš mi": "Email me", "Více o mně": "More about me", "Autor": "Author", "Pult vytvořil": "Pult was made by",
  "Stříhám a stavím nástroje pro tvůrce. Když chceš, ať tvůj tým takhle pracuje s AI, nebo potřebuješ nástroj na míru, ozvi se.": "I edit videos and build tools for creators. If you want your team to work with AI like this, or you need a custom tool, get in touch.",
  ". Stříhám a stavím nástroje pro tvůrce.": ". I edit videos and build tools for creators.",
  "AI metadata": "AI metadata", "Vytvořit čistou kopii": "Create clean copy", "Čistím…": "Cleaning…", "Zavřít": "Close",
  "Soubor má v metadatech stopy AI. Instagram a YouTube ho podle nich můžou označit jako vytvořený pomocí AI.": "This file has AI traces in its metadata. Instagram and YouTube may label it as made with AI.",
  "V metadatech souboru": "The metadata of", "jsou stopy po AI. Instagram, YouTube a TikTok podle nich můžou video nebo obrázek označit jako vytvořený pomocí AI.": "contains AI traces. Instagram, YouTube and TikTok may use them to label the video or image as made with AI.",
  "Čistá kopie má stejný obraz i zvuk, jen bez metadat. Uloží se vedle originálu, originál zůstane beze změny.": "The clean copy has the same picture and sound, just without metadata. It's saved next to the original, which stays untouched.",
  "C2PA (Content Credentials)": "C2PA (Content Credentials)", "IPTC: vytvořeno AI": "IPTC: AI generated", "IPTC: složeno s AI": "IPTC: composited with AI", "IPTC: algoritmicky vytvořeno": "IPTC: algorithmic media",
  "AIGC štítek (TikTok, Kling, Douyin)": "AIGC label (TikTok, Kling, Douyin)", "Označeno jako AI": "Labeled as AI",
  "Diktování připomínek": "Dictating notes", "Průvodce nastavením": "Setup guide", "Whisper v počítači": "Whisper on this computer", "Teď ne": "Not now", "Hotovo": "Done",
  "Připomínky nemusíš psát: zapneš mikrofon, pouštíš video a mluvíš. Každá věta se zapíše ke snímku, kde jsi ji začal říkat. Vyber, co bude řeč přepisovat:": "You don't have to type notes: turn on the mic, play the video and talk. Each sentence lands on the frame where you started saying it. Choose what transcribes your speech:",
  "Nejpřesnější přepis, česky i anglicky. Nic se nestahuje. Zvuk se posílá do ElevenLabs a platí se podle minut nahrávky.": "Most accurate transcription, in many languages. Nothing to download. Audio is sent to ElevenLabs and billed per recorded minute.",
  "Přihlas se na": "Sign in at", "(účet zdarma stačí na vyzkoušení).": "(a free account is enough to try it).",
  "Klikni na": "Click", ", u oprávnění nech jen": ", and under permissions keep only", "Klíč vlož sem. Zůstane jen na tomhle počítači.": "Paste the key here. It stays on this computer only.",
  "Zdarma a soukromé, nic neodchází z počítače. Jednou se stáhne model (asi 1,6 GB), na Macu s Apple Silicon je rychlý.": "Free and private, nothing leaves your computer. Downloads a model once (about 1.6 GB), fast on Apple Silicon Macs.",
  "Instalaci udělá Claude. Pošli mu tuhle větu:": "Claude does the install. Send it this sentence:", "Diktování zapneš kdykoli v Nastavení › Diktování.": "You can turn dictation on any time in Settings › Dictation.",
};

// texty s čísly a jmény (celý textový uzel)
const RX = [
  [/^Claude odklidil „(.+?)“(: .+)?$/, (m, a, b) => `Claude cleared “${a}”${b || ""}`],
  [/^Diktuju do mikrofonu (.+), ne do sluchátek: AirPods by jinak přepnuly do režimu hovoru a hrály roboticky\. Změníš v Nastavení › Diktování\.$/, "Dictating into $1, not the headphones: AirPods would otherwise switch to call mode and sound robotic. Change it in Settings › Dictation."],
  [/^(.+) \(sluchátka, zvuk bude jako při hovoru\)$/, "$1 (headphones, sound will be like a call)"], [/^Mikrofon (\d+)$/, "Microphone $1"],
  [/^před (\d+) min$/, "$1 min ago"], [/^před (\d+) h$/, "$1 h ago"], [/^před (\d+) d$/, "$1 d ago"],
  [/^(\d+) min$/, "$1 min"], [/^(\d+) h (\d+) min$/, "$1 h $2 min"],
  [/^Claude pracuje · (.+)$/, (m, a) => `Claude is working · ${tr(a)}`], [/^Claude hotovo · (.+)$/, (m, a) => `Claude is done · ${tr(a)}`],
  [/^Claude pracuje · (\d+)$/, "Claude is working · $1"],
  [/^Připravuji (\d+)\/(\d+)$/, "Preparing $1/$2"], [/^Připravuji náhled… (\d+) %$/, "Preparing preview… $1%"],
  [/^Smazáno (\d+) tahů$/, "Deleted $1 strokes"], [/^Smazáno: (.+)$/, "Deleted: $1"], [/^Smazáno (\d+) (dávka|dávky|dávek)$/, (m, n) => `Deleted ${n} ${n === "1" ? "batch" : "batches"}`],
  [/^Vybráno (\d+) (dávka|dávky|dávek)$/, (m, n) => `${n} ${n === "1" ? "batch" : "batches"} selected`],
  [/^(\d+) (video|videa|videí)$/, (m, n) => `${n} ${n === "1" ? "video" : "videos"}`],
  [/^(\d+) (obrázek|obrázky|obrázků)$/, (m, n) => `${n} ${n === "1" ? "image" : "images"}`],
  [/^(\d+) (položka|položky|položek)$/, (m, n) => `${n} ${n === "1" ? "item" : "items"}`],
  [/^(\d+) (soubor|soubory|souborů)( · .*)?$/, (m, n, x, rest) => `${n} ${n === "1" ? "file" : "files"}${rest ? rest.replace(/(\d+) nepodporovaných vynechám/, "$1 unsupported will be skipped") : ""}`],
  [/^(\d+) (komentář|komentáře|komentářů)$/, (m, n) => `${n} ${n === "1" ? "comment" : "comments"}`],
  [/^(\d+) (připomínka|připomínky|připomínek)$/, (m, n) => `${n} ${n === "1" ? "note" : "notes"}`],
  [/^Nahrávám (\d+) z (\d+): (.+)$/, "Uploading $1 of $2: $3"],
  [/^Nahráno (\d+) (soubor|soubory|souborů)\. Náhledy se připravují\.$/, (m, n) => `Uploaded ${n} ${n === "1" ? "file" : "files"}. Previews are being prepared.`],
  [/^Dávku „(.+)“ někdo smazal\.$/, "Someone deleted the batch “$1”."], [/^Nová dávka: (.+)$/, "New batch: $1"],
  [/^(.+) odeslal revizi této dávky\.$/, (m, a) => `${a === "Někdo" ? "Someone" : a} sent a review of this batch.`],
  [/^Přidat do „(.*)“$/, "Add to “$1”"],
  [/^#(\d+) schváleno$/, "#$1 approved"], [/^#(\d+) zamítnuto$/, "#$1 rejected"],
  [/^Ukládám (\d+)…$/, "Saving $1…"], [/^· přepisuji (\d+)$/, "· transcribing $1"],
  [/^◀ pozpátku (.+)$/, "◀ reverse $1"], [/^Překryv: (.+) \(G přepne dál\)$/, "Overlay: $1 (G for next)"], [/^Překryv: (.+)$/, "Overlay: $1"],
  [/^Sdílet (video|obrázek)$/, (m, w) => `Share ${w === "video" ? "video" : "image"}`],
  [/^Sdílet nebo stáhnout (video|obrázek)$/, (m, w) => `Share or download ${w === "video" ? "video" : "image"}`],
  [/^Sdílet (video|obrázek): přetáhni ho do Zpráv, Mailu nebo Finderu, nebo klikni \(zkopírovat, ukázat ve Finderu…\)$/, (m, w) => `Share ${w === "video" ? "video" : "image"}: drag it into Messages, Mail or Finder, or click (copy, show in Finder…)`],
  [/^Doporučeno (\d+) ms \((.+)\)$/, "Recommended $1 ms ($2)"],
  [/^Prohlížeč video nepřehraje \(kód (.+)\)\.$/, "The browser can't play this video (code $1)."],
  [/^Revize odeslána Claudovi do chatu, který dávku poslal \((.+)\)\.$/, (m, a) => `Review sent to the Claude chat that sent this batch (${tr(a)}).`],
  [/^Revize uložená \((.+)\)\. Claude ji uvidí, až mu napíšeš „koukni na pult“\.$/, (m, a) => `Review saved (${tr(a)}). Claude sees it when you say “check Pult”.`],
  [/^Odesláno (.+?)( \((.+)\))?\. $/, (m, a, b, who) => `Sent ${tr(a)}${who ? ` (${who})` : ""}. `],
  [/^Natrvalo se smaže (.+) starých dávek z koše\. Vrátit to nepůjde\.$/, "This permanently deletes $1 of old batches from the trash. It can't be undone."],
  [/^Koš: (.+)$/, "Trash: $1"],
  [/^Vybráno (.+)$/, "Selected: $1"], [/^Smazáno (\d.*)$/, "Deleted $1"], [/^Smazáno: (.+)$/, "Deleted: $1"], [/^Smazat (\d+ batch(es)?)$/, "Delete $1"],
  [/^Nahráno (.+)\. Náhledy se připravují\.$/, "Uploaded $1. Previews are being prepared."], [/^(\d+) nepodporovaných vynechám$/, "$1 unsupported will be skipped"],
  [/^… a dalších (\d+)$/, "… and $1 more"], [/^Prohlížeč video nepřehraje \(kód (.*?)\)\.?$/, "The browser can't play this video (code $1)."],
  [/^(.+): (.+) \(klikni a přejdi tam\)$/, (m, a, b) => `${a}: ${tr(b)} (click to go there)`], [/^(.+) · Spolu$/, (m, a) => `${tr(a)} · Together`],
  [/^na pultu$/, "on Pult"], [/^Čistá kopie hotová: (.+)$/, "Clean copy ready: $1"], [/^Kopie hotová, ale pořád obsahuje: (.+)$/, "Copy ready, but it still contains: $1"],
  [/^Čištění se nepovedlo: (.+)$/, "Cleaning failed: $1"], [/^✗ (.+)$/, (m, a) => `✗ ${tr(a)}`], [/^(.+?) Není nainstalovaný\.$/, (m, a) => `${tr(a)} Not installed.`], [/^(.+) \(přetáhni do Zpráv nebo Finderu\)$/, "$1 (drag into Messages or Finder)"],
  [/^✓ Připravené · (.+)$/, "✓ Ready · $1"], [/^✓ Uložený a ověřený:$/, "✓ Saved and verified:"],
  [/^(\d+) z (\d+)$/, "$1 of $2"], [/^(.+) · Pult$/, "$1 · Pult"],
];

// zbytky (úseky uvnitř delších textů); jen texty s diakritikou, nejdelší napřed
const PARTS = [
  ["Diktát se nepodařilo poslat:", "Couldn't send dictation:"], ["Přepis diktátu selhal:", "Transcription failed:"], ["Změnu se nepodařilo uložit:", "Couldn't save the change:"],
  ["Nastavení se nepodařilo uložit:", "Couldn't save settings:"], ["Server Pultu teď není dostupný:", "The Pult server isn't available:"], ["Odeslání selhalo:", "Sending failed:"],
  ["Vrácení selhalo:", "Reopening failed:"], ["Nahrávání selhalo:", "Upload failed:"], ["Barvu se nepodařilo uložit", "Couldn't save the color"],
  ["Komentář ke snímku", "Comment on frame"], ["Komentář k celému videu", "Comment on the whole video"], [" · snímek ", " · frame "], ["snímek", "frame"],
];

const CZ = /[ěščřžýáíéůúťďňĚŠČŘŽÝÁÍÉŮÚŤĎŇ„]/;
const cache = new Map();
export function tr(s) {
  if (LANG === "cs" || !s) return s;
  const k = s.trim();
  if (!k) return s;
  if (cache.has(k)) return s.replace(k, cache.get(k));
  let out = EN[k];
  if (out === undefined) {
    for (const [rx, rep] of RX) if (rx.test(k)) { out = k.replace(rx, rep); break; }
  }
  if (out === undefined && k.includes(" · ")) {
    const p = k.split(" · ").map((x) => tr(x));
    if (p.join(" · ") !== k) out = p.join(" · ");
  }
  if (out === undefined && CZ.test(k)) {
    out = k;
    for (const [a, b] of PARTS) if (out.includes(a)) out = out.split(a).join(b);
    if (out === k) { out = undefined; if (window.PULT_I18N_MISS) window.PULT_I18N_MISS.add(k); }
  }
  if (out === undefined) out = k;
  if (cache.size > 4000) cache.clear();
  cache.set(k, out);
  return s.replace(k, out);
}
export const t = tr;

// --- překlad DOM ---
const ATTRS = ["title", "placeholder", "aria-label", "alt", "data-tip"];
// uživatelský obsah: nepřekládat
const SKIP = ".txt, .note .who, .brow .t, #batchTitle, #itemName, .item-name, .an-b, .agent-note-body, .cp-b b, .cp-t, .wait-badge small, .people, code, pre, input, textarea, [contenteditable], [data-noi18n], .files span:first-of-type";
function skip(el) { return !el || (el.closest && el.closest(SKIP)); }
function doText(n) {
  const p = n.parentElement;
  if (!p || p.tagName === "SCRIPT" || p.tagName === "STYLE" || skip(p)) return;
  const v = n.nodeValue, o = tr(v);
  if (o !== v) n.nodeValue = o;
}
function doAttrs(el) {
  if (!el.getAttribute || (el.closest && el.closest("[data-noi18n]"))) return;
  for (const a of ATTRS) {
    const v = el.getAttribute && el.getAttribute(a);
    if (v) { const o = tr(v); if (o !== v) el.setAttribute(a, o); }
  }
}
function walk(root) {
  if (root.nodeType === 3) return doText(root);
  if (root.nodeType !== 1) return;
  doAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeType === 3 ? doText(n) : doAttrs(n);
}
if (LANG !== "cs") {
  document.documentElement.lang = "en";
  const start = () => {
    walk(document.body);
    new MutationObserver((ms) => {
      for (const m of ms) {
        if (m.type === "characterData") doText(m.target);
        else if (m.type === "attributes") doAttrs(m.target);
        else for (const n of m.addedNodes) walk(n);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    const tt = () => { const o = tr(document.title); if (o !== document.title) document.title = o; };
    new MutationObserver(tt).observe(document.querySelector("title") || document.head, { childList: true, subtree: true, characterData: true });
    tt();
  };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);
} else document.documentElement.lang = "cs";
