#!/usr/bin/env python3
"""Pult: lokální server (web aplikace, média, připomínky, revize pro Clauda, týmové sdílení v síti)."""
import email.utils
import hmac
import json
import mimetypes
import os
import queue
import re
import socket
import ssl
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aimeta  # noqa: E402
import config  # noqa: E402
import dictation  # noqa: E402
import library  # noqa: E402
import messages  # noqa: E402
import tls  # noqa: E402

for ext, typ in ((".mp4", "video/mp4"), (".mov", "video/quicktime"), (".webp", "image/webp"), (".avif", "image/avif"),
                 (".webmanifest", "application/manifest+json"), (".js", "text/javascript"), (".mjs", "text/javascript"),
                 (".css", "text/css"), (".svg", "image/svg+xml"), (".woff2", "font/woff2")):
    mimetypes.add_type(typ, ext)

started = time.time()
hub_lock = threading.Lock()
clients = {}      # id spojení → fronta zpráv
presence = {}     # id klienta → kdo to je a kde v pultu je
last_sync = None
log_lock = threading.Lock()


def log(*a):
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + " ".join(str(x) for x in a)
    print(line, flush=True)


# ---------- živé zprávy (SSE) ----------
def broadcast(msg):
    data = json.dumps(msg, ensure_ascii=False)
    with hub_lock:
        for q in list(clients.values()):
            q.put(data)


_pres_timer = None


_audio_out = {"at": 0, "v": {"name": "", "bluetooth": False}}


def audio_output():
    """Kam teď Mac hraje zvuk (AirPods a jiná Bluetooth sluchátka mají zpoždění, které macOS nehlásí)."""
    if time.time() - _audio_out["at"] < 8:
        return _audio_out["v"]
    v = {"name": "", "bluetooth": False}
    if sys.platform == "darwin":
        try:
            out = subprocess.run(["system_profiler", "SPAudioDataType", "-json"], capture_output=True, text=True, timeout=5).stdout
            for d in json.loads(out)["SPAudioDataType"][0]["_items"]:
                if d.get("coreaudio_default_audio_output_device") == "spaudio_yes":
                    v = {"name": d.get("_name", ""), "bluetooth": "bluetooth" in str(d.get("coreaudio_device_transport", ""))}
                    break
        except Exception:
            pass
    _audio_out.update(at=time.time(), v=v)
    return v


def presence_changed():
    """Seznam lidí na pultu posílat nejvýš ~4× za vteřinu."""
    global _pres_timer
    with hub_lock:
        if _pres_timer:
            return
        _pres_timer = threading.Timer(0.25, _send_presence)
        _pres_timer.daemon = True
        _pres_timer.start()


def _send_presence():
    global _pres_timer
    with hub_lock:
        _pres_timer = None
        people = [{k: v for k, v in p.items() if k not in ("ip", "conns")} for p in presence.values() if p.get("conns")]
    broadcast({"type": "presence", "people": people})


# ---------- síť ----------
def is_loopback(ip):
    ip = (ip or "").replace("::ffff:", "")
    return ip == "127.0.0.1" or ip == "::1"


def lan_addresses():
    """Adresy, na kterých se k pultu připojí kolegové (primární IP, název .local, Tailscale)."""
    out = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # nic se neposílá, jen se zjistí výchozí rozhraní
        ip = s.getsockname()[0]
        s.close()
        if not ip.startswith("127."):
            out.append(ip)
    except OSError:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if not ip.startswith("127.") and ip not in out:
                out.append(ip)
    except OSError:
        pass
    if config.IS_MAC:
        try:
            r = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True, timeout=3)
            if r.stdout.strip():
                out.append(r.stdout.strip() + ".local")
        except (OSError, subprocess.SubprocessError):
            pass
    return out


own = {"t": 0.0, "names": set()}


def own_names():
    """Jména a IP tohoto počítače (odkaz „Pro kolegy“ otevřený přímo na něm); obnovují se jednou za minutu."""
    if time.time() - own["t"] > 60:
        n = socket.gethostname().lower()
        own["names"] = {n, n.split(".")[0]} | {a.lower() for a in lan_addresses()}
        own["t"] = time.time()
    return own["names"]


def host_ok(host, local):
    """Ochrana proti DNS rebinding: z tohoto počítače jen localhost, z jiných jen IP a jména v místní síti
    (tam navíc chrání přístupový kód)."""
    h = (host or "").strip().lower()
    if h.startswith("["):
        h = h[1:h.find("]")]
    else:
        h = h.rsplit(":", 1)[0] if h.count(":") == 1 else h
    if local:
        return h in ("localhost", "127.0.0.1", "::1") or h in own_names()
    if not h or h.endswith((".local", ".ts.net", ".lan", ".home")):
        return True
    if re.fullmatch(r"[\d.]+", h) or ":" in h:
        return True
    name = socket.gethostname().lower()
    return h in (name, name.split(".")[0])


# ---------- hádání přístupového kódu ----------
code_tries = {}  # IP → {kód: čas}; blokuje se až po 8 různých špatných kódech za 10 min


def wrong_code(ip, code):
    with hub_lock:
        t = code_tries.setdefault(ip, {})
        t[code[:12]] = time.time()


def guessing(ip):
    with hub_lock:
        t = code_tries.get(ip)
        if not t:
            return False
        limit = time.time() - 600
        for k in [k for k, v in t.items() if v < limit]:
            del t[k]
        return len(t) >= 8


