"""Pult: nastavení a cesty (macOS i Windows, Python 3.9+, jen standardní knihovna)."""
import json
import os
import secrets
import shutil
import sys
import threading
import time

APP_NAME = "Pult"
VERSION = "2.10.8"
DEFAULT_PORT = 7858  # P-U-L-T na klávesnici telefonu
IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"
APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(APP_DIR, "static")


def config_dir():
    """Kde leží config.json a logy. PULT_HOME přepíše vše (testy, přenosná instalace)."""
    if os.environ.get("PULT_CONFIG"):
        return os.path.dirname(os.path.abspath(os.environ["PULT_CONFIG"]))
    if os.environ.get("PULT_HOME"):
        return os.path.join(os.environ["PULT_HOME"], "config")
    if IS_WIN:
        base = os.environ.get("APPDATA") or os.path.expanduser("~\\AppData\\Roaming")
    elif IS_MAC:
        base = os.path.expanduser("~/Library/Application Support")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, APP_NAME)


def default_library():
    if os.environ.get("PULT_HOME"):
        return os.path.join(os.environ["PULT_HOME"], "Pult")
    return os.path.join(os.path.expanduser("~"), "Pult")


DEFAULTS = {
    "library": "",            # prázdné = ~/Pult
    "inbox_enabled": False,   # složka Vstup: co se do ní nahraje, objeví se na pultu
    "inbox": "",              # prázdné = <knihovna>/Vstup
    "port": DEFAULT_PORT,
    "share": False,           # sdílení v síti (tým)
    "lang": "",               # výchozí jazyk rozhraní: cs, en, nebo prázdné = podle prohlížeče
    "dock_added": False,      # macOS: instalátor už jednou přidal Pult do Docku (když ho pak uživatel odebere, nevracet)
    "agent_skill": True,      # instalátor nasazuje skill pult pro Claude Code a Codex (--no-claude vypne)
    "agent_instructions": False,  # blok v globálním CLAUDE.md / AGENTS.md: jen na výslovné přání (--agent-instructions)
    "author_card": True,      # kartička „kdo Pult udělal“ a odkaz na autora (firemní verze ji vypíná)
    "access_code": "",
    "proxy": 1080,            # výška náhledových videí: 720, 1080, 1440, 2160
    "hw_encode": True,        # Mac: náhledy kóduje hardware (Media Engine), jinak libx264
    "copy_originals": False,  # pult add: kopírovat originály do knihovny (nahrání z prohlížeče se kopíruje vždy)
    "cleanup_days": 14,       # odeslané a smazané dávky po N dnech do koše (0 = nikdy)
    "ffmpeg": "",
    "ffprobe": "",
    "dictation": True,        # diktování mikrofonem (přepis Whisperem na tomto počítači)
    "asr_python": "",         # Python s mlx-whisper / faster-whisper; prázdné = <nastavení>/asr (pult dictation install)
    "asr_model": "",          # prázdné = Whisper large-v3-turbo
}

_lock = threading.Lock()


_sys_lang = None


def ui_lang(cfg=None):
    """Jazyk pro texty ze serveru a příkazové řádky: nastavení Pultu, jinak jazyk systému."""
    global _sys_lang
    lang = (cfg or load()).get("lang")
    if lang in ("cs", "en"):
        return lang
    if _sys_lang is None:
        loc = os.environ.get("LC_ALL") or os.environ.get("LANG") or ""
        if IS_MAC and not loc:
            try:
                import subprocess  # noqa: PLC0415
                loc = subprocess.run(["defaults", "read", "-g", "AppleLocale"], capture_output=True, text=True, timeout=3).stdout
            except Exception:
                loc = ""
        _sys_lang = "cs" if loc.lower().startswith(("cs", "sk")) else "en"
    return _sys_lang


def config_path():
    return os.environ.get("PULT_CONFIG") or os.path.join(config_dir(), "config.json")


def load():
    cfg = dict(DEFAULTS)
    try:
        with open(config_path(), encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            cfg.update({k: v for k, v in data.items() if k in DEFAULTS})
    except (OSError, ValueError):
        pass
    if os.environ.get("PULT_PORT"):
        cfg["port"] = int(os.environ["PULT_PORT"])
    return cfg


def save(cfg):
    with _lock:
        path = config_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({k: cfg.get(k, DEFAULTS[k]) for k in DEFAULTS}, f, ensure_ascii=False, indent=1)
        for i in range(6):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:  # Windows: soubor zrovna čte jiné vlákno nebo antivir
                time.sleep(0.05 * (i + 1))
        os.replace(tmp, path)


def update(changes):
    """Uloží jen známé klíče se správným typem; vrací nové nastavení."""
    cfg = load()
    for k, v in changes.items():
        if k not in DEFAULTS or k == "port" and os.environ.get("PULT_PORT"):
            continue
        d = DEFAULTS[k]
        if isinstance(d, bool):
            v = bool(v)
        elif isinstance(d, int):
            v = int(v)
        else:
            v = str(v or "").strip()
        cfg[k] = v
    if cfg.get("share") and not cfg.get("access_code"):
        cfg["access_code"] = new_code()
    save(cfg)
    return cfg


def new_code():
    """Přístupový kód pro kolegy: 6 číslic, snadno se nadiktuje."""
    return "%06d" % secrets.randbelow(1000000)


def library(cfg=None):
    cfg = cfg or load()
    return os.path.abspath(os.path.expanduser(cfg.get("library") or default_library()))


def inbox(cfg=None):
    cfg = cfg or load()
    return os.path.abspath(os.path.expanduser(cfg.get("inbox") or os.path.join(library(cfg), "Vstup")))


def tool(name, cfg=None):
    """Cesta k ffmpeg/ffprobe: nastavení, PATH, běžná umístění (launchd a pythonw nemají celý PATH)."""
    cfg = cfg or load()
    if cfg.get(name) and os.path.isfile(cfg[name]):
        return cfg[name]
    exe = name + (".exe" if IS_WIN else "")
    found = shutil.which(name)
    if found:
        return found
    cands = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] if not IS_WIN else [
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Links"),
        "C:\\ffmpeg\\bin", os.path.join(os.environ.get("ProgramFiles", "C:\\Program Files"), "ffmpeg", "bin")]
    if IS_WIN:
        # winget instaluje Gyan.FFmpeg do Packages\Gyan.FFmpeg_*\ffmpeg-*\bin
        pk = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Packages")
        if os.path.isdir(pk):
            for d in sorted(os.listdir(pk)):
                if d.lower().startswith("gyan.ffmpeg") or "ffmpeg" in d.lower():
                    for root, _dirs, files in os.walk(os.path.join(pk, d)):
                        if exe in files:
                            cands.append(root)
    for c in cands:
        p = os.path.join(c, exe)
        if os.path.isfile(p):
            return p
    return None


def native_app():
    """Nativní Pult.app na Macu, jinak None. Záložní spouštěč má v bundlu `pult` malým písmem a APFS
    velikost písmen nerozlišuje, proto listdir a ne exists."""
    bundle = os.path.join(os.path.expanduser("~"), "Applications", "Pult.app")
    try:
        return bundle if IS_MAC and "Pult" in os.listdir(os.path.join(bundle, "Contents", "MacOS")) else None
    except OSError:
        return None
