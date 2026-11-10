#!/usr/bin/env python3
"""Pult z příkazové řádky (pro Clauda i lidi).

  pult add [-t NÁZEV] [--copy] [--wait] SOUBORY_NEBO_SLOŽKY…   nová dávka na pult
  pult add --to DÁVKA SOUBORY…                                  přidat do existující dávky
  pult status [--json]                                          server, nové revize, rozpracované dávky
  pult reviews [--json] [--all]                                 revize k zpracování (cesty k revize.md)
  pult archive SLOŽKA_REVIZE|all                                revize je zpracovaná (přesun do archivu)
  pult open | url | doctor | start | stop | restart | reload | version
  pult settings [KLÍČ HODNOTA]                                  zobrazit / změnit nastavení
"""
import argparse
import json
import shutil
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402
import library  # noqa: E402
import dictation  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):  # Windows konzole: čeština bez otazníků
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except (OSError, ValueError):
        pass


def base():
    return "http://127.0.0.1:%d" % int(config.load().get("port") or config.DEFAULT_PORT)


def api(method, path, body=None, timeout=10):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base() + path, data=data, method=method,
                                 headers={"Content-Type": "application/json", "Host": "localhost"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


def server_up():
    try:
        return api("GET", "/api/status", timeout=2)
    except (OSError, ValueError):
        return None


def out(obj, as_json):
    if as_json:
        print(json.dumps(obj, ensure_ascii=False, indent=1))
    return as_json


# ---------- služba (automatické spouštění) ----------
LABEL = "cz.pult.server"


def service():
    return library.load_json(os.path.join(config.config_dir(), "service.json"), {})


def start_server(wait=8):
    if server_up():
        return True
    svc = service()
    py = svc.get("python") or sys.executable
    srv = svc.get("server") or os.path.join(config.APP_DIR, "server.py")
    if config.IS_MAC and svc.get("plist") and os.path.isfile(svc["plist"]):
        uid = os.getuid()
        subprocess.run(["launchctl", "bootstrap", "gui/%d" % uid, svc["plist"]], capture_output=True)
        subprocess.run(["launchctl", "kickstart", "gui/%d/%s" % (uid, LABEL)], capture_output=True)
    else:
        logf = open(os.path.join(config.config_dir(), "server.log"), "ab")
        kw = {}
        if config.IS_WIN:
            pyw = py.replace("python.exe", "pythonw.exe")
            py = pyw if os.path.isfile(pyw) else py
            kw["creationflags"] = 0x00000008 | 0x00000200 | 0x08000000  # bez okna, odpojeně
        else:
            kw["start_new_session"] = True
        subprocess.Popen([py, srv], stdout=logf, stderr=logf, stdin=subprocess.DEVNULL, close_fds=True, **kw)
    for _ in range(int(wait * 5)):
        time.sleep(0.2)
        if server_up():
            return True
    return False


def stop_server():
    svc = service()
    if config.IS_MAC and svc.get("plist"):
        subprocess.run(["launchctl", "bootout", "gui/%d/%s" % (os.getuid(), LABEL)], capture_output=True)
    pid = library.load_json(os.path.join(config.config_dir(), "server.pid.json"), {}).get("pid")
    if pid:
        try:
            if config.IS_WIN:
                subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, creationflags=library.NO_WINDOW)
            else:
                os.kill(int(pid), 15)
        except (OSError, ValueError):
            pass
    for _ in range(25):
        if not server_up():
            return True
        time.sleep(0.2)
    return not server_up()