# ---------- HTTP ----------
LOGIN_HTML = """<!doctype html><html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pult</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0e10;color:#f2f2f4;font:16px -apple-system,Segoe UI,system-ui,sans-serif}
form{width:min(340px,90vw);padding:28px;border-radius:18px;background:#18181b;border:1px solid #2a2a30;text-align:center}
h1{font-size:22px;margin:0 0 6px}p{color:#9a9aa3;margin:0 0 18px;font-size:14px;line-height:1.4}
input{width:100%;box-sizing:border-box;font:600 24px ui-monospace,monospace;letter-spacing:.3em;text-align:center;padding:12px;border-radius:12px;border:1px solid #33333a;background:#0e0e10;color:#fff}
button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:12px;background:#f2f2f1;color:#0b0b0b;font:600 16px inherit;cursor:pointer}.e{color:#ff6b5e}</style></head>
<body><form method="get" action="/"><h1>Pult</h1><p>{msg}</p><input name="k" inputmode="numeric" autocomplete="one-time-code" autofocus placeholder="000000"><button>{go}</button></form></body></html>"""


def natural_scrolling():
    """Je na tomhle Macu zapnuté přirozené posouvání? Chrome to stránce neřekne. Mimo macOS None."""
    if sys.platform != "darwin":
        return None
    try:
        r = subprocess.run(["defaults", "read", "-g", "com.apple.swipescrolldirection"], capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() != "0"  # klíč chybí = výchozí stav macOS, tedy zapnuté


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Pult/" + config.VERSION

    def log_message(self, fmt, *args):
        pass

    def setup(self):
        if isinstance(self.request, ssl.SSLSocket):  # https: TLS až tady, ať pomalý klient nezdrží ostatní
            self.request.do_handshake()
            self.request.settimeout(None)
        super().setup()

    # --- pomocné ---
    def ip(self):
        return self.client_address[0]

    def local(self):
        return is_loopback(self.ip())

    def query(self):
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    def end_headers(self):
        # Pult se nesmí vkládat do cizích stránek (clickjacking) a cizí weby nesmí vkládat jeho média
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def cookie_code(self):
        m = re.search(r"(?:^|;\s*)pult_k=(\d+)", self.headers.get("Cookie") or "")
        return m.group(1) if m else None

    def allowed(self):
        """Lokální přístup vždy; z jiného počítače jen při zapnutém sdílení a se správným kódem."""
        if not host_ok(self.headers.get("Host"), self.local()):
            self.send_json({"error": "neplatná adresa"}, 403)
            return False
        if self.command in ("POST", "PUT") and not self.same_site():
            self.send_json({"error": "požadavek z cizí stránky"}, 403)
            return False
        if self.local():
            return True
        if urlparse(self.path).path == "/pult-ca.crt":
            return True  # veřejná část certifikátu (bez klíče): iPad si ji stáhne ještě před zadáním kódu
        cfg = config.load()
        if not cfg.get("share"):
            self.send_json({"error": "Pult on this computer is not shared. Turn on sharing in Settings › Team."}, 403)
            return False
        code = cfg.get("access_code")
        q = self.query()
        if guessing(self.ip()):
            self.send_json({"error": "Too many attempts. Try again in a few minutes."}, 429)
            return False
        tried = q.get("k") or self.cookie_code()
        if tried and not hmac.compare_digest(str(tried), str(code or "")):
            wrong_code(self.ip(), tried)
        if q.get("k") and code and hmac.compare_digest(str(q["k"]), str(code)):
            self.send_response(302)
            self.send_header("Set-Cookie", "pult_k=%s; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly" % code)
            self.send_header("Location", "/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False
        if code and self.cookie_code() and hmac.compare_digest(self.cookie_code(), str(code)):
            return True
        path = urlparse(self.path).path
        if path.startswith("/api/") or path.startswith("/media/"):
            self.send_json({"error": "Access code required."}, 401)
        else:
            cs = (self.headers.get("Accept-Language") or "").lower().startswith("cs")
            if q.get("k"):
                msg = "Špatný kód, zkus to znovu." if cs else "Wrong code, try again."
            else:
                msg = "Zadej přístupový kód od toho, kdo Pult sdílí." if cs else "Enter the access code from the person sharing Pult."
            page = LOGIN_HTML.replace("{lang}", "cs" if cs else "en").replace("{go}", "Vstoupit" if cs else "Enter")
            self.send_html(page.replace("{msg}", ('<span class="e">%s</span>' % msg) if q.get("k") else msg), 200)
        return False

    def same_site(self):
        """Zápis jen z vlastní stránky Pultu nebo z příkazové řádky (bez Origin), nikdy z cizího webu."""
        if (self.headers.get("Sec-Fetch-Site") or "") == "cross-site":
            return False
        origin = self.headers.get("Origin")
        if origin:
            return origin != "null" and urlparse(origin).netloc.lower() == (self.headers.get("Host") or "").lower()
        return True

    def need_local(self):
        if not self.local():
            self.send_json({"error": "Jen na počítači, kde Pult běží."}, 403)
            return False
        return True

    def ui_lang(self):
        """Jazyk rozhraní, které se ptá (hlavička z api() v core.js), jinak podle prohlížeče."""
        h = (self.headers.get("X-Pult-Lang") or "").lower()
        if h in ("cs", "en"):
            return h
        return "cs" if (self.headers.get("Accept-Language") or "").lower().startswith(("cs", "sk")) else "en"

    def send_json(self, obj, code=200):
        if isinstance(obj, dict) and isinstance(obj.get("error"), str) and self.ui_lang() == "en":
            obj = dict(obj, error=messages.en(obj["error"]))
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_html(self, html, code=200):
        data = html.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def body(self, limit=200 * 1024 * 1024):
        n = int(self.headers.get("Content-Length") or 0)
        if n < 0 or n > limit:
            raise ValueError("příliš velký požadavek")
        raw = self.rfile.read(n) if n else b""
        return json.loads(raw.decode("utf-8") or "{}") if raw else {}

    def send_file(self, path, cache="no-cache", head=False, name=None):
        st = os.stat(path)
        size, mtime = st.st_size, int(st.st_mtime)
        lm = email.utils.formatdate(mtime, usegmt=True)
        ims = self.headers.get("If-Modified-Since")
        if ims and not self.headers.get("Range"):
            try:
                if int(email.utils.parsedate_to_datetime(ims).timestamp()) >= mtime:
                    self.send_response(304)
                    self.send_header("Last-Modified", lm)
                    self.send_header("Cache-Control", cache)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
            except (TypeError, ValueError):
                pass
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/json", "application/manifest+json", "text/javascript"):
            ctype += "; charset=utf-8"
        start, end = 0, size - 1
        m = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range") or "")
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            if start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        else:
            self.send_response(200)
        length = end - start + 1
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Last-Modified", lm)
        self.send_header("Cache-Control", cache)
        if name:  # stažení pod původním jménem (přetažení do Zpráv, Finderu)
            self.send_header("Content-Disposition", "attachment; filename*=UTF-8''%s" % quote(name, safe=""))
        self.end_headers()
        if head:
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            try:
                while left > 0:
                    chunk = f.read(min(1 << 18, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    # --- GET ---
    def do_HEAD(self):
        self.do_GET(head=True)

    def do_GET(self, head=False):
        if not self.allowed():
            return
        path = unquote(urlparse(self.path).path)
        try:
            if path == "/lang.js":  # výchozí jazyk z nastavení Pultu (načítá se před aplikací)
                cfg = config.load()
                lang = cfg.get("lang") or ""
                data = ("window.PULT_DEFAULT_LANG=%s;window.PULT_AUTHOR=%s;" % (
                    json.dumps(lang if lang in ("cs", "en") else ""),
                    "false" if cfg.get("author_card", config.DEFAULTS.get("author_card", True)) is False else "true")).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/javascript; charset=utf-8")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if not head:
                    self.wfile.write(data)
                return
            if path in ("/", "/index.html"):
                return self.send_file(os.path.join(config.STATIC, "index.html"), "no-cache", head)
            if path == "/pult-ca.crt":  # certifikát Pultu pro iPad (Nastavení › Diktování)
                ca = tls.files()["ca.crt"]
                if not os.path.isfile(ca):
                    return self.send_json({"error": "zabezpečená adresa není zapnutá"}, 404)
                with open(ca, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/x-x509-ca-cert")
                self.send_header("Content-Disposition", 'attachment; filename="Pult.crt"')
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                if not head:
                    self.wfile.write(data)
                return
            if path == "/sw.js":  # service worker musí ležet v kořeni (rozsah celé aplikace)
                return self.send_file(os.path.join(config.STATIC, "sw.js"), "no-cache", head)
            if path.startswith("/static/"):
                p = os.path.normpath(os.path.join(config.STATIC, path[len("/static/"):]))
                if p.startswith(config.STATIC + os.sep) and os.path.isfile(p):
                    return self.send_file(p, "no-cache", head)
                return self.send_json({"error": "nenalezeno"}, 404)
            if path.startswith("/media/"):
                bid, _, rel = path[len("/media/"):].partition("/")
                d = library.batch_dir(bid)
                p = os.path.normpath(os.path.join(d, rel))
                sub = os.path.relpath(p, d).split(os.sep)[0] if p.startswith(d + os.sep) else ""
                if sub in ("media", "thumb", "src") and os.path.isfile(p) and not os.path.islink(p):
                    return self.send_file(p, "private, max-age=600", head)
                return self.send_json({"error": "nenalezeno"}, 404)
            m = re.match(r"/api/ai-meta/([^/]+)/(\d+)$", path)
            if m:  # stopy AI v metadatech originálu (Instagram a YouTube podle nich značí „AI“)
                return self.send_json(ai_meta(m.group(1), int(m.group(2))))
            m = re.match(r"/api/file/([^/]+)/(\d+)$", path)
            if m:  # původní soubor položky (přetažení ven z Pultu, Sdílet, Stáhnout)
                p, name = item_file(m.group(1), int(m.group(2)))
                if not p:
                    return self.send_json({"error": "nenalezeno"}, 404)
                return self.send_file(p, "private, max-age=600", head, name)
            if path == "/api/time":
                return self.send_json({"t": time.time()})
            if path == "/api/batches":
                return self.send_json({"batches": library.list_batches()})
            if path.startswith("/api/batch/"):
                b, nt = library.get_batch(path[len("/api/batch/"):])
                return self.send_json({"batch": b, "notes": nt})
            if path == "/api/events":
                return self.events()
            if path == "/api/status":
                return self.send_json(status())
            if path == "/api/settings":
                return self.send_json(settings_view(self.local()))
            if path == "/api/audio-output":
                return self.send_json(audio_output() if self.local() else {"name": "", "bluetooth": False})
            if path == "/api/scroll-direction":
                return self.send_json({"natural": natural_scrolling() if self.local() else None})
            if path == "/api/reviews":
                return self.send_json({"reviews": library.reviews(include_archived=self.query().get("all") == "1")})
            return self.send_json({"error": "nenalezeno"}, 404)
        except FileNotFoundError:
            return self.send_json({"error": "nenalezeno"}, 404)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)

    # --- POST / PUT ---
    def do_PUT(self):
        if not self.allowed():
            return
        path = urlparse(self.path).path
        try:
            if path.startswith("/api/upload/"):
                return self.upload(path[len("/api/upload/"):])
            return self.send_json({"error": "nenalezeno"}, 404)
        except FileNotFoundError:
            return self.send_json({"error": "dávka nenalezena"}, 404)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        except OSError as e:
            log("Chyba nahrávání:", e)
            return self.send_json({"error": "Chyba souboru na serveru: %s" % e}, 500)

    def do_POST(self):
        global last_sync
        if not self.allowed():
            return
        path = urlparse(self.path).path
        if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
            return self.send_json({"error": "očekávám JSON"}, 415)
        try:
            body = self.body()
            frm = str(body.get("from") or "")[:40]
            if path == "/api/sync":
                body.update(type="sync", server_time=time.time())
                last_sync = body
                broadcast(body)
                return self.send_json({"ok": True, "server_time": body["server_time"]})
            if path == "/api/dict-claim":  # diktování začalo na jednom zařízení: ostatní téhož člověka ho vypnou
                broadcast({"type": "dict-claim", "from": frm, "by": str(body.get("by") or "")[:60]})
                return self.send_json({"ok": True})
            if path == "/api/focus":
                # přepnutí dávky/položky: zařízení téhož člověka (Mac a iPad) jdou spolu i bez Spolu
                broadcast({"type": "focus", "from": frm, "by": str(body.get("by") or "")[:60],
                           "batch": body.get("batch"), "n": body.get("n")})
                return self.send_json({"ok": True})
            if path == "/api/presence":
                with hub_lock:
                    p = presence.get(frm)
                    if p is not None:
                        for k in ("name", "color", "batch", "n", "frame", "playing", "together", "view"):
                            if k in body:
                                p[k] = clean_presence(k, body[k])
                        p["seen"] = time.time()
                presence_changed()
                return self.send_json({"ok": True})
            if path == "/api/live":
                body["type"] = "live"
                broadcast(body)
                return self.send_json({"ok": True})
            if path == "/api/dictation/warm":
                if not self.need_local():
                    return
                dictation.warm()
                return self.send_json({"ok": True, "dictation": dictation.status()})
            if path == "/api/dictation/key":  # API klíč ElevenLabs: jen z tohoto počítače, zpátky se nikdy neposílá celý
                if not self.need_local():
                    return
                if body.get("delete"):
                    dictation.delete_el_key()
                else:
                    try:
                        dictation.save_el_key(body.get("key"))
                    except RuntimeError as e:
                        return self.send_json({"error": str(e)}, 502)
                return self.send_json({"ok": True, "dictation": dictation.status(force=True)})
            if path.startswith("/api/dictation/"):
                bid = path[len("/api/dictation/"):]
                library.batch_dir(bid)
                sid = dictation.save_segment(bid, body)
                broadcast({"type": "dictation", "batch": bid, "id": sid, "from": frm, "state": "queued"})
                return self.send_json({"ok": True, "id": sid, "queue": dictation.jobs.qsize()})
            if path.startswith("/api/notes/"):
                bid = path[len("/api/notes/"):]
                change = library.apply_op(bid, body)
                broadcast({"type": "notes", "batch": bid, "from": frm, "change": change})
                return self.send_json({"ok": True, "change": change})
            if path == "/api/batches":
                bid = library.create_batch(body.get("title"))
                broadcast({"type": "batches", "batch": bid})
                return self.send_json({"batch": bid})
            m = re.match(r"/api/batch/([^/]+)/(items|status|dismiss|label|agent-notes|rename|submit|unsubmit)$", path)
            if m:
                return self.batch_action(m.group(1), m.group(2), body, frm)
            if path == "/api/add":
                if not self.need_local():
                    return
                return self.send_json(add_files(body))
            if path == "/api/settings":
                if not self.need_local():
                    return
                return self.send_json(save_settings(body))
            if path == "/api/pick-folder":
                if not self.need_local():
                    return
                return self.send_json({"path": pick_folder(body.get("initial"))})
            if path == "/api/open":
                if not self.need_local():
                    return
                return self.send_json({"ok": open_place(body)})
            if path == "/api/can-read":  # umí server tyhle soubory otevřít? (macOS mu občas nepustí externí disk)
                if not self.need_local():
                    return
                bad = []
                for f in (body.get("paths") or [])[:2000]:
                    try:
                        with open(str(f), "rb") as fh:
                            fh.read(1)
                    except OSError:
                        bad.append(f)
                return self.send_json({"unreadable": bad})
            if path == "/api/ai-meta/clean":  # čistá kopie bez metadat vedle originálu (originál se nemění)
                if not self.need_local():
                    return
                p, _ = item_file(str(body.get("id")), int(body.get("n") or 0))
                if not p:
                    return self.send_json({"error": "soubor nenalezen"}, 404)
                try:
                    out, left = aimeta.clean_copy(p)
                except Exception as e:
                    return self.send_json({"error": str(e)}, 500)
                if config.IS_MAC:
                    subprocess.Popen(["open", "-R", out])
                return self.send_json({"ok": True, "path": out, "name": os.path.basename(out), "left": left})
            if path == "/api/copy-file":  # soubor do schránky jako ve Finderu: pak ⌘V do Zpráv nebo Mailu
                if not self.need_local():
                    return
                p, _ = item_file(str(body.get("id")), int(body.get("n") or 0))
                return self.send_json({"ok": bool(p) and copy_file(p)})
            if path == "/api/trash/empty":
                if not self.need_local():
                    return
                library.empty_trash()
                return self.send_json({"ok": True})
            if path == "/api/reviews/archive":
                if not self.need_local():
                    return
                return self.send_json({"archived": library.archive_review(str(body.get("target") or ""))})
            if path == "/api/command":  # pult reload: obnovit stránku na všech zařízeních
                if not self.need_local():
                    return
                if body.get("cmd") in ("reload",):
                    broadcast({"type": body["cmd"]})
                return self.send_json({"ok": True})
            if path == "/api/log":
                write_debug(self.ip(), body)
                return self.send_json({"ok": True})
            return self.send_json({"error": "nenalezeno"}, 404)
        except FileNotFoundError:
            return self.send_json({"error": "nenalezeno"}, 404)
        except (ValueError, KeyError, TypeError) as e:
            return self.send_json({"error": str(e)}, 400)
        except OSError as e:
            log("Chyba:", path, e)
            return self.send_json({"error": "Chyba souboru na serveru: %s" % e}, 500)

    def batch_action(self, bid, action, body, frm):
        if action == "items":
            d = library.batch_dir(bid)
            srcs = []
            for rel in body.get("uploads") or []:
                p = os.path.normpath(os.path.join(d, rel))
                if p.startswith(os.path.join(d, "src") + os.sep) and os.path.isfile(p):
                    srcs.append(p)
            items = library.add_items(bid, srcs)
            broadcast({"type": "batches", "batch": bid})
            broadcast({"type": "items", "batch": bid, "items": items})
            return self.send_json({"items": items})
        if action == "status":
            library.set_status(bid, body.get("status"))
            broadcast({"type": "batches", "batch": bid, "status": body.get("status"), "from": frm})
            return self.send_json({"ok": True})
        if action == "dismiss":  # pult dismiss: agent odklízí dávku vyřešenou v chatu
            if not self.need_local():
                return
            note = str(body.get("note") or "")[:300]
            r = library.dismiss_settled(bid, note)
            if r.get("ok") and not r.get("already"):
                broadcast({"type": "batches", "batch": bid, "status": "dismissed", "agent": True, "title": r.get("title"),
                           "note": note, "replacedBy": body.get("replaced_by") or None})
            return self.send_json(r)
        if action == "agent-notes":  # pult note: poznámka od Clauda k dávce nebo položce
            if not self.need_local():
                return
            notes = library.set_agent_notes(bid, body.get("notes") or {})
            broadcast({"type": "batches", "batch": bid})
            broadcast({"type": "agent-notes", "batch": bid, "notes": notes})
            return self.send_json({"ok": True, "notes": notes})
        if action == "label":
            library.set_label(bid, body.get("label"))
            broadcast({"type": "batches", "batch": bid})
            return self.send_json({"ok": True})
        if action == "rename":
            library.rename(bid, body.get("title"))
            broadcast({"type": "batches", "batch": bid})
            return self.send_json({"ok": True})
        if action == "submit":
            r = library.submit(bid, body.get("overlays") or {}, str(body.get("by") or "")[:60],
                               body.get("lang") if body.get("lang") in ("cs", "en") else config.ui_lang())
            broadcast({"type": "submitted", "batch": bid, "from": frm, "by": body.get("by"), "result": r})
            broadcast({"type": "batches", "batch": bid})
            return self.send_json(r)
        if action == "unsubmit":
            ok = library.unsubmit(bid, str(body.get("name") or ""))
            broadcast({"type": "batches", "batch": bid, "status": "open", "from": frm})
            return self.send_json({"ok": ok})

    def upload(self, bid):
        """Nahrání souboru z prohlížeče: tělo požadavku se rovnou zapisuje na disk (i velká videa)."""
        d = library.batch_dir(bid)
        name = library.safe_name(unquote(self.query().get("name") or "soubor"))
        if not library.kind_of(name):
            raise ValueError("Tenhle typ souboru Pult neumí: %s" % name)
        n = int(self.headers.get("Content-Length") or 0)
        os.makedirs(os.path.join(d, "src"), exist_ok=True)
        rel = "src/%s_%s" % (library.uuid.uuid4().hex[:6], name)
        dst = os.path.join(d, rel)
        left = n
        with open(dst + ".part", "wb") as f:
            while left > 0:
                chunk = self.rfile.read(min(1 << 20, left))
                if not chunk:
                    break
                f.write(chunk)
                left -= len(chunk)
        if left:
            os.remove(dst + ".part")
            raise ValueError("nahrávání přerušeno")
        os.replace(dst + ".part", dst)
        return self.send_json({"path": rel})

    def events(self):
        cid = re.sub(r"[^A-Za-z0-9_-]", "", self.query().get("c") or "")[:40] or library.uuid.uuid4().hex[:8]
        q = queue.Queue()
        conn = library.uuid.uuid4().hex
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        with hub_lock:
            clients[conn] = q
            p = presence.setdefault(cid, {"id": cid, "conns": 0})
            p["conns"] += 1
            p.update(ip=self.ip(), local=self.local(), seen=time.time())
        presence_changed()
        try:
            hello = {"type": "hello", "version": app_version(), "server_time": time.time(), "local": self.local(),
                     "sync": last_sync, "app": config.APP_NAME}
            self.wfile.write(("retry: 1500\ndata: %s\n\n" % json.dumps(hello, ensure_ascii=False)).encode("utf-8"))
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                    if msg is None:  # server se znovu navazuje (změna sdílení): spojení zavřít
                        break
                    self.wfile.write(("data: %s\n\n" % msg).encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            with hub_lock:
                clients.pop(conn, None)
                p = presence.get(cid)
                if p:
                    p["conns"] -= 1
                    if p["conns"] <= 0:
                        presence.pop(cid, None)
            presence_changed()


# ---------- akce ----------
def app_version():
    """Verze webové aplikace (z app.js): klienti se po připojení sami obnoví na novou."""
    try:
        with open(os.path.join(config.STATIC, "js", "app.js"), encoding="utf-8") as f:
            m = re.search(r'const VERSION = "([^"]+)"', f.read(3000))
        return m.group(1) if m else config.VERSION
    except OSError:
        return config.VERSION


def status():
    with hub_lock:
        people = [p.get("name") or ("bez jména" if config.ui_lang() == "cs" else "no name") for p in presence.values() if p.get("conns")]
    return {"ok": True, "app": config.APP_NAME, "version": config.VERSION, "web": app_version(), "library": library.root(),
            "uptime": int(time.time() - started), "clients": people, "queue": library.jobs.qsize(),
            "new_reviews": len(library.reviews()), "share": config.load().get("share")}


def ffmpeg_info():
    p = config.tool("ffmpeg")
    if not p:
        return None
    try:
        r = library.run([p, "-hide_banner", "-version"], timeout=10)
        return {"path": p, "version": (r.stdout.splitlines() or [""])[0].replace("ffmpeg version ", "").split(" ")[0]}
    except (OSError, subprocess.SubprocessError):
        return {"path": p, "version": "?"}


def settings_view(local):
    cfg = config.load()
    if not local:
        d = dictation.status()
        return {"local": False, "dictation": {k: d.get(k) for k in ("ready", "engine", "model", "reason", "choice")}, "https": https_info()}
    port = cfg.get("port")
    urls = ["http://%s:%d" % (a, port) for a in lan_addresses()]
    return {"local": True, "settings": cfg, "library": library.root(), "inbox": config.inbox(cfg), "urls": urls,
            "invite": ["%s/?k=%s" % (u, cfg.get("access_code")) for u in urls] if cfg.get("share") else [],
            "ffmpeg": ffmpeg_info(), "ffprobe": config.tool("ffprobe"), "version": config.VERSION,
            "python": sys.version.split()[0], "config": config.config_path(), "trash": library.trash_size(),
            "platform": "windows" if config.IS_WIN else "mac" if config.IS_MAC else "linux", "dictation": dictation.status(),
            "native_app": bool(config.native_app()),
            "https": https_info()}


def update_claude_paths(old_root, new_root):
    """Po změně knihovny přepíše cestu i v pokynech pro AI agenty (blok Pultu v CLAUDE.md / AGENTS.md a skill pult)."""
    if not old_root or old_root == new_root:
        return
    home = os.path.expanduser("~")
    files = []
    for base, name in ((os.path.join(home, ".claude"), "CLAUDE.md"), (os.path.join(home, ".codex"), "AGENTS.md")):  # jako install.py
        files += [(os.path.join(base, name), True), (os.path.join(base, "skills", "pult", "SKILL.md"), False)]
    for path, block in files:
        try:
            txt = open(path, encoding="utf-8").read()
        except OSError:
            continue
        if block:
            a, z = txt.find("<!-- PULT:START -->"), txt.find("<!-- PULT:END -->")
            if a < 0 or z < a:
                continue
            new = txt[:a] + txt[a:z].replace("`%s`" % old_root, "`%s`" % new_root) + txt[z:]
        else:
            new = txt.replace("`%s`" % old_root, "`%s`" % new_root)
        if new != txt:
            with open(path, "w", encoding="utf-8") as f:
                f.write(new)


RUN_KEYS = ("ffmpeg", "ffprobe", "asr_python")  # cesty ke spouštěným programům: jen `pult settings`, ne přes web


def clean_presence(k, v):
    if k == "color":
        return v if isinstance(v, str) and re.fullmatch(r"#[0-9a-fA-F]{3,8}", v) else ""
    if k in ("name", "batch", "view"):
        return str(v or "")[:120]
    if k in ("n", "frame"):
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    return bool(v)


def save_settings(body):
    for src in (body, body.get("settings") if isinstance(body.get("settings"), dict) else {}):
        for k in RUN_KEYS:
            src.pop(k, None)
    old = config.load()
    old_root = config.library(old)
    if body.get("new_code"):
        body["access_code"] = config.new_code()
    cfg = config.update(body.get("settings") or body)
    if cfg.get("library") != old.get("library"):
        library.ensure_dirs()
        library.requeue_unfinished()
        broadcast({"type": "batches", "batch": None})
        try:
            update_claude_paths(old_root, library.root())
        except Exception:  # pokyny pro Clauda nejsou důvod, aby změna knihovny selhala
            pass
    if (cfg.get("share"), cfg.get("port")) != (old.get("share"), old.get("port")) or cfg.get("access_code") != old.get("access_code"):
        threading.Timer(0.4, restart_listener).start()  # odpověď ještě odejde, pak se server znovu naváže
    return settings_view(True)


def add_files(body):
    """pult add z příkazové řádky: soubory zůstanou na místě (nebo se zkopírují), náhledy připraví server."""
    files = library.collect(body.get("files") or [])
    if not files:
        raise ValueError("Žádné podporované soubory (obrázky nebo videa).")
    bid = body.get("batch")
    if bid:
        library.batch_dir(bid)
    else:
        bid = library.create_batch(body.get("title") or os.path.splitext(os.path.basename(files[0]))[0], body.get("origin"))
    items = library.add_items(bid, files, copy=bool(body.get("copy", config.load().get("copy_originals"))))
    if body.get("notes"):
        library.set_agent_notes(bid, body["notes"])
    broadcast({"type": "batches", "batch": bid, "new": True})
    return {"batch": bid, "items": items, "folder": library.batch_dir(bid)}


def pick_folder(initial):
    """Nativní výběr složky na počítači s Pultem (macOS: Finder, Windows: dialog Průzkumníka)."""
    try:
        if config.IS_MAC:
            prompt = "Vyber složku pro Pult" if config.ui_lang() == "cs" else "Choose a folder for Pult"
            script = 'POSIX path of (choose folder with prompt "%s"%s)' % (prompt,
                (' default location (POSIX file "%s")' % initial.replace('"', "")) if initial and os.path.isdir(initial) else "")
            r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=600)
            return r.stdout.strip().rstrip("/") or None if r.returncode == 0 else None
        if config.IS_WIN:
            ps = ("[Console]::OutputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Windows.Forms;"
                  "$f=New-Object System.Windows.Forms.FolderBrowserDialog;$f.Description='" + ("Vyber složku pro Pult" if config.ui_lang() == "cs" else "Choose a folder for Pult") + "';"
                  "$f.ShowNewFolderButton=$true;if($f.ShowDialog() -eq 'OK'){$f.SelectedPath}")
            r = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", ps], capture_output=True, text=True,
                               encoding="utf-8", errors="replace", timeout=600, creationflags=library.NO_WINDOW)
            return r.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None
    return None


def reveal(path):
    if not os.path.exists(path):
        return False
    if config.IS_WIN:
        os.startfile(path)  # noqa: S606
    elif config.IS_MAC:
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])
    return True


def ai_meta(bid, n):
    """Nálezy AI metadat položky (spočítá se jednou a uloží k položce)."""
    b, _ = library.get_batch(bid)
    it = next((x for x in b.get("items", []) if x["n"] == n), None)
    if not it:
        return {"found": []}
    if isinstance(it.get("ai_meta"), list):
        return {"found": it["ai_meta"]}
    p, _ = item_file(bid, n)
    found = aimeta.scan(p) if p else []
    library.update_item(bid, n, ai_meta=found)
    return {"found": found}


def item_file(bid, n):
    """Původní soubor položky (když už neexistuje, aspoň připravené video nebo obrázek) a jméno pro stažení."""
    b, _ = library.get_batch(bid)
    it = next((x for x in b.get("items", []) if x["n"] == n), None)
    if not it:
        return None, None
    src = it.get("source") or ""
    real = os.path.realpath(src) if src else ""
    safe = bool(src) and os.path.isfile(real) and not real.startswith(os.path.realpath(config.config_dir()) + os.sep)
    if safe:
        try:
            with open(it["source"], "rb") as fh:
                fh.read(1)
            return it["source"], it.get("name") or os.path.basename(it["source"])
        except OSError:
            pass  # originál nejde otevřít (externí disk bez povolení): aspoň připravená verze
    if it.get("file"):
        d = library.batch_dir(bid)
        p = os.path.normpath(os.path.join(d, it["file"]))
        if p.startswith(d + os.sep) and os.path.isfile(p):
            return p, os.path.splitext(it.get("name") or "soubor")[0] + os.path.splitext(p)[1]
    return None, None


def copy_file(path):
    """Soubor do systémové schránky (jako ⌘C ve Finderu)."""
    try:
        if config.IS_MAC:
            # stejné typy jako ⌘C ve Finderu (public.file-url + NSFilenamesPboardType); NSURL přes ObjC se po skončení procesu ztratí
            r = subprocess.run(["osascript", "-e", "on run a", "-e", "set the clipboard to (POSIX file (item 1 of a))", "-e", "end run", path],
                               capture_output=True, timeout=10)
            return r.returncode == 0
        if config.IS_WIN:
            r = subprocess.run(["powershell", "-NoProfile", "-Command", "Set-Clipboard -LiteralPath $args[0]", path],
                               capture_output=True, timeout=15, creationflags=library.NO_WINDOW)
            return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        pass
    return False


def open_place(body):
    what = body.get("what")
    if what == "library":
        return reveal(library.root())
    if what == "inbox":
        os.makedirs(config.inbox(), exist_ok=True)
        return reveal(config.inbox())
    if what == "reviews":
        os.makedirs(library.revize(), exist_ok=True)
        return reveal(library.revize())
    if what == "batch":
        return reveal(library.batch_dir(str(body.get("id"))))
    if what == "source":
        b, _ = library.get_batch(str(body.get("id")))
        it = next((x for x in b.get("items", []) if x["n"] == int(body.get("n") or 0)), None)
        if not it:
            return False
        if config.IS_MAC and os.path.isfile(it["source"]):
            subprocess.Popen(["open", "-R", it["source"]])  # Finder s vybraným souborem
            return True
        return reveal(os.path.dirname(it["source"]))
    return False


def write_debug(ip, body):
    p = os.path.join(config.config_dir(), "debug.log")
    line = json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%S"), **body, "ip": ip}, ensure_ascii=False)[:20000]
    with log_lock:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        if os.path.exists(p) and os.path.getsize(p) > 3_000_000:
            os.replace(p, p + ".old")
        with open(p, "a", encoding="utf-8") as f:
            f.write(line + "\n")


# ---------- běh ----------
def emit(msg):
    broadcast(msg)
    if msg.get("type") == "item":
        broadcast({"type": "batches", "batch": msg.get("batch")})


def housekeeping():
    inbox = library.Inbox(emit)
    last_clean = 0
    waiting_before = set()
    while True:
        try:
            inbox.scan()
        except Exception as e:
            log("Vstup:", e)
        try:  # pult wait: Claude čeká na revizi dávky → ukázat v Pultu
            names = os.listdir(library.davky())
            now_waiting = {n for n in names if library.waiting(os.path.join(library.davky(), n))}
            for n in names:  # Claude pracuje / dopracoval: změna souboru = nový stav
                for f in (library.WORKING, "batch.json"):
                    try:
                        now_waiting.add((n, f, os.path.getmtime(os.path.join(library.davky(), n, f))))
                    except OSError:
                        pass
            if now_waiting != waiting_before:
                waiting_before = now_waiting
                broadcast({"type": "batches", "batch": None})
        except OSError:
            pass
        if time.time() - last_clean > 6 * 3600:
            last_clean = time.time()
            try:
                moved = library.cleanup(config.load().get("cleanup_days") or 0)
                if moved:
                    log("Úklid do koše:", ", ".join(moved))
                    broadcast({"type": "batches", "batch": None})
            except Exception as e:
                log("Úklid:", e)
        time.sleep(3)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = not config.IS_WIN  # na Windows by SO_REUSEADDR dovolil dva servery na jednom portu

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError, ssl.SSLError, socket.timeout)):
            return  # zavřená karta, uspaný iPad, nedůvěřovaný certifikát: běžné, do logu nepatří
        super().handle_error(request, client_address)


