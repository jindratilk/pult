"""Pult: knihovna dávek, příprava médií (ffmpeg), připomínky a revize pro Clauda."""
import base64
import json
import os
import queue
import re
import shutil
import struct
import subprocess
import threading
import time
import unicodedata
import uuid
from datetime import datetime

import config

IMG_WEB = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}
IMG_CONVERT = {".heic", ".heif", ".tif", ".tiff", ".bmp", ".tga", ".jfif"}
VIDEO = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mxf", ".mts", ".m2ts", ".wmv", ".mpg", ".mpeg"}
MEDIA_EXT = IMG_WEB | IMG_CONVERT | VIDEO
REVIEW_LONG = 2560  # nejdelší strana obrázků v revizi pro Clauda

lock = threading.RLock()


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


# ---------- cesty ----------
def root():
    return config.library()


def dir_of(name):
    return os.path.join(root(), name)


def davky():
    return dir_of("davky")


def revize():
    return dir_of("revize")


def archiv():
    return dir_of("archiv")


def kos():
    return dir_of("kos")


def ensure_dirs():
    for d in (davky(), revize(), archiv()):
        os.makedirs(d, exist_ok=True)


def safe_id(s):
    return bool(re.fullmatch(r"[A-Za-z0-9._-]{1,120}", s or "")) and ".." not in s


def batch_dir(bid):
    if not safe_id(bid):
        raise ValueError("neplatná dávka")
    d = os.path.join(davky(), bid)
    if not os.path.isfile(os.path.join(d, "batch.json")):
        raise FileNotFoundError(bid)
    return d


def slug(s, n=40):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()
    return s[:n].strip("-") or "davka"


def load_json(path, default):
    """Chybějící nebo poškozený soubor = výchozí hodnota. Jiná chyba čtení (Windows: soubor zrovna drží
    antivir) se nepřehlušuje, ať se do batch.json nikdy nezapíše prázdná dávka."""
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, NotADirectoryError, ValueError):
        return default


def save_json(path, obj):
    tmp = "%s.%s.tmp" % (path, uuid.uuid4().hex[:6])
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    for i in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:  # Windows: soubor zrovna čte antivir nebo jiné vlákno
            time.sleep(0.05 * (i + 1))
    os.replace(tmp, path)


# ---------- spouštění nástrojů ----------
NO_WINDOW = 0x08000000 if config.IS_WIN else 0


def run(cmd, timeout=None):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout, creationflags=NO_WINDOW)


_fps_mode = None


def fps_mode_args():
    """-fps_mode (ffmpeg 5.1+) nebo starší -vsync: náhled má vždy pevnou snímkovou frekvenci."""
    global _fps_mode
    if _fps_mode is None:
        r = run([config.tool("ffmpeg"), "-hide_banner", "-h", "full"], timeout=20)
        _fps_mode = "-fps_mode" in (r.stdout or "")
    return ["-fps_mode", "cfr"] if _fps_mode else ["-vsync", "cfr"]


def rational(v):
    try:
        a, b = str(v).split("/")
        return float(a) / float(b) if float(b) else 0.0
    except (ValueError, AttributeError):
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0


def probe(path):
    ffprobe = config.tool("ffprobe")
    if not ffprobe:
        return {}
    r = run([ffprobe, "-v", "error", "-show_entries",
             "stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,r_frame_rate,nb_frames:stream_disposition=attached_pic"
             ":stream_side_data=rotation:format=duration,format_name", "-of", "json", path], timeout=60)
    try:
        j = json.loads(r.stdout or "{}")
    except ValueError:
        return {}
    v = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"
              and not (s.get("disposition") or {}).get("attached_pic")), {})
    a = next((s for s in j.get("streams", []) if s.get("codec_type") == "audio"), None)
    fps_s = v.get("avg_frame_rate") if 1 <= rational(v.get("avg_frame_rate")) <= 240 else v.get("r_frame_rate")
    fps = rational(fps_s)
    if not 1 <= fps <= 240:
        fps_s, fps = "30", 30.0
    # fps se neukrajuje: 29,97 zaokrouhlené na 4 místa by po ~100 snímcích ukazovalo o snímek vedle
    return {"codec": v.get("codec_name"), "width": v.get("width") or 0, "height": v.get("height") or 0,
            "fps": fps, "fps_s": fps_s or "30", "duration": rational((j.get("format") or {}).get("duration")),
            "frames": int(v.get("nb_frames") or 0), "audio": a is not None, "pix_fmt": v.get("pix_fmt"),
            "rotated": any(abs(rational(sd.get("rotation") or 0)) > 0.5 for sd in v.get("side_data_list") or [])}


def even(x):
    return max(2, int(round(x / 2.0)) * 2)


def review_size(w, h):
    """Rozměr obrázků do revize (stejný počítá prohlížeč pro vrstvu s kresbou)."""
    w, h = int(w or 0), int(h or 0)
    if not w or not h:
        return 0, 0
    k = min(1.0, REVIEW_LONG / float(max(w, h)))
    return even(w * k), even(h * k)