# ---------- příkazy ----------
def cmd_add(a):
    files = library.collect(a.files)
    if not files:
        sys.exit("No supported files (images: jpg png webp gif avif heic tif, videos: mp4 mov webm mkv …).")
    body = {"title": a.title, "files": files, "batch": a.to, "origin": origin(), "notes": note_args(a)}
    if a.copy:
        body["copy"] = True
    if server_up() or start_server():
        files = stage_unreadable(files)
        body["files"] = files
        r = api("POST", "/api/add", body, timeout=120)
        bid = r["batch"]
        if a.wait:
            t0 = time.time()
            while time.time() - t0 < a.wait_max:
                b = api("GET", "/api/batch/" + bid)["batch"]
                if all(it.get("state") in ("ready", "error") for it in b["items"]):
                    break
                time.sleep(1)
    else:  # server nejde spustit: připravit přímo tady
        bid = a.to or library.create_batch(a.title or os.path.splitext(os.path.basename(files[0]))[0], origin())
        library.add_items(bid, files, copy=a.copy)
        if body["notes"]:
            library.set_agent_notes(bid, body["notes"])
        while not library.jobs.empty():
            library.prepare(*library.jobs.get(), emit=lambda m: None)
    replaced, kept = [], []
    for old in a.replaces or []:
        if old == bid:
            continue
        r = dismiss_one(old, "replaced by %s" % (a.title or bid), bid)
        if r.get("ok"):
            replaced.append(old)
        else:
            kept.append({"batch": old, "reason": r.get("reason")})
    b, _ = library.get_batch(bid)
    res = {"batch": bid, "title": b["title"], "count": len(b["items"]), "folder": library.batch_dir(bid),
           "url": base().replace("127.0.0.1", "localhost") + "/#" + bid,
           "items": [{"n": it["n"], "kind": it["kind"], "name": it["name"], "state": it.get("state"),
                      "error": it.get("error")} for it in b["items"]],
           "next": "Run `pult wait %s` in the background (Claude Code: Bash with run_in_background): when the user sends "
                   "the review in Pult, the command exits and prints it, so it lands straight in this chat." % bid}
    if replaced:
        res["replaced"] = replaced
    if kept:
        res["not_replaced"] = kept
    print(json.dumps(res, ensure_ascii=False, indent=1))


def dismiss_one(bid, note="", replaced_by=None):
    """Odklidí dávku (přes server, ať to Pult hned ukáže). Vrací {"ok", "title", "reason"…}."""
    if server_up():
        try:
            return api("POST", "/api/batch/%s/dismiss" % urllib.parse.quote(bid), {"note": note, "replaced_by": replaced_by})
        except urllib.error.HTTPError as e:
            return {"ok": False, "reason": "batch not found" if e.code == 404 else "server error %d" % e.code}
    try:
        return library.dismiss_settled(bid, note)
    except (OSError, ValueError):
        return {"ok": False, "reason": "batch not found"}


def cmd_dismiss(a):
    failed = False
    for bid in a.batch:
        if a.undo:
            try:
                if server_up():
                    api("POST", "/api/batch/%s/status" % urllib.parse.quote(bid), {"status": "open", "from": "cli"})
                else:
                    library.set_status(bid, "open")
                print("Back in Pult: %s" % bid)
            except (OSError, ValueError):
                failed = True
                print("Not changed: %s (batch not found)" % bid, file=sys.stderr)
            continue
        r = dismiss_one(bid, a.message or "")
        if r.get("ok"):
            print("Removed from To review: %s (it can be restored: pult dismiss --undo %s)" % (r.get("title") or bid, bid))
        else:
            failed = True
            print("Not removed: %s, %s. Leave it to the user." % (r.get("title") or bid, r.get("reason")), file=sys.stderr)
    if failed:
        sys.exit(1)


def stage_unreadable(files):
    """macOS občas nepustí server Pultu (LaunchAgent) na externí disk, i když má povolení.
    Co server nepřečte, zkopíruje tenhle příkaz (běží v Claude, které přístup má) do knihovny."""
    try:
        bad = set(api("POST", "/api/can-read", {"paths": files}, timeout=60).get("unreadable") or [])
    except Exception:
        return files
    if not bad:
        return files
    dest = os.path.join(library.root(), "prenos", time.strftime("%Y-%m-%d_%H%M%S"))
    os.makedirs(dest, exist_ok=True)
    out = []
    for f in files:
        if f in bad:
            t = os.path.join(dest, os.path.basename(f))
            i = 2
            while os.path.exists(t):
                b, e = os.path.splitext(os.path.basename(f))
                t = os.path.join(dest, "%s (%d)%s" % (b, i, e))
                i += 1
            shutil.copy2(f, t)
            out.append(t)
        else:
            out.append(f)
    print("Pult cannot read %d files on an external drive, copied them to %s" % (len(bad), dest), file=sys.stderr)
    return out