class TLSServer(Server):
    """Stejný Pult přes https (port o jedna vyšší), jen při sdílení v síti: kvůli mikrofonu na iPadu."""

    def __init__(self, addr, ctx):
        self.tls_ctx = ctx
        super().__init__(addr, Handler)

    def get_request(self):
        sock, addr = self.socket.accept()
        sock.settimeout(15)
        return self.tls_ctx.wrap_socket(sock, server_side=True, do_handshake_on_connect=False), addr


https = {"server": None, "port": None, "error": ""}


def https_port(cfg=None):
    return int((cfg or config.load()).get("port") or config.DEFAULT_PORT) + 1


def start_https(cfg):
    stop_https()
    if not cfg.get("share"):
        https["error"] = ""
        return
    try:
        addrs = lan_addresses()
        names = [a for a in addrs if not re.fullmatch(r"[\d.]+", a)] + ["localhost", socket.gethostname()]
        ips = [a for a in addrs if re.fullmatch(r"[\d.]+", a)] + ["127.0.0.1"]
        f = tls.ensure(names, ips)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        try:
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        except (AttributeError, ValueError):
            pass
        ctx.load_cert_chain(f["server.crt"], f["server.key"])
        port = https_port(cfg)
        if port_taken(port):
            raise OSError("port %d používá jiný program" % port)
        srv = TLSServer(("0.0.0.0", port), ctx)
        https.update(server=srv, port=port, error="")
        threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.5}, daemon=True).start()
        log("Zabezpečená adresa (mikrofon na iPadu): https://%s:%d" % ((names or ["localhost"])[0], port))
    except (OSError, RuntimeError, ssl.SSLError) as e:
        https.update(server=None, port=None, error=str(e))
        log("Https nejde spustit:", e)