def direct_check(src, height):
    """Dá se originál přehrát rovnou (jen přebalit, nic nekódovat)? Vrací (True, info) nebo (False, důvod).
    Hotové exporty z Premiere a Resolve to obvykle splní: H.264 8 bit 4:2:0 v MP4/MOV, pevná frekvence,
    klíčový snímek aspoň jednou za 3 s, rozumná velikost a datový tok. Ostatní se kóduje do náhledu."""
    ffprobe = config.tool("ffprobe")
    if not ffprobe:
        return False, "chybí ffprobe"
    r = run([ffprobe, "-v", "error", "-show_entries",
             "stream=codec_type,codec_name,profile,pix_fmt,width,height,avg_frame_rate,r_frame_rate,start_time,field_order"
             ":stream_side_data=rotation:stream_disposition=attached_pic:format=format_name,bit_rate,duration",
             "-of", "json", src], timeout=60)
    try:
        j = json.loads(r.stdout or "{}")
    except ValueError:
        return False, "ffprobe"
    fmt = j.get("format") or {}
    if not re.search(r"\b(mp4|mov)\b", fmt.get("format_name") or ""):
        return False, "kontejner %s" % fmt.get("format_name")
    vs = [s for s in j.get("streams", []) if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")]
    if not vs:
        return False, "bez videa"
    v = vs[0]
    if v.get("codec_name") != "h264" or v.get("pix_fmt") not in ("yuv420p", "yuvj420p") or re.search(r"10|422|444", v.get("profile") or ""):
        return False, "kodek %s %s %s" % (v.get("codec_name"), v.get("pix_fmt"), v.get("profile"))
    if (v.get("field_order") or "progressive") not in ("progressive", "unknown"):
        return False, "prokládané"
    if any(abs(rational(sd.get("rotation") or 0)) > 0.5 for sd in v.get("side_data_list") or []):
        return False, "otočené"
    long_side = {720: 1280, 1080: 1920, 1440: 2560, 2160: 3840}.get(int(height or 1080), 1920)
    if max(v.get("width") or 0, v.get("height") or 0) > long_side:
        return False, "rozlišení %sx%s" % (v.get("width"), v.get("height"))
    if rational(fmt.get("bit_rate")) > 25e6:
        return False, "datový tok %.0f Mbit/s" % (rational(fmt.get("bit_rate")) / 1e6)
    afr, rfr = rational(v.get("avg_frame_rate")), rational(v.get("r_frame_rate"))
    if not 1 <= afr <= 240 or abs(afr - rfr) > afr * 0.002:
        return False, "proměnlivá frekvence"
    a = next((s for s in j.get("streams", []) if s.get("codec_type") == "audio"), None)
    if a is not None:
        if a.get("codec_name") not in ("aac", "mp3"):
            return False, "zvuk %s" % a.get("codec_name")
        if abs(rational(a.get("start_time")) - rational(v.get("start_time"))) > 1.0 / afr:
            return False, "posunutý zvuk"
    # časy snímků a klíčové snímky v první minutě (čte jen pakety, nic nedekóduje)
    r = run([ffprobe, "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+60", "-show_entries",
             "packet=pts_time,flags", "-of", "csv=p=0", src], timeout=60)
    pts, keys = [], []
    for line in (r.stdout or "").splitlines():
        p = line.split(",")
        try:
            t = float(p[0])
        except (ValueError, IndexError):
            continue
        pts.append(t)
        if len(p) > 1 and "K" in p[1]:
            keys.append(t)
    if len(pts) < 2:
        return False, "nečitelné časy snímků"
    pts.sort()
    step = 1.0 / afr
    bad = sum(1 for x, y in zip(pts, pts[1:]) if abs((y - x) - step) > step * 0.1)
    if bad > len(pts) * 0.01:
        return False, "nepravidelné časy snímků"
    keys.sort()
    gaps = [y - x for x, y in zip(keys, keys[1:])] + [pts[-1] - keys[-1] if keys else 99]
    if not keys or max(gaps) > 3.05:
        return False, "klíčový snímek jen jednou za %.1f s" % max(gaps)
    audios = [s for s in j.get("streams", []) if s.get("codec_type") == "audio"]
    return True, {"audio": a is not None, "simple": len(vs) == 1 and len(audios) <= 1}


def low_priority(cmd):
    """Příprava náhledu nesmí zpomalit práci. macOS: QoS utility (rozumí mu plánovač jader Apple Silicon).
    Místo preexec_fn, který je ve vícevláknovém serveru riskantní."""
    if config.IS_MAC and os.path.exists("/usr/sbin/taskpolicy"):
        return ["/usr/sbin/taskpolicy", "-c", "utility"] + cmd
    nice = None if config.IS_WIN else shutil.which("nice")
    return [nice, "-n", "10"] + cmd if nice else cmd


def _ffmpeg(cmd, tmp, dst, dur, on_progress):
    """Spustí ffmpeg s průběhem a nízkou prioritou (Mac při přípravě náhledu zůstane plynulý)."""
    kw = {}
    if config.IS_WIN:
        kw["creationflags"] = NO_WINDOW | 0x00004000  # BELOW_NORMAL_PRIORITY_CLASS
    p = subprocess.Popen(low_priority(cmd), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                         errors="replace", **kw)
    err = []
    t = threading.Thread(target=lambda: err.extend(p.stderr.read().splitlines()[-12:]), daemon=True)
    t.start()
    for line in p.stdout:
        if line.startswith("out_time_us=") and dur:
            try:
                on_progress(min(0.99, int(line.split("=")[1]) / 1e6 / dur))
            except ValueError:
                pass
    p.wait()
    t.join(2)
    if p.returncode:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return "\n".join(err) or "ffmpeg selhal"
    os.replace(tmp, dst)
    return None


def is_faststart(path):
    """Leží index (moov) před daty (mdat)? Pak jde soubor streamovat beze změny. Čte jen hlavičky atomů."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            off = 0
            while off + 8 <= size:
                f.seek(off)
                head = f.read(16)
                n, kind = struct.unpack(">I4s", head[:8])
                if n == 1 and len(head) == 16:
                    n = struct.unpack(">Q", head[8:16])[0]
                if kind == b"moov":
                    return True
                if kind == b"mdat" or n < 8:
                    return False
                off += n
    except (OSError, struct.error):
        pass
    return False


def clone_file(src, dst):
    """Kopie na APFS, která nezabere místo navíc (a vzniká okamžitě). Jen v rámci jednoho disku."""
    if not config.IS_MAC:
        return False
    try:
        if os.stat(src).st_dev != os.stat(os.path.dirname(dst)).st_dev:
            return False
    except OSError:
        return False
    return run(["cp", "-c", src, dst], timeout=120).returncode == 0


_vt_scale = None


def vt_scale_available():
    """scale_vt (ffmpeg 7+): zmenšení obrazu přímo v GPU, snímky se nekopírují přes procesor."""
    global _vt_scale
    if _vt_scale is None:
        r = run([config.tool("ffmpeg"), "-hide_banner", "-filters"], timeout=20)
        _vt_scale = " scale_vt " in (r.stdout or "")
    return _vt_scale


def proxy_size(w, h, long_side):
    k = min(1.0, long_side / float(max(w, h)))
    return even(w * k), even(h * k)


def make_proxy(src, dst, info, height, on_progress):
    """Video pro prohlížeč. Vyhovující originál se použije rovnou (klon na APFS, jinak přebalení). Jinak náhled:
    H.264, pevná frekvence (snímky sedí na kresby), klíčový snímek dvakrát za vteřinu (rychlé skoky
    a krokování), faststart, zvuk AAC 48 kHz bez mezer. Na Macu dekódování, zmenšení i kódování běží v Media
    Engine a GPU, procesor skoro nezatíží; libx264 je až poslední možnost. Vrací (chyba, způsob)."""
    ffmpeg = config.tool("ffmpeg")
    if not ffmpeg:
        return "Chybí ffmpeg (Nastavení › O aplikaci).", None
    tmp = dst + ".tmp.mp4"
    dur = info.get("duration") or 0
    ok, why = direct_check(src, height)
    if ok:
        if why.get("simple") and is_faststart(src) and clone_file(src, dst):
            return None, "clone"
        cmd = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-i", src, "-map", "0:v:0"] + (["-map", "0:a:0"] if why["audio"] else ["-an"]) + [
            "-c", "copy", "-movflags", "+faststart", "-map_metadata", "-1", "-progress", "pipe:1", "-nostats", tmp]
        if not _ffmpeg(cmd, tmp, dst, dur, on_progress):
            return None, "original"
        why = "přebalení selhalo"
    long_side = {720: 1280, 1080: 1920, 1440: 2560, 2160: 3840}.get(int(height or 1080), 1920)
    g = str(max(1, int(round(info.get("fps") or 30) / 2)))
    vf = ("scale='if(gte(iw,ih),min(%d,trunc(iw/2)*2),-2)':'if(gte(iw,ih),-2,min(%d,trunc(ih/2)*2))':flags=bicubic,"
          "setsar=1,format=yuv420p" % (long_side, long_side))

    def build(mode):
        hw = mode != "sw"
        cmd = [ffmpeg, "-hide_banner", "-nostdin", "-y"] + (["-hwaccel", "videotoolbox"] if hw else [])
        if mode == "gpu":
            cmd += ["-hwaccel_output_format", "videotoolbox_vld"]
        cmd += ["-i", src, "-map", "0:v:0"]
        if info.get("audio"):
            cmd += ["-map", "0:a:0", "-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000", "-af", "aresample=async=1:first_pts=0"]
        else:
            cmd += ["-an"]
        if mode == "gpu":
            cmd += ["-vf", "scale_vt=w=%d:h=%d,setsar=1" % proxy_size(info["width"], info["height"], long_side)]
        else:
            cmd += ["-vf", vf]
        cmd += ["-r", info.get("fps_s") or "30"] + fps_mode_args()
        if hw:
            cmd += ["-c:v", "h264_videotoolbox", "-q:v", "65", "-allow_sw", "0", "-g", g]
        else:  # poslední možnost: polovina jader, zbytek zůstane uživateli
            cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-g", g, "-keyint_min", g, "-sc_threshold", "0",
                    "-threads", str(max(2, (os.cpu_count() or 4) // 2))]
        return cmd + ["-profile:v", "high", "-movflags", "+faststart", "-map_metadata", "-1", "-progress", "pipe:1", "-nostats", tmp]

    if config.IS_MAC and config.load().get("hw_encode", True):
        # zmenšení v GPU neumí otočené ani 10bitové zdroje: ty jdou cestou s převodem barev na procesoru
        if (info.get("pix_fmt") in ("yuv420p", "nv12") and not info.get("rotated") and info.get("width") and info.get("height")
                and vt_scale_available() and not _ffmpeg(build("gpu"), tmp, dst, dur, on_progress)):
            return None, "gpu (%s)" % why
        hw_err = _ffmpeg(build("hw"), tmp, dst, dur, on_progress)
        if not hw_err:
            return None, "hw (%s)" % why
        print("Náhled: hardwarové kódování selhalo, používám libx264 (%s): %s" % (os.path.basename(src), hw_err.splitlines()[-1][:200]), flush=True)
    err = _ffmpeg(build("sw"), tmp, dst, dur, on_progress)
    return err, None if err else "sw (%s)" % why


def thumb(src, dst, at=0.0):
    ffmpeg = config.tool("ffmpeg")
    if not ffmpeg:
        return False
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-v", "error"]
    if at:
        cmd += ["-ss", "%.3f" % at]
    cmd += ["-i", src, "-frames:v", "1", "-vf", "scale='min(480,iw)':-2", "-q:v", "4", dst]
    return run(cmd, timeout=120).returncode == 0


def rotated_jpeg(src, tmp):
    """JPEG s EXIF otočením: prohlížeč i ffmpeg ho otočí, ffprobe hlásí neotočený rozměr. Když se rozměr
    po dekódování liší, vrátí True a otočenou kopii nechá v tmp."""
    if not convert_image(src, tmp):
        return False
    a, b = probe(src), probe(tmp)
    if a.get("width") and (a.get("width"), a.get("height")) != (b.get("width"), b.get("height")):
        return True
    try:
        os.remove(tmp)
    except OSError:
        pass
    return False


def convert_image(src, dst):
    ffmpeg = config.tool("ffmpeg")
    if ffmpeg and run([ffmpeg, "-hide_banner", "-nostdin", "-y", "-v", "error", "-i", src, "-frames:v", "1",
                       "-q:v", "2", dst], timeout=120).returncode == 0:
        return True
    if config.IS_MAC:  # HEIC a další, co ffmpeg neumí: macOS sips
        return run(["sips", "-s", "format", "jpeg", src, "--out", dst], timeout=120).returncode == 0
    return False


# ---------- dávky ----------
def kind_of(path):
    ext = os.path.splitext(path)[1].lower()
    return "video" if ext in VIDEO else "image" if ext in IMG_WEB | IMG_CONVERT else None


def collect(paths):
    """Soubory a složky (bez rekurze do skrytých) seřazené podle názvu."""
    out = []
    for p in paths:
        p = os.path.abspath(os.path.expanduser(p))
        if os.path.islink(p) and not os.path.isdir(p):
            continue  # odkaz na soubor může mířit kamkoli (třeba na klíč): nepouštět
        if os.path.isdir(p):
            for name in sorted(os.listdir(p), key=str.lower):
                f = os.path.join(p, name)
                if not name.startswith(".") and kind_of(name) and not os.path.islink(f) and os.path.isfile(f):
                    out.append(f)
        elif os.path.isfile(p) and kind_of(p):
            out.append(p)
    return out


def create_batch(title, origin=None):
    ensure_dirs()
    title = (title or "").strip() or datetime.now().strftime("Dávka %d. %m. %H:%M")
    bid = "%s_%s" % (datetime.now().strftime("%Y-%m-%d_%H%M%S"), slug(title))
    d = os.path.join(davky(), bid)
    i = 1
    while os.path.exists(d):
        i += 1
        d = os.path.join(davky(), "%s-%d" % (bid, i))
    bid = os.path.basename(d)
    os.makedirs(os.path.join(d, "media"))
    os.makedirs(os.path.join(d, "thumb"))
    b = {"id": bid, "title": title[:200], "created": now_iso(), "status": "open", "items": [], "submissions": []}
    if isinstance(origin, dict) and origin:
        b["origin"] = {k: str(origin.get(k) or "")[:1000] for k in ("session", "host_session", "cwd") if origin.get(k)}
    save_json(os.path.join(d, "batch.json"), b)
    return bid


WAITING = "claude-waiting.json"


def waiting(bid_or_dir):
    """Čeká na revizi tohle dávky Claude (příkaz pult wait běží a hlásí se)?"""
    d = bid_or_dir if os.path.isabs(bid_or_dir) else batch_dir(bid_or_dir)
    try:
        return time.time() - os.path.getmtime(os.path.join(d, WAITING)) < 45
    except OSError:
        return False


WORKING = "claude-working.json"


def working(bid_or_dir):
    """Claude si převzal revizi a pracuje na ní (od pult wait po pult archive)."""
    d = bid_or_dir if os.path.isabs(bid_or_dir) else batch_dir(bid_or_dir)
    w = load_json(os.path.join(d, WORKING), None)
    return w if isinstance(w, dict) else None


def set_working(bid, review="", text=""):
    d = batch_dir(bid)
    if not os.path.isdir(d):
        return None
    w = {"since": now_iso(), "review": review, "text": (text or "").strip()[:200], "text_at": now_iso() if text else ""}
    save_json(os.path.join(d, WORKING), w)
    return w


def set_progress(bid, text):
    """Krátká zpráva, co Claude právě dělá (uvidí ji uživatel v Pultu)."""
    d = batch_dir(bid)
    if not os.path.isdir(d):
        return None
    w = working(d) or {"since": now_iso(), "review": ""}
    w.update(text=(text or "").strip()[:200], text_at=now_iso())
    save_json(os.path.join(d, WORKING), w)
    return w


def finish_working(bid, text=""):
    d = batch_dir(bid)
    p = os.path.join(d, WORKING)
    w = working(d)
    try:
        os.remove(p)
    except OSError:
        pass
    bp = os.path.join(d, "batch.json")
    b = load_json(bp, None)
    if isinstance(b, dict) and (w or text):
        b["claude_done"] = {"at": now_iso(), "since": (w or {}).get("since", ""), "text": (text or "").strip()[:200]}
        save_json(bp, b)
    return w


def add_items(bid, sources, copy=False):
    """Přidá soubory do dávky (stav „queued“, připraví je pracovní vlákno). Vrací nové položky."""
    d = batch_dir(bid)
    new = []
    with lock:
        b = load_json(os.path.join(d, "batch.json"), {})
        n = max([it["n"] for it in b.get("items", [])] or [0])
        for src in sources:
            k = kind_of(src)
            if not k:
                continue
            n += 1
            if copy and not os.path.abspath(src).startswith(os.path.abspath(d) + os.sep):
                os.makedirs(os.path.join(d, "src"), exist_ok=True)
                dst = os.path.join(d, "src", "%02d_%s" % (n, safe_name(os.path.basename(src))))
                shutil.copy2(src, dst)
                src = dst
            name = os.path.basename(src)
            if os.path.abspath(src).startswith(os.path.join(os.path.abspath(d), "src") + os.sep):
                name = re.sub(r"^(?:[0-9a-f]{6}|\d{2})_", "", name)  # technická předpona nahraných a kopírovaných souborů
            it = {"n": n, "kind": k, "name": name, "source": os.path.abspath(src),
                  "state": "queued", "progress": 0}
            b.setdefault("items", []).append(it)
            new.append(it)
        save_json(os.path.join(d, "batch.json"), b)
    for it in new:
        jobs.put((bid, it["n"]))
    return new


def safe_name(name):
    base, ext = os.path.splitext(name)
    base = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", base).strip(" .") or "soubor"
    return base[:80] + ext.lower()[:8]


def update_item(bid, n, **fields):
    d = batch_dir(bid)
    with lock:
        b = load_json(os.path.join(d, "batch.json"), {})
        for it in b.get("items", []):
            if it["n"] == n:
                it.update(fields)
                save_json(os.path.join(d, "batch.json"), b)
                return it
    return None


def prepare(bid, n, emit):
    """Připraví jednu položku: náhled, miniatura, metadata."""
    d = batch_dir(bid)
    b = load_json(os.path.join(d, "batch.json"), {})
    it = next((x for x in b.get("items", []) if x["n"] == n), None)
    if not it or it.get("state") == "ready":
        return
    emit({"type": "item", "batch": bid, "item": update_item(bid, n, state="processing", progress=0)})
    src = it["source"]
    if not os.path.isfile(src):
        emit({"type": "item", "batch": bid, "item": update_item(bid, n, state="error", error="Soubor nenalezen: %s" % src)})
        return
    base = "%02d" % n
    if it["kind"] == "video":
        info = probe(src)
        if not info.get("width"):
            emit({"type": "item", "batch": bid, "item": update_item(bid, n, state="error", error="Video nejde přečíst (ffprobe).")})
            return
        last = [0.0]

        def prog(p):
            if time.time() - last[0] > 0.4:
                last[0] = time.time()
                emit({"type": "progress", "batch": bid, "n": n, "progress": round(p, 3)})
        rel = "media/%s.mp4" % base
        err, how = make_proxy(src, os.path.join(d, rel), info, config.load().get("proxy"), prog)
        if err:
            emit({"type": "item", "batch": bid, "item": update_item(bid, n, state="error", error=err[-600:])})
            return
        px = probe(os.path.join(d, rel))
        thumb(os.path.join(d, rel), os.path.join(d, "thumb", base + ".jpg"), min(1.0, (px.get("duration") or 0) * 0.1))
        fps = px.get("fps") or info.get("fps") or 30
        dur = px.get("duration") or info.get("duration") or 0
        fields = dict(file=rel, thumb="thumb/%s.jpg" % base, width=px.get("width"), height=px.get("height"),
                      src_width=info.get("width"), src_height=info.get("height"), codec=info.get("codec"),
                      fps=fps, duration=round(dur, 3), frames=px.get("frames") or int(round(dur * fps)),
                      audio=bool(px.get("audio")), proxy=how, state="ready", progress=1, error=None)
    else:
        ext = os.path.splitext(src)[1].lower()
        if ext in (".jpg", ".jpeg", ".jfif") and rotated_jpeg(src, os.path.join(d, "media", base + ".rot.jpg")):
            rel = "media/%s.jpg" % base  # fotka z telefonu s příznakem otočení: otočení se „zapeče“
            os.replace(os.path.join(d, "media", base + ".rot.jpg"), os.path.join(d, rel))
        elif ext in IMG_WEB:
            rel = "media/%s%s" % (base, ext)
            shutil.copy2(src, os.path.join(d, rel))
        else:
            rel = "media/%s.jpg" % base
            if not convert_image(src, os.path.join(d, rel)):
                emit({"type": "item", "batch": bid, "item": update_item(bid, n, state="error", error="Obrázek nejde převést.")})
                return
        info = probe(os.path.join(d, rel))
        has_thumb = thumb(os.path.join(d, rel), os.path.join(d, "thumb", base + ".jpg"))
        fields = dict(file=rel, thumb=("thumb/%s.jpg" % base) if has_thumb else rel, width=info.get("width"),
                      height=info.get("height"), state="ready", progress=1, error=None)
    fields["rw"], fields["rh"] = review_size(fields.get("width"), fields.get("height"))
    emit({"type": "item", "batch": bid, "item": update_item(bid, n, **fields)})


jobs = queue.Queue()


def _may_restart():
    """Samorestart kvůli EPERM nejvýš jednou za 10 minut (ať se nezacyklí, když přístup opravdu chybí)."""
    mark = os.path.join(config.config_dir(), "eperm-restart")
    try:
        if time.time() - os.path.getmtime(mark) < 600:
            return False
    except OSError:
        pass
    try:
        with open(mark, "w") as f:
            f.write(str(time.time()))
    except OSError:
        return False
    return True


def worker(emit):
    while True:
        bid, n = jobs.get()
        try:
            prepare(bid, n, emit)
        except FileNotFoundError:
            pass
        except PermissionError as e:
            # macOS občas po přeinstalaci nepustí server na externí disk, i když má Python povolení.
            # Pomůže čistý restart od launchd: položku vrátit do fronty a jednou (max. za 10 min) skončit.
            if e.errno == 1 and str(getattr(e, "filename", "") or "").startswith("/Volumes/") and _may_restart():
                update_item(bid, n, state="queued", progress=0)
                print("Externí disk nepovoleno (EPERM), restartuji server přes launchd.", flush=True)
                os._exit(75)
            try:
                emit({"type": "item", "batch": bid, "item": update_item(bid, n, state="error", error=str(e)[:600])})
            except Exception:
                pass
        except Exception as e:  # jedna vadná položka nesmí zastavit frontu
            try:
                emit({"type": "item", "batch": bid, "item": update_item(bid, n, state="error", error=str(e)[:600])})
            except Exception:
                pass


def requeue_unfinished():
    """Po restartu serveru dokončit, co se nestihlo připravit."""
    if not os.path.isdir(davky()):
        return
    for bid in sorted(os.listdir(davky())):
        b = load_json(os.path.join(davky(), bid, "batch.json"), None)
        for it in (b or {}).get("items", []):
            if it.get("state") in ("queued", "processing"):
                jobs.put((bid, it["n"]))


def notes_path(d):
    return os.path.join(d, "notes.json")


def load_notes(d):
    nt = load_json(notes_path(d), {})
    nt.setdefault("strokes", {})
    nt.setdefault("comments", {})
    nt.setdefault("verdicts", {})
    nt.setdefault("rev", 0)
    return nt


def summary(b, nt):
    items = b.get("items", [])
    first = next((it for it in items if it.get("thumb")), None)
    keys = {(s["n"], s["frame"]) for s in nt["strokes"].values()}
    last_sub = (b.get("submissions") or [{}])[-1].get("at", "")
    changed = [x for x in list(nt["strokes"].values()) + list(nt["comments"].values()) if (x.get("at") or "") > last_sub]
    return {"id": b["id"], "title": b.get("title", b["id"]), "created": b.get("created", ""), "status": b.get("status", "open"),
            "status_at": b.get("status_at"), "count": len(items), "videos": sum(1 for it in items if it["kind"] == "video"),
            "ready": sum(1 for it in items if it.get("state") == "ready"),
            "errors": sum(1 for it in items if it.get("state") == "error"),
            "drawings": len(keys), "comments": len(nt["comments"]), "unsent": len(changed),
            "approved": sum(1 for v in nt["verdicts"].values() if v.get("v") == "ok"),
            "rejected": sum(1 for v in nt["verdicts"].values() if v.get("v") == "no"),
            "thumb": first and "/media/%s/%s" % (b["id"], first["thumb"]), "updated": nt.get("updated") or b.get("created"),
            "waiting": waiting(os.path.join(davky(), b["id"])), "origin": bool(b.get("origin")), "label": b.get("label"),
            "working": working(os.path.join(davky(), b["id"])), "claude_done": b.get("claude_done")}


def list_batches():
    out = []
    if not os.path.isdir(davky()):
        return out
    for name in os.listdir(davky()):
        d = os.path.join(davky(), name)
        try:
            b = load_json(os.path.join(d, "batch.json"), None)
            if b and b.get("id") == name:
                out.append(summary(b, load_notes(d)))
        except OSError:
            continue
    out.sort(key=lambda x: x["created"], reverse=True)
    return out


def get_batch(bid):
    d = batch_dir(bid)
    return load_json(os.path.join(d, "batch.json"), {}), load_notes(d)


def rename(bid, title):
    d = batch_dir(bid)
    with lock:
        b = load_json(os.path.join(d, "batch.json"), {})
        b["title"] = (title or "").strip()[:200] or b.get("title")
        save_json(os.path.join(d, "batch.json"), b)


def clean_agent_notes(notes):
    """Poznámky od Clauda: {"0": k celé dávce, "2": k položce #02}. Prázdný text poznámku smaže."""
    out = {}
    for k, v in (notes or {}).items():
        try:
            n = int(k)
        except (TypeError, ValueError):
            continue
        if n >= 0:
            out[str(n)] = str(v or "").strip()[:3000]
    return out


def set_agent_notes(bid, notes):
    d = batch_dir(bid)
    with lock:
        b = load_json(os.path.join(d, "batch.json"), {})
        cur = b.get("agent_notes") or {}
        for k, v in clean_agent_notes(notes).items():
            if v:
                cur[k] = v
            else:
                cur.pop(k, None)
        b["agent_notes"] = cur
        save_json(os.path.join(d, "batch.json"), b)
    return cur


LABELS = ("red", "yellow", "green", "blue", "white", "black")


def set_label(bid, label):
    """Barevný štítek dávky v seznamu (jen pro orientaci, třeba „čeká na Jirku“). Prázdný = bez barvy."""
    if label and label not in LABELS:
        raise ValueError("neplatná barva")
    d = batch_dir(bid)
    with lock:
        b = load_json(os.path.join(d, "batch.json"), {})
        b["label"] = label or None
        save_json(os.path.join(d, "batch.json"), b)


def comment_order(nt):
    """Pořadí, v jakém komentáře vznikaly, u každé položky zvlášť (1, 2, 3…)."""
    order, per = {}, {}
    for c in sorted(nt["comments"].values(), key=lambda c: (c.get("at") or "", c.get("id"))):
        per[c["n"]] = per.get(c["n"], 0) + 1
        order[c["id"]] = per[c["n"]]
    return order


def set_status(bid, status):
    """open / done / dismissed (smazané jdou vrátit; soubory zůstávají)."""
    if status not in ("open", "done", "dismissed"):
        raise ValueError("neplatný stav")
    d = batch_dir(bid)
    with lock:
        b = load_json(os.path.join(d, "batch.json"), {})
        b["status"], b["status_at"] = status, now_iso()
        if status == "open":
            b.pop("status_note", None)
        save_json(os.path.join(d, "batch.json"), b)


def _filled(o):
    """Je v připomínkách něco skutečného? (po smazání kreseb zůstávají prázdné slovníky a seznamy)"""
    if isinstance(o, dict):
        return any(_filled(v) for v in o.values())
    if isinstance(o, list):
        return any(_filled(v) for v in o)
    return bool(o)


def dismiss_settled(bid, note=""):
    """Agent odklidí dávku vyřešenou v chatu. Dávku, ve které je něčí práce (kresba, komentář, verdikt,
    odeslaná revize), odmítne: rozdělanou revizi smí odklidit jen člověk. Soubory zůstávají, jde to vrátit."""
    d = batch_dir(bid)
    with lock:
        b = load_json(os.path.join(d, "batch.json"), {})
        title = b.get("title", bid)
        status = b.get("status", "open")
        if status == "dismissed":
            return {"ok": True, "already": True, "title": title}
        if status != "open":
            return {"ok": False, "title": title, "reason": "its review was already sent"}
        nt = load_notes(d)
        if b.get("submissions") or any(_filled(nt[k]) for k in ("strokes", "comments", "verdicts")):
            return {"ok": False, "title": title, "reason": "it has someone's drawings, comments or verdicts"}
        b["status"], b["status_at"] = "dismissed", now_iso()
        if note:
            b["status_note"] = str(note)[:300]
        save_json(os.path.join(d, "batch.json"), b)
    return {"ok": True, "title": title}


# ---------- připomínky (kresby, komentáře, verdikty) ----------
def clean_stroke(s):
    if not isinstance(s, dict) or not safe_id(str(s.get("id", ""))):
        raise ValueError("neplatná kresba")
    pts = [[round(float(p[0]), 5), round(float(p[1]), 5), round(float(p[2]) if len(p) > 2 and p[2] is not None else 0.5, 3)]
           for p in (s.get("pts") or [])[:6000]]
    if not pts:
        raise ValueError("prázdná kresba")
    tool = s.get("tool") if s.get("tool") in ("pen", "arrow", "ellipse", "rect") else "pen"
    return {"id": s["id"], "n": int(s["n"]), "frame": max(0, int(s.get("frame") or 0)), "tool": tool,
            "color": str(s.get("color") or "#ff3b30")[:16], "w": min(0.05, max(0.0005, float(s.get("w") or 0.006))),
            "pen": bool(s.get("pen")), "pts": pts, "by": str(s.get("by") or "")[:60],
            "byc": str(s.get("byc") or "")[:16], "at": now_iso()}


def clean_comment(c, old=None):
    if not isinstance(c, dict) or not safe_id(str(c.get("id", ""))):
        raise ValueError("neplatný komentář")
    base = dict(old or {})
    if "text" in c:
        base["text"] = str(c["text"] or "").strip()[:5000]
    if not old:
        base.update(id=c["id"], n=int(c["n"]), frame=None if c.get("frame") is None else max(0, int(c["frame"])),
                    by=str(c.get("by") or "")[:60], byc=str(c.get("byc") or "")[:16], at=now_iso(), resolved=False)
    if not old and c.get("src") == "dict":
        base["src"] = "dict"  # nadiktováno mikrofonem
    if "resolved" in c:
        base["resolved"] = bool(c["resolved"])
    base["edited"] = now_iso() if old else None
    if not base.get("text"):
        raise ValueError("prázdný komentář")
    return base


def apply_op(bid, op):
    """Jedna změna připomínek; vrací, co poslat ostatním (s doplněným časem a autorem)."""
    d = batch_dir(bid)
    kind = op.get("op")
    with lock:
        nt = load_notes(d)
        out = {"op": kind}
        if kind == "stroke.add":
            out["strokes"] = [clean_stroke(s) for s in (op.get("strokes") or [])[:500]]
            for s in out["strokes"]:
                nt["strokes"][s["id"]] = s
        elif kind == "stroke.del":
            out["ids"] = [i for i in (op.get("ids") or []) if isinstance(i, str)][:2000]
            for i in out["ids"]:
                nt["strokes"].pop(i, None)
        elif kind == "comment.set":
            c = op.get("comment") or {}
            out["comment"] = clean_comment(c, nt["comments"].get(c.get("id")))
            nt["comments"][out["comment"]["id"]] = out["comment"]
        elif kind == "comment.del":
            out["id"] = str(op.get("id") or "")
            nt["comments"].pop(out["id"], None)
        elif kind == "verdict":
            n = str(int(op["n"]))
            out["n"] = int(n)
            if op.get("v") in ("ok", "no"):
                out["verdict"] = nt["verdicts"][n] = {"v": op["v"], "by": str(op.get("by") or "")[:60], "at": now_iso()}
            else:
                out["verdict"] = None
                nt["verdicts"].pop(n, None)
        else:
            raise ValueError("neznámá změna")
        nt["rev"] += 1
        nt["updated"] = now_iso()
        out["rev"] = nt["rev"]
        save_json(notes_path(d), nt)
    return out


# ---------- revize pro Clauda ----------
def tc(t, fps):
    """mm:ss:ff jako ve střižně (snímek v rámci vteřiny)."""
    r = max(1, int(round(fps or 30)))
    f = int((t or 0) * (fps or 30) + 1e-4)
    s = f // r
    return "%02d:%02d:%02d" % (s // 60, s % 60, f % r)


def png_size(path):
    try:
        with open(path, "rb") as f:
            head = f.read(24)
        return struct.unpack(">II", head[16:24]) if head[:8] == b"\x89PNG\r\n\x1a\n" else (0, 0)
    except OSError:
        return 0, 0


def composite(item, media, frame, overlay_png, out):
    """Snímek z náhledu (přesně ten, který člověk viděl) + vrstva s kresbou → JPG."""
    ffmpeg = config.tool("ffmpeg")
    rw, rh = png_size(overlay_png) if overlay_png else (0, 0)
    rw, rh = rw or item.get("rw") or item.get("width"), rh or item.get("rh") or item.get("height")
    if not ffmpeg or not rw or not rh:
        return False  # bez ffmpeg se revize odešle i tak, jen bez obrázků
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-y", "-v", "error"]
    if item["kind"] == "video":
        # -ss před -i zahodí snímky s časem menším než zadaný: půl snímku PŘED začátkem = přesně snímek frame
        cmd += ["-ss", "%.5f" % (max(0.0, frame - 0.5) / float(item.get("fps") or 30))]
    cmd += ["-i", media]
    if overlay_png:
        cmd += ["-i", overlay_png, "-filter_complex", "[0:v]scale=%d:%d,format=rgba[b];[b][1:v]overlay=0:0,format=yuvj420p" % (rw, rh)]
    else:
        cmd += ["-vf", "scale=%d:%d" % (rw, rh)]
    cmd += ["-frames:v", "1", "-q:v", "3", out]
    r = run(cmd, timeout=120)
    return r.returncode == 0


def submit(bid, overlays, by):
    """Hotovo: složka revize/<čas>__<dávka> s revize.md (pro Clauda), revize.json a obrázky."""
    d = batch_dir(bid)
    with lock:
        b = load_json(os.path.join(d, "batch.json"), {})
        nt = load_notes(d)
        prev = (b.get("submissions") or [{}])[-1].get("at", "")
        stamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        folder = os.path.join(revize(), "%s__%s" % (stamp, bid))
        os.makedirs(folder, exist_ok=True)
        items = {it["n"]: it for it in b.get("items", [])}
        frames = {}
        for s in nt["strokes"].values():
            frames.setdefault((s["n"], s["frame"] if items.get(s["n"], {}).get("kind") == "video" else 0), {"strokes": [], "comments": []})["strokes"].append(s)
        for c in nt["comments"].values():
            key = (c["n"], c["frame"] if c.get("frame") is not None and items.get(c["n"], {}).get("kind") == "video" else (0 if items.get(c["n"], {}).get("kind") == "image" else None))
            frames.setdefault(key, {"strokes": [], "comments": []})["comments"].append(c)
        order = comment_order(nt)
        tmpdir = os.path.join(folder, ".tmp")
        os.makedirs(tmpdir, exist_ok=True)
        rows = []
        for (n, frame), g in sorted(frames.items(), key=lambda kv: (kv[0][0], -1 if kv[0][1] is None else kv[0][1])):
            it = items.get(n)
            if not it:
                continue
            img_name = None
            if frame is not None and it.get("file"):
                ov = overlays.get("%d:%d" % (n, frame)) or ""
                ovp = None
                if ov.startswith("data:image/png;base64,"):
                    ovp = os.path.join(tmpdir, "%d_%d.png" % (n, frame))
                    with open(ovp, "wb") as f:
                        f.write(base64.b64decode(ov.split(",", 1)[1]))
                if it["kind"] == "video":
                    img_name = "%02d_%s_f%d.jpg" % (n, tc((frame + 0.5) / float(it.get("fps") or 30), it.get("fps")).replace(":", "-"), frame)
                else:
                    img_name = "%02d.jpg" % n
                if not composite(it, os.path.join(d, it["file"]), frame, ovp, os.path.join(folder, img_name)):
                    img_name = None
            fps = float(it.get("fps") or 30)
            t = (frame + 0.5) / fps if (frame is not None and it["kind"] == "video") else None
            authors = sorted({x.get("by") for x in g["strokes"] + g["comments"] if x.get("by")})
            rows.append({"n": n, "kind": it["kind"], "name": it.get("name"), "source": it.get("source"),
                         "frame": frame if it["kind"] == "video" else None, "time": round(t, 3) if t is not None else None,
                         "tc": tc(t, fps) if t is not None else None, "image": img_name,
                         "drawings": len(g["strokes"]), "authors": authors,
                         "comments": [{"order": order.get(c["id"]), "text": c["text"], "by": c.get("by"), "resolved": c.get("resolved", False),
                                       "dictated": c.get("src") == "dict"}
                                      for c in sorted(g["comments"], key=lambda c: c.get("at", ""))],
                         "changed": any((x.get("at") or "") > prev for x in g["strokes"] + g["comments"])})
        shutil.rmtree(tmpdir, ignore_errors=True)
        verdicts = {int(k): v for k, v in nt["verdicts"].items()}
        rev = {"app": "Pult %s" % config.VERSION, "batch": bid, "title": b.get("title", bid), "submitted": now_iso(),
               "by": by, "previous_submission": prev or None, "folder": folder, "origin": b.get("origin"),
               "items": [{"n": it["n"], "kind": it["kind"], "name": it.get("name"), "source": it.get("source"),
                          "verdict": (verdicts.get(it["n"]) or {}).get("v"), "verdict_by": (verdicts.get(it["n"]) or {}).get("by"),
                          "width": it.get("src_width") or it.get("width"), "height": it.get("src_height") or it.get("height"),
                          "fps": it.get("fps"), "duration": it.get("duration"),
                          "agent_note": (b.get("agent_notes") or {}).get(str(it["n"]))} for it in b.get("items", [])],
               "agent_note": (b.get("agent_notes") or {}).get("0"),
               "notes": rows}
        save_json(os.path.join(folder, "revize.json"), rev)
        with open(os.path.join(folder, "revize.md"), "w", encoding="utf-8") as f:
            f.write(review_md(rev))
        b.setdefault("submissions", []).append({"at": rev["submitted"], "by": by, "folder": os.path.basename(folder)})
        b["status"], b["status_at"] = "done", rev["submitted"]
        save_json(os.path.join(d, "batch.json"), b)
    return {"folder": folder, "name": os.path.basename(folder), "notes": len(rows),
            "drawings": sum(r["drawings"] for r in rows), "comments": sum(len(r["comments"]) for r in rows)}


def review_md(rev):
    V = {"ok": "✅ schváleno", "no": "❌ zamítnuto", None: "bez verdiktu"}
    notes = rev["notes"]
    lines = ["# Revize: %s" % rev["title"], "",
             "- Dávka: `%s`" % rev["batch"], "- Odesláno: %s%s" % (rev["submitted"], (" (%s)" % rev["by"]) if rev.get("by") else ""),
             "- Připomínek: %d (kreseb %d, komentářů %d)" % (len(notes), sum(r["drawings"] for r in notes), sum(len(r["comments"]) for r in notes)),
             "- Číslo v hranaté závorce u komentáře = pořadí, v jakém vznikal (u každé položky zvlášť). Revizor video pouští víckrát,"
             " takže pozdější číslo u dřívějšího času znamená, že se k místu vrátil.",
             "- Časy jsou `mm:ss:ff` (minuty:sekundy:snímek v rámci vteřiny) a v sekundách; snímek = pořadí od 0.",
             "- Obrázky ukazují přesný snímek i s kresbou. Když nic neschválili ani nenapsali, platí, že je položka v pořádku."]
    o = rev.get("origin") or {}
    if o.get("host_session") or o.get("session"):
        lines.append("- Dávku poslal chat `%s`%s." % (o.get("host_session") or o.get("session"),
                                                     (" (složka `%s`)" % o["cwd"]) if o.get("cwd") else ""))
    if rev.get("agent_note"):
        lines.append("- Tvoje poznámka k dávce (revizor ji v Pultu viděl): %s" % rev["agent_note"].replace("\n", " "))
    lines.append("")
    by_n = {}
    for r in notes:
        by_n.setdefault(r["n"], []).append(r)
    for it in rev["items"]:
        meta = it["kind"] if it["kind"] == "image" else "video %s fps, %s s" % (round(it.get("fps") or 0, 3), round(it.get("duration") or 0, 2))
        lines.append("## #%02d %s" % (it["n"], it.get("name") or ""))
        lines.append("- %s · %s×%s · %s%s" % (meta, it.get("width"), it.get("height"), V.get(it.get("verdict")),
                                             (" (%s)" % it["verdict_by"]) if it.get("verdict_by") else ""))
        lines.append("- Zdroj: `%s`" % it.get("source"))
        if it.get("agent_note"):
            lines.append("- Tvoje poznámka u položky: %s" % it["agent_note"].replace("\n", " "))
        for r in by_n.get(it["n"], []):
            where = "%s (%.3f s, snímek %d)" % (r["tc"], r["time"], r["frame"]) if r.get("tc") else ("obrázek" if r["kind"] == "image" else "celé video")
            head = "- **%s**" % where
            if r["drawings"]:
                head += " · kresba (%d tah%s)" % (r["drawings"], "" if r["drawings"] == 1 else "y" if r["drawings"] < 5 else "ů")
            if r["authors"]:
                head += " · " + ", ".join(r["authors"])
            if r.get("image"):
                head += " · obrázek `%s`" % r["image"]
            if not r["changed"] and rev.get("previous_submission"):
                head += " · beze změny od minulé revize"
            lines.append(head)
            for c in r["comments"]:
                lines.append("  - %s%s%s%s: %s" % ("[%d] " % c["order"] if c.get("order") else "", c.get("by") or "?", " (nadiktováno, přepis může mít chyby)" if c.get("dictated") else "",
                                                 " (vyřešeno)" if c.get("resolved") else "", c["text"].replace("\n", " ")))
        lines.append("")
    if not notes and not any(it.get("verdict") for it in rev["items"]):
        lines.append("Bez připomínek: dávka prošla a je schválená.")
    return "\n".join(lines) + "\n"


def unsubmit(bid, name):
    """Vrátit omylem odeslanou revizi (jen dokud ji Claude nezpracoval = je pořád v revize/)."""
    d = batch_dir(bid)
    if not safe_id(name) or not name.endswith("__" + bid):
        raise ValueError("neplatná revize")
    p = os.path.join(revize(), name)
    with lock:
        if not os.path.isdir(p):
            return False
        os.makedirs(kos(), exist_ok=True)
        dst = os.path.join(kos(), "revize_" + name)
        if os.path.exists(dst):
            dst += "_" + uuid.uuid4().hex[:6]
        shutil.move(p, dst)  # nic se nemaže natrvalo: vrácená revize jde do koše
        b = load_json(os.path.join(d, "batch.json"), {})
        b["submissions"] = [s for s in b.get("submissions", []) if s.get("folder") != name]
        b["status"], b["status_at"] = "open", now_iso()
        save_json(os.path.join(d, "batch.json"), b)
    return True


def reviews(include_archived=False):
    out = []
    for base, archived in ((revize(), False), (archiv(), True)):
        if archived and not include_archived or not os.path.isdir(base):
            continue
        for name in os.listdir(base):
            r = load_json(os.path.join(base, name, "revize.json"), None)
            if r:
                out.append({"folder": os.path.join(base, name), "name": name, "archived": archived, "batch": r.get("batch"),
                            "title": r.get("title"), "submitted": r.get("submitted"), "by": r.get("by"),
                            "notes": len(r.get("notes", [])), "md": os.path.join(base, name, "revize.md")})
    out.sort(key=lambda r: r["submitted"] or "")
    return out


def archive_review(target, text=""):
    """Zpracovanou revizi přesune do archivu (Claude ji tím označí jako hotovou)."""
    names = [r["name"] for r in reviews()] if target == "all" else [os.path.basename(os.path.normpath(target))]
    done = []
    os.makedirs(archiv(), exist_ok=True)
    for name in names:
        p = os.path.join(revize(), name)
        if safe_id(name) and os.path.isdir(p):
            r = load_json(os.path.join(p, "revize.json"), None)
            shutil.move(p, os.path.join(archiv(), name))
            done.append(name)
            bid = isinstance(r, dict) and r.get("batch")
            if bid and safe_id(bid) and os.path.isdir(batch_dir(bid)):
                finish_working(bid, text)
    return done


# ---------- úklid a složka Vstup ----------
def cleanup(days):
    """Odeslané a smazané dávky starší než N dní přesune do koše (Pult/kos). Nic nemaže natrvalo."""
    moved = []
    if not days or not os.path.isdir(davky()):
        return moved
    limit = time.time() - days * 86400
    for name in os.listdir(davky()):
        b = load_json(os.path.join(davky(), name, "batch.json"), None)
        if not b or b.get("status") not in ("done", "dismissed"):
            continue
        try:
            since = datetime.fromisoformat(b.get("status_at") or b.get("created")).timestamp()
        except (TypeError, ValueError):
            continue
        if since < limit:
            os.makedirs(kos(), exist_ok=True)
            dst = os.path.join(kos(), name)
            if os.path.exists(dst):
                dst += "_" + uuid.uuid4().hex[:4]
            try:
                shutil.move(os.path.join(davky(), name), dst)
                moved.append(b.get("title", name))
            except OSError:
                pass
    return moved


def trash_size():
    total = 0
    for dp, _dn, fns in os.walk(kos()):
        for fn in fns:
            try:
                total += os.path.getsize(os.path.join(dp, fn))
            except OSError:
                pass
    return total


def empty_trash():
    if os.path.isdir(kos()):
        shutil.rmtree(kos(), ignore_errors=True)


class Inbox:
    """Hlídá složku Vstup: soubory přímo v ní = dávka „Vstup …“, podsložka = dávka s jejím názvem.
    Importuje až když se velikost souborů dvakrát po sobě nezmění (dokopírováno)."""

    def __init__(self, emit):
        self.emit = emit
        self.seen = {}

    def scan(self):
        cfg = config.load()
        if not cfg.get("inbox_enabled"):
            return
        box = config.inbox(cfg)
        os.makedirs(box, exist_ok=True)
        groups = {}
        for name in os.listdir(box):
            p = os.path.join(box, name)
            if name.startswith((".", "_")):
                continue
            if os.path.islink(p):
                continue  # odkazy ve Vstupu nebrat (mohly by mířit na cizí soubory)
            if os.path.isdir(p):
                files = collect([p])
                if files:
                    groups[p] = files
            elif kind_of(p) and os.path.isfile(p):
                groups.setdefault(box, []).append(p)
        state = {}
        for key, files in groups.items():
            try:
                state[key] = tuple((f, os.path.getsize(f), os.path.getmtime(f)) for f in files)
            except OSError:
                continue
        for key, sig in state.items():
            if self.seen.get(key) == sig and time.time() - max(s[2] for s in sig) > 2:
                self.take(box, key, [s[0] for s in sig])
        self.seen = state

    def take(self, box, key, files):
        title = os.path.basename(key) if key != box else datetime.now().strftime("Vstup %d. %m. %H:%M")
        dst = os.path.join(box, "_importovano", "%s_%s" % (datetime.now().strftime("%Y-%m-%d_%H%M%S"), slug(title)))
        os.makedirs(dst, exist_ok=True)
        moved = []
        for f in files:
            to = os.path.join(dst, os.path.basename(f))
            try:
                shutil.move(f, to)
                moved.append(to)
            except OSError:
                pass
        if key != box and not os.listdir(key):
            os.rmdir(key)
        if moved:
            bid = create_batch(title)
            add_items(bid, moved)
            self.emit({"type": "batches", "batch": bid, "new": True})
