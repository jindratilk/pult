"""Pult: anglické znění hlášek, které server posílá do rozhraní (zdrojové texty jsou české).
Rozhraní posílá svůj jazyk v hlavičce X-Pult-Lang, server podle něj chyby přeloží."""
import re

EN = {
    "neplatná adresa": "Invalid address.",
    "požadavek z cizí stránky": "Request from another website.",
    "Jen na počítači, kde Pult běží.": "Only on the computer running Pult.",
    "příliš velký požadavek": "Request too large.",
    "zabezpečená adresa není zapnutá": "The secure address is not turned on.",
    "dávka nenalezena": "Batch not found.",
    "nenalezeno": "Not found.",
    "soubor nenalezen": "File not found.",
    "očekávám JSON": "Expected JSON.",
    "nahrávání přerušeno": "Upload interrupted.",
    "Žádné podporované soubory (obrázky nebo videa).": "No supported files (images or videos).",
    "neplatná dávka": "Invalid batch.",
    "neplatná barva": "Invalid colour.",
    "neplatný stav": "Invalid status.",
    "neplatná kresba": "Invalid drawing.",
    "prázdná kresba": "Empty drawing.",
    "neplatný komentář": "Invalid comment.",
    "prázdný komentář": "Empty comment.",
    "neznámá změna": "Unknown change.",
    "neplatná revize": "Invalid review.",
    "chybí zvuk": "No audio.",
    "chybí záznam polohy ve videu": "Missing video position.",
    "Tohle nevypadá jako API klíč ElevenLabs.": "This doesn't look like an ElevenLabs API key.",
    "ElevenLabs klíč odmítl (neplatný nebo bez práva na Speech to Text).": "ElevenLabs rejected the key (invalid, or without Speech to Text access).",
    "Video nejde přečíst (ffprobe).": "The video can't be read (ffprobe).",
    "Obrázek nejde převést.": "The image can't be converted.",
    "Chybí ffmpeg (Nastavení › O aplikaci).": "ffmpeg is missing (Settings › About).",
    "ffmpeg selhal": "ffmpeg failed.",
}
RX = [
    (re.compile(r"^Tenhle typ souboru Pult neumí: (.+)$"), r"Pult can't open this file type: \1"),
    (re.compile(r"^Soubor nenalezen: (.+)$"), r"File not found: \1"),
    (re.compile(r"^Chyba souboru na serveru: (.+)$"), r"File error on the server: \1"),
]


def en(msg):
    if not isinstance(msg, str):
        return msg
    if msg in EN:
        return EN[msg]
    for rx, rep in RX:
        if rx.match(msg):
            return rx.sub(rep, msg)
    return msg