def stop_https():
    srv = https["server"]
    https["server"] = None
    if srv:
        srv.shutdown()
        srv.server_close()


def https_info():
    cfg = config.load()
    if not https["server"]:
        return {"ready": False, "reason": https["error"] or ("Zapni sdílení v síti (Nastavení › Tým)." if not cfg.get("share") else "Spouští se…")}
    urls = ["https://%s:%d" % (a, https["port"]) for a in sorted(lan_addresses(), key=lambda a: not a.endswith(".local"))]
    return {"ready": True, "port": https["port"], "urls": ["%s/?k=%s" % (u, cfg.get("access_code")) for u in urls], "ca": "/pult-ca.crt"}


def port_taken(port):
    """Někdo už na portu poslouchá? macOS s SO_REUSEADDR jinak dovolí obsadit 127.0.0.1:port vedle
    jiného programu na 0.0.0.0:port a místní adresa by pak tiše vedla k Pultu místo k němu."""
    try:
        socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
        return True
    except OSError:
        return False


current = None
stopping = False


def restart_listener():
    if current:
        current.shutdown()


def write_pid():
    os.makedirs(config.config_dir(), exist_ok=True)
    library.save_json(os.path.join(config.config_dir(), "server.pid.json"), {"pid": os.getpid(), "started": library.now_iso()})