def note_args(a):
    """-m "k celé dávce" a --item-note "2: k položce #02" → {"0": …, "2": …}"""
    notes = {}
    if getattr(a, "message", None):
        notes["0"] = a.message
    for x in getattr(a, "item_note", None) or []:
        n, sep, text = x.partition(":")
        if not sep or not n.strip().lstrip("#").isdigit():
            sys.exit("--item-note expects \"NUMBER: text\", e.g. --item-note \"2: shorter ending\"")
        notes[str(int(n.strip().lstrip("#")))] = text.strip()
    return notes


def cmd_note(a):
    """Poznámka od Clauda k existující dávce (bez -i k celé dávce); prázdný text ji smaže."""
    notes = {str(a.item or 0): a.text}
    if server_up():
        r = api("POST", "/api/batch/%s/agent-notes" % a.batch, {"notes": notes})["notes"]
    else:
        r = library.set_agent_notes(a.batch, notes)
    print(json.dumps({"batch": a.batch, "notes": r}, ensure_ascii=False, indent=1))


def origin():
    """Odkud dávka přišla: chat Claude Code (aby revize došla zpátky do něj)."""
    o = {"session": os.environ.get("CLAUDE_CODE_SESSION_ID"), "host_session": os.environ.get("CLAUDE_CODE_HOST_SESSION_ID"),
         "cwd": os.getcwd() if os.environ.get("CLAUDECODE") else None}
    return {k: v for k, v in o.items() if v} or None


def cmd_dictation(a):
    """Diktování: stav, instalace přepisu řeči (Whisper large-v3-turbo) nebo použití existujícího prostředí."""
    if a.action == "install":
        import platform  # noqa: PLC0415
        venv = os.path.join(config.config_dir(), "asr")
        mac_arm = sys.platform == "darwin" and platform.machine() == "arm64"
        base_py = a.python or newer_python() or sys.executable
        pkg = "mlx-whisper" if mac_arm else "faster-whisper"
        print("Installing speech-to-text (%s) into %s…" % (pkg, venv), flush=True)
        if subprocess.run([base_py, "-m", "venv", venv]).returncode != 0:
            sys.exit("Could not create a Python environment (python -m venv).")
        vpy = os.path.join(venv, "Scripts", "python.exe") if config.IS_WIN else os.path.join(venv, "bin", "python")
        subprocess.run([vpy, "-m", "pip", "install", "-q", "--upgrade", "pip"])
        if subprocess.run([vpy, "-m", "pip", "install", "-q", pkg]).returncode != 0:
            sys.exit("Installing %s failed (needs internet; on Windows Python 3.9 to 3.13)." % pkg)
        asr = os.path.join(os.path.dirname(os.path.abspath(__file__)), "asr.py")
        if mac_arm:  # detektor řeči: bez něj si Whisper v tichu vymýšlí věty (faster-whisper má vlastní)
            subprocess.run([vpy, "-m", "pip", "install", "-q", "silero-vad"])
        if mac_arm and subprocess.run([vpy, "-m", "pip", "install", "-q", "parakeet-mlx"]).returncode == 0:
            print("Downloading NVIDIA Parakeet v3 (second model to choose from)…", flush=True)
            subprocess.run([vpy, asr, "--download", "--model", "parakeet-v3"])
        print("Downloading the Whisper large-v3 model (about 3 GB, only the first time)…", flush=True)
        if subprocess.run([vpy, asr, "--download", "--model", "whisper-large" if mac_arm else "whisper-turbo"]).returncode != 0:
            sys.exit("Could not download the model.")
        config.update({"asr_python": "", "dictation": True})
    elif a.action == "model":
        if a.python not in ("whisper-large", "whisper-turbo", "parakeet-v3", "elevenlabs"):
            sys.exit("Model: whisper-large, whisper-turbo, parakeet-v3 nebo elevenlabs (pult dictation model whisper-large)")
        config.update({"asr_model": a.python})
    elif a.action == "key":
        # klíč se nikdy nepíše do příkazové řádky: zadá ho člověk (skrytě) nebo přijde na standardní vstup
        import getpass  # noqa: PLC0415
        key = getpass.getpass("ElevenLabs API key: ") if sys.stdin.isatty() else sys.stdin.readline()
        try:
            print("✓ Key verified and saved: %s" % dictation.save_el_key(key))
        except (ValueError, RuntimeError, OSError) as e:
            sys.exit("✗ %s" % e)
        config.update({"asr_model": "elevenlabs"})
    elif a.action == "use":
        if not a.python or not os.path.isfile(a.python):
            sys.exit("Give the path to a Python with mlx-whisper or faster-whisper installed: pult dictation use /path/python")
        config.update({"asr_python": os.path.abspath(a.python), "dictation": True})
    elif a.action in ("on", "off"):
        config.update({"dictation": a.action == "on"})
    st = dictation.status(force=True)
    if server_up():
        try:
            api("POST", "/api/command", {"cmd": "reload"})  # prohlížeče si načtou nový stav
        except OSError:
            pass
    if out(st, a.json):
        return
    print(("✓ Dictation ready: %s · %s%s" % (st["engine"], st["model"], " (the model downloads on first use)" if st.get("cached") is False else ""))
          if st["ready"] else "✗ Dictation not ready: %s" % st["reason"])