def main():
    global current
    if sys.stdout is None or sys.stderr is None:  # Windows pythonw: bez konzole, log do souboru
        os.makedirs(config.config_dir(), exist_ok=True)
        f = open(os.path.join(config.config_dir(), "server.log"), "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or f
        sys.stderr = sys.stderr or f
    for s in (sys.stdout, sys.stderr):  # Windows s anglickým systémem: čeština v logu nesmí shodit server
        if hasattr(s, "reconfigure"):
            try:
                s.reconfigure(encoding="utf-8", errors="replace")
            except (OSError, ValueError):
                pass
    library.ensure_dirs()
    write_pid()
    threading.Thread(target=library.worker, args=(emit,), daemon=True).start()
    threading.Thread(target=housekeeping, daemon=True).start()
    library.requeue_unfinished()
    dictation.start(broadcast)
    if not config.tool("ffmpeg"):
        log("Upozornění: ffmpeg nenalezen, videa se nepřipraví (pult doctor).")
    good = None
    while not stopping:
        cfg = config.load()
        host = "0.0.0.0" if cfg.get("share") else "127.0.0.1"
        try:
            if port_taken(int(cfg.get("port") or config.DEFAULT_PORT)):
                raise OSError("port už používá jiný program")
            current = Server((host, int(cfg.get("port") or config.DEFAULT_PORT)), Handler)
        except OSError as e:
            if good:  # nový port nebo sdílení nejde nastavit: zpátky na to, co fungovalo
                log("Port %s nejde použít (%s), vracím %s." % (cfg.get("port"), e, good[1]))
                config.update({"port": good[1], "share": good[0] == "0.0.0.0"})
                continue
            log("Port %s je obsazený (%s). Neběží už Pult? (pult doctor)" % (cfg.get("port"), e))
            sys.exit(0)  # launchd ani Windows to pak dokola nezkouší; běžící Pult stačí jeden
        good = (host, int(cfg.get("port") or config.DEFAULT_PORT))
        log("Pult %s běží: http://localhost:%d (%s), knihovna %s" % (
            config.VERSION, cfg.get("port"), "sdíleno v síti" if cfg.get("share") else "jen tento počítač", library.root()))
        start_https(cfg)
        current.serve_forever(poll_interval=0.5)
        current.server_close()
        stop_https()
        with hub_lock:  # živá spojení zavřít, klienti se sami připojí znovu (už podle nového nastavení)
            for q in clients.values():
                q.put(None)


if __name__ == "__main__":
    main()