def newer_python():
    """Python 3.10+ pro prostředí s přepisem (NVIDIA Parakeet starší nebere); systémový macOS má jen 3.9."""
    import shutil  # noqa: PLC0415
    if sys.version_info >= (3, 10):
        return sys.executable
    for v in ("3.13", "3.12", "3.11", "3.10"):
        for p in (shutil.which("python" + v), "/opt/homebrew/bin/python" + v, "/usr/local/bin/python" + v,
                  "/Library/Frameworks/Python.framework/Versions/%s/bin/python%s" % (v, v)):
            if p and os.path.isfile(p):
                return p
    return None


def cmd_wait(a):
    """Čeká, až uživatel odešle revizi dávky, a vypíše ji (Claude to pouští na pozadí → revize přijde do chatu)."""
    bid = a.batch
    d = library.batch_dir(bid)
    if not os.path.isdir(d):
        sys.exit("Batch %s does not exist." % bid)
    seen = {r["name"] for r in library.reviews(include_archived=True) if r.get("batch") == bid}
    mark = os.path.join(d, library.WAITING)
    t0 = time.time()
    last = 0
    try:
        while True:
            if time.time() - last > 15:  # značka pro Pult: „Claude čeká na revizi“
                library.save_json(mark, {"pid": os.getpid(), "since": library.now_iso(), "origin": origin()})
                last = time.time()
            new = [r for r in library.reviews(include_archived=True) if r.get("batch") == bid and r["name"] not in seen]
            if new:
                r = new[-1]
                library.set_working(bid, r["name"])  # Pult ukáže „Claude pracuje“
                print("New review in Pult: %s (%s)\nFolder: %s\n" % (r["title"], r.get("by") or "", r["folder"]))
                try:
                    with open(r["md"], encoding="utf-8") as f:
                        print(f.read())
                except OSError:
                    pass
                print("The frame images with drawings are in the review folder.\n"
                      "Pult now shows the user that you are working. Post short updates (one sentence): pult progress %s \"…\"\n"
                      "When done: pult archive \"%s\" -m \"what is done\"" % (bid, r["folder"]))
                return
            b = library.load_json(os.path.join(d, "batch.json"), {})
            if b.get("status") == "dismissed":
                print("Batch %s was removed from Pult, no review will come." % bid)
                sys.exit(2)
            if a.timeout and time.time() - t0 > a.timeout * 3600:
                print("No review within %g h. When the user sends it, find it with: pult status" % a.timeout)
                sys.exit(3)
            time.sleep(2)
    finally:
        try:
            os.remove(mark)
        except OSError:
            pass


def notes_cs(n):
    return "%d %s" % (n, "note" if n == 1 else "notes")


def ago(iso):
    try:
        from datetime import datetime
        s = (datetime.now() - datetime.fromisoformat(iso)).total_seconds()
    except (TypeError, ValueError):
        return "?"
    if s < 90:
        return "%d s ago" % s
    if s < 5400:
        return "%d min ago" % (s // 60)
    if s < 129600:
        return "%.1f h ago" % (s / 3600)
    return "%d days ago" % (s // 86400)


def cmd_status(a):
    srv = server_up()
    revs = library.reviews()
    allrev = library.reviews(include_archived=True)
    batches = library.list_batches()
    open_b = [b for b in batches if b["status"] == "open"]
    unsent = [b for b in open_b if b["unsent"]]
    res = {"server": bool(srv), "server_info": srv, "library": library.root(), "new_reviews": revs,
           "last_review": allrev[-1] if allrev else None,
           "open_batches": [{"id": b["id"], "title": b["title"], "count": b["count"], "created": b["created"],
                             "drawings": b["drawings"], "comments": b["comments"], "unsent": b["unsent"]} for b in open_b]}
    if out(res, a.json):
        return
    print("Server: %s" % (("running, version %s, connected: %s" % (srv["version"], ", ".join(srv["clients"]) or "nobody")) if srv else "NOT RUNNING (pult start)"))
    if revs:
        print("New reviews (%d):" % len(revs))
        for r in revs:
            print("  %s · %s · %s · %s\n    %s" % (r["title"], r.get("by") or "", notes_cs(r["notes"]), ago(r["submitted"]), r["md"]))
    else:
        lr = res["last_review"]
        print("New reviews: none." + (" Last: %s (%s)." % (lr["title"], ago(lr["submitted"])) if lr else ""))
    for b in unsent:
        print("In progress (not sent): %s · %d drawings, %d comments" % (b["title"], b["drawings"], b["comments"]))
    print("Open batches: %d · library %s" % (len(open_b), library.root()))


def cmd_reviews(a):
    revs = library.reviews(include_archived=a.all)
    if out({"reviews": revs}, a.json):
        return
    if not revs:
        print("No new reviews.")
    for r in revs:
        print("%s%s · %s · %s\n  %s" % ("[archiv] " if r["archived"] else "", r["title"], r["submitted"], notes_cs(r["notes"]), r["md"]))


def batch_of(target):
    """ID dávky z ID dávky nebo ze složky revize."""
    if library.safe_id(target) and os.path.isdir(library.batch_dir(target)):
        return target
    for base in (target, os.path.join(library.revize(), os.path.basename(os.path.normpath(target))),
                 os.path.join(library.archiv(), os.path.basename(os.path.normpath(target)))):
        r = library.load_json(os.path.join(base, "revize.json"), None)
        if isinstance(r, dict) and r.get("batch"):
            return r["batch"]
    sys.exit("Batch %s not found." % target)


def cmd_progress(a):
    """Krátká zpráva do Pultu, na čem Claude právě pracuje (prázdný text = jen „pracuje“)."""
    bid = batch_of(a.target)
    if a.done:
        library.finish_working(bid, a.text)
    else:
        library.set_progress(bid, a.text)
    print(json.dumps({"batch": bid, "working": library.working(bid), "done": bool(a.done)}, ensure_ascii=False))


def cmd_archive(a):
    done = library.archive_review(a.target, a.message or "")
    print("Archived: %s" % (", ".join(done) if done else "nothing (review not found)"))


def cmd_settings(a):
    if a.key:
        if a.value is None:
            sys.exit("Missing value: pult settings %s VALUE" % a.key)
        if a.key not in config.DEFAULTS:
            sys.exit("Unknown setting. Keys: %s" % ", ".join(config.DEFAULTS))
        val = a.value
        if isinstance(config.DEFAULTS[a.key], bool):
            val = a.value.lower() in ("1", "true", "ano", "yes", "on")
        if server_up():
            api("POST", "/api/settings", {"settings": {a.key: val}})
        else:
            config.update({a.key: val})
    cfg = config.load()
    cfg["library"] = library.root()
    cfg["inbox"] = config.inbox(cfg)
    print(json.dumps(cfg, ensure_ascii=False, indent=1))


def git(src, *args, timeout=180):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")  # soukromé repo bez přihlášení: chyba, ne viset na hesle
    return subprocess.run(["git", "-C", src] + list(args), capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=timeout, env=env)


def update_stop(text, code=3):
    print(text, file=sys.stderr)
    sys.exit(code)


def source_version(src):
    try:
        with open(os.path.join(src, "pult", "config.py"), encoding="utf-8") as f:
            for line in f:
                if line.startswith("VERSION = "):
                    return line.split('"')[1]
    except (OSError, IndexError):
        pass
    return ""


def cmd_update(a):
    """Nová verze Pultu z repozitáře, odkud byl nainstalovaný. Knihovna a nastavení zůstávají, cizí úpravy se nepřepíšou."""
    is_src = lambda p: p and os.path.isfile(os.path.join(p, "install.py")) and os.path.isfile(os.path.join(p, "pult", "server.py"))
    src = next((p for p in [a.source and os.path.abspath(os.path.expanduser(a.source)), service().get("source"),
                            os.path.expanduser("~/pult-source")] if is_src(p)), None)
    if not src:
        update_stop("Cannot find the folder Pult was installed from. Run: pult update --from FOLDER", 1)
    if not shutil.which("git"):
        update_stop("git is not installed, so Pult cannot update itself.", 1)
    if not os.path.exists(os.path.join(src, ".git")):
        update_stop("%s is not a git clone (installed from a zip?). Download the new version and run install.py again." % src, 1)
    dirty = git(src, "status", "--porcelain", "--untracked-files=no").stdout.strip()
    if dirty:
        update_stop("Not updated: %s has local changes. They were left untouched:\n%s" % (src, dirty))
    if git(src, "symbolic-ref", "-q", "HEAD").returncode:
        update_stop("Not updated: %s is not on a branch." % src)
    r = git(src, "fetch", "--quiet")
    if r.returncode:
        update_stop("Could not download the new version (no internet, or no access to the repository):\n%s" % r.stderr.strip()[-400:], 1)
    new = git(src, "rev-parse", "@{u}").stdout.strip()
    if not new:
        update_stop("Not updated: the branch in %s does not follow any repository." % src)
    old = git(src, "rev-parse", "HEAD").stdout.strip()
    base = git(src, "merge-base", "HEAD", "@{u}")
    log = ""
    if base.returncode:  # repozitář má přepsanou historii: staré commity zůstanou v záložní větvi
        if not a.accept_rewritten_history:  # přepsaná historie je zároveň to, jak by vypadala podvržená verze
            update_stop("Not updated: the repository history was rewritten, so this download cannot be compared with the version you have.\n"
                        "Check the repository first: %s\nIf you trust it, run: pult update --accept-rewritten-history"
                        % git(src, "remote", "get-url", "origin").stdout.strip())
        backup = "before-update-" + time.strftime("%Y%m%d-%H%M%S")
        git(src, "branch", backup)
        if git(src, "reset", "--hard", "@{u}").returncode:
            update_stop("Not updated: could not switch %s to the new version." % src, 1)
        print("The repository history was rewritten; your previous state is kept in branch %s." % backup)
    elif old != new and base.stdout.strip() == old:
        log = git(src, "log", "--format=- %s", "-15", "%s..%s" % (old, new)).stdout.strip()
        r = git(src, "merge", "--ff-only", "--quiet", "@{u}")
        if r.returncode:
            update_stop("Not updated: %s" % r.stderr.strip()[-400:], 1)
    elif old != new and base.stdout.strip() != new:
        update_stop("Not updated: %s has its own commits that differ from the repository. They were left untouched." % src)
    head = git(src, "rev-parse", "HEAD").stdout.strip()
    target = source_version(src)
    pending = os.path.join(config.config_dir(), "update-pending")  # stažené, ale instalace nedoběhla: příště znovu
    if head == old and target == config.VERSION and not os.path.exists(pending):
        print("Pult is up to date (%s)." % config.VERSION)
        return
    with open(pending, "w", encoding="utf-8") as f:
        f.write(head)
    r = subprocess.run([sys.executable, os.path.join(src, "install.py"), "--no-open"], cwd=src, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=900)
    if r.returncode:
        update_stop("The new version was downloaded, but the install failed:\n%s" % ((r.stderr or r.stdout).strip()[-800:]), 1)
    os.remove(pending)
    print("Pult updated to %s. The library and settings are unchanged." % (target or head[:7])
          if target == config.VERSION else
          "Pult updated: %s -> %s. The library and settings are unchanged." % (config.VERSION, target or head[:7]))
    if log:
        print("What changed:\n%s" % log)


def cmd_url(a):
    cfg = config.load()
    print("On this computer: http://localhost:%d" % cfg["port"])
    if not cfg.get("share"):
        print("Network sharing is off (turn it on in Settings › Team or: pult settings share true).")
        return
    try:
        v = api("GET", "/api/settings")
        for u in v.get("invite") or []:
            print("Pro kolegy: %s" % u)
        print("Access code: %s" % cfg.get("access_code"))
    except OSError:
        print("Server is not running.")


def cmd_doctor(a):
    ok = True

    def line(good, text, fix=""):
        nonlocal ok
        ok = ok and good
        print(("✓ " if good else "✗ ") + text + (("\n    → " + fix) if (fix and not good) else ""))
    line(sys.version_info >= (3, 9), "Python %s" % sys.version.split()[0], "Needs Python 3.9 or newer.")
    ff, fp = config.tool("ffmpeg"), config.tool("ffprobe")
    line(bool(ff), "ffmpeg: %s" % (ff or "not found"), "macOS: brew install ffmpeg · Windows: winget install Gyan.FFmpeg")
    line(bool(fp), "ffprobe: %s" % (fp or "not found"), "Comes with ffmpeg.")
    if ff:
        r = library.run([ff, "-hide_banner", "-encoders"], timeout=20)
        line("libx264" in (r.stdout or ""), "ffmpeg can encode H.264 (libx264)", "Install a full ffmpeg build (brew / Gyan.FFmpeg).")
    lib = library.root()
    try:
        os.makedirs(lib, exist_ok=True)
        test = os.path.join(lib, ".zapis-test")
        open(test, "w").close()
        os.remove(test)
        line(True, "Library: %s" % lib)
    except OSError as e:
        line(False, "Library %s: %s" % (lib, e), "Choose another folder: pult settings library PATH")
    srv = server_up()
    line(bool(srv), "Server: %s" % (("running at %s" % base()) if srv else "not running"), "pult start")
    svc = service()
    again = "%s install.py" % ("py" if config.IS_WIN else "python3")
    line(bool(svc), "Starts at login: %s" % ("yes" if svc else "no"), "Run the installer again: " + again)
    if config.IS_MAC:
        line(bool(config.native_app()), "Native app: %s" % ("yes" if config.native_app() else "no"), "xcode-select --install, then run the installer again: " + again)
    print("\nEverything is OK." if ok else "\nSomething is missing, see above.")
    sys.exit(0 if ok else 1)


def cmd_open(a):
    if not server_up():
        start_server()
    if config.native_app():
        subprocess.run(["open", config.native_app()])  # na Macu vždy nativní aplikace, ne prohlížeč
        return
    webbrowser.open(base().replace("127.0.0.1", "localhost") + "/")


def cmd_reload(a):
    try:
        api("POST", "/api/command", {"cmd": "reload"})
        print("Sent")
    except OSError:
        print("Server is not running")


def main():
    p = argparse.ArgumentParser(prog="pult", description="Pult: image and video review (drawing, comments, team).")
    sub = p.add_subparsers(dest="cmd")
    pa = sub.add_parser("add", help="new batch in Pult")
    pa.add_argument("files", nargs="+")
    pa.add_argument("-t", "--title")
    pa.add_argument("--to", help="add to an existing batch (id)")
    pa.add_argument("--copy", action="store_true", help="copy the originals into the library")
    pa.add_argument("-m", "--message", help="short key note for the whole batch (the user sees it in Pult)")
    pa.add_argument("--item-note", action="append", metavar="N: TEXT", help="note for item #N (repeatable)")
    pa.add_argument("--replaces", action="append", metavar="BATCH", help="this is a new version of BATCH: remove the old batch if nobody reviewed it (repeatable)")
    pa.add_argument("--wait", action="store_true", help="wait until previews are ready")
    pa.add_argument("--wait-max", type=int, default=900)
    pa.set_defaults(fn=cmd_add)
    pn = sub.add_parser("note", help="your note for a batch (or with -i for an item); empty text deletes it")
    pn.add_argument("batch")
    pn.add_argument("text")
    pn.add_argument("-i", "--item", type=int, help="item number (#N)")
    pn.set_defaults(fn=cmd_note)
    pu = sub.add_parser("update", help="update Pult to the newest version (keeps the library and settings)")
    pu.add_argument("--from", dest="source", metavar="FOLDER", help="the git clone Pult was installed from, if it cannot be found")
    pu.add_argument("--accept-rewritten-history", action="store_true", help="install even though the repository history was rewritten (check the repository first)")
    pu.set_defaults(fn=cmd_update)
    px = sub.add_parser("dismiss", help="remove batches that were settled in the chat (refuses batches with someone's notes)")
    px.add_argument("batch", nargs="+")
    px.add_argument("-m", "--message", help="why, in a few words (the user sees it in Pult)")
    px.add_argument("--undo", action="store_true", help="put the batch back in To review")
    px.set_defaults(fn=cmd_dismiss)
    pd = sub.add_parser("dictation", help="microphone dictation: status | install | use PYTHON | model whisper-large|whisper-turbo|parakeet-v3|elevenlabs | key | on | off")
    pd.add_argument("action", nargs="?", default="status", choices=["status", "install", "use", "model", "key", "on", "off"])
    pd.add_argument("python", nargs="?")
    pd.add_argument("--json", action="store_true")
    pd.set_defaults(fn=cmd_dictation)
    pw = sub.add_parser("wait", help="wait for the batch review (run it in the background)")
    pw.add_argument("batch")
    pw.add_argument("--timeout", type=float, default=0, help="max hours (0 = no limit)")
    pw.set_defaults(fn=cmd_wait)
    ps = sub.add_parser("status", help="server and review status")
    ps.add_argument("--json", action="store_true")
    ps.set_defaults(fn=cmd_status)
    pr = sub.add_parser("reviews", help="new reviews")
    pr.add_argument("--json", action="store_true")
    pr.add_argument("--all", action="store_true", help="include archived")
    pr.set_defaults(fn=cmd_reviews)
    pv = sub.add_parser("archive", help="review handled (move to archive)")
    pv.add_argument("target")
    pv.add_argument("-m", "--message", help="briefly what is done (the user sees it in Pult)")
    pv.set_defaults(fn=cmd_archive)
    pg = sub.add_parser("progress", help="what you are working on right now (shown in Pult at the batch)")
    pg.add_argument("target", help="batch ID or review folder")
    pg.add_argument("text", nargs="?", default="")
    pg.add_argument("--done", action="store_true", help="hotovo (bez archivace revize)")
    pg.set_defaults(fn=cmd_progress)
    pst = sub.add_parser("settings", help="settings")
    pst.add_argument("key", nargs="?")
    pst.add_argument("value", nargs="?")
    pst.set_defaults(fn=cmd_settings)
    for name, fn, hlp in (("url", cmd_url, "adresy pro kolegy"), ("doctor", cmd_doctor, "kontrola instalace"),
                          ("open", cmd_open, "open Pult"), ("reload", cmd_reload, "reload Pult on all devices"),
                          ("start", lambda a: print("Running" if start_server() else "Could not start the server (pult doctor)."), "start the server"),
                          ("stop", lambda a: print("Stopped" if stop_server() else "Could not stop"), "stop the server"),
                          ("restart", lambda a: print("Running" if (stop_server() or True) and start_server() else "Failed"), "restart the server"),
                          ("version", lambda a: print("Pult %s" % config.VERSION), "verze")):
        sp = sub.add_parser(name, help=hlp)
        sp.set_defaults(fn=fn)
    a = p.parse_args()
    if not getattr(a, "fn", None):
        p.print_help()
        return
    a.fn(a)


if __name__ == "__main__":
    main()
