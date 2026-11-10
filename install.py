#!/usr/bin/env python3
"""Instalace Pultu (macOS i Windows). Spouští ji Claude podle INSTALL.md, nebo člověk:

  macOS:    python3 install.py
  Windows:  py install.py

Volby: --port 7858, --library CESTA, --no-open, --no-claude, --agent-instructions, --no-agent-instructions, --install-ffmpeg, --uninstall [--purge]
Instalace je opakovatelná: novější verze přepíše aplikaci, nastavení a knihovna zůstanou.
"""
import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "pult")
sys.path.insert(0, SRC)
import config  # noqa: E402

IS_WIN, IS_MAC = config.IS_WIN, config.IS_MAC
LABEL = "cz.pult.server"
HOME = os.path.expanduser("~")
NO_WINDOW = 0x08000000 if IS_WIN else 0

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (OSError, ValueError):
        pass


def say(msg):
    print(msg, flush=True)


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, errors="replace", creationflags=NO_WINDOW, **kw)


def app_dir():
    if IS_WIN:
        return os.path.join(os.environ.get("LOCALAPPDATA", os.path.join(HOME, "AppData", "Local")), "Pult", "app")
    if IS_MAC:
        return os.path.join(HOME, "Library", "Application Support", "Pult", "app")
    return os.path.join(HOME, ".local", "share", "pult", "app")


def bin_dir():
    if IS_WIN:
        return os.path.join(os.environ.get("LOCALAPPDATA", os.path.join(HOME, "AppData", "Local")), "Pult", "bin")
    return os.path.join(HOME, ".local", "bin")


def python_exe(windowless=False):
    py = sys.executable
    if sys.prefix != getattr(sys, "base_prefix", sys.prefix):
        # spuštěno z virtuálního prostředí (venv cizího nástroje): služba nesmí záviset na něm, vezmeme základní Python
        base = getattr(sys, "_base_executable", "") or ""
        cands = [base] if base and not base.startswith(sys.prefix) else []
        cands += [os.path.join(sys.base_prefix, "bin", "python3"), os.path.join(sys.base_prefix, "python.exe")]
        if IS_MAC:
            cands += ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
        for c in cands:
            if c and os.path.isfile(c):
                py = c
                break
    if IS_MAC:
        # stálá cesta: verzovaná cesta Homebrew (python@3.x) nebo Command Line Tools by po aktualizaci zmizela
        if py.startswith(("/Library/Developer/CommandLineTools/", "/Applications/Xcode")) and os.path.isfile("/usr/bin/python3"):
            return "/usr/bin/python3"
        for prefix in ("/opt/homebrew", "/usr/local"):
            if py.startswith(prefix + "/") and os.path.isfile(prefix + "/bin/python3"):
                return prefix + "/bin/python3"
    if IS_WIN and windowless:
        pyw = os.path.join(os.path.dirname(py), "pythonw.exe")
        if os.path.isfile(pyw):
            return pyw
    return py


def server_up(port, wait=0):
    t0 = time.time()
    while True:
        try:
            req = urllib.request.Request("http://127.0.0.1:%d/api/status" % port, headers={"Host": "localhost"})
            with urllib.request.urlopen(req, timeout=2) as r:
                return json.loads(r.read().decode("utf-8"))
        except (OSError, ValueError):
            if time.time() - t0 >= wait:
                return None
            time.sleep(0.4)


# ---------- služba (spuštění po přihlášení) ----------
def plist_path():
    return os.path.join(HOME, "Library", "LaunchAgents", LABEL + ".plist")


def startup_vbs():
    return os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Pult.vbs")


def stop_service(port):
    if IS_MAC:
        run(["launchctl", "bootout", "gui/%d/%s" % (os.getuid(), LABEL)])
    pid = (load_json(os.path.join(config.config_dir(), "server.pid.json")) or {}).get("pid")
    if pid:
        try:
            if IS_WIN:
                run(["taskkill", "/PID", str(pid), "/F"])
            else:
                os.kill(int(pid), 15)
        except (OSError, ValueError):
            pass
    for _ in range(25):
        if not server_up(port):
            return
        time.sleep(0.2)


def install_service(app):
    server = os.path.join(app, "server.py")
    svc = {"python": python_exe(), "server": server, "app": app, "platform": sys.platform}
    if IS_MAC:
        logf = os.path.join(config.config_dir(), "server.log")
        path_env = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        plist = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>Label</key><string>%s</string>
 <key>ProgramArguments</key><array><string>%s</string><string>%s</string></array>
 <key>RunAtLoad</key><true/>
 <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
 <key>ThrottleInterval</key><integer>5</integer>
 <key>EnvironmentVariables</key><dict><key>PATH</key><string>%s</string><key>PYTHONUNBUFFERED</key><string>1</string><key>PULT_CONFIG</key><string>%s</string></dict>
 <key>StandardOutPath</key><string>%s</string>
 <key>StandardErrorPath</key><string>%s</string>
 <key>ProcessType</key><string>Interactive</string>
</dict></plist>
""" % (LABEL, xml(python_exe()), xml(server), path_env, xml(config.config_path()), xml(logf), xml(logf))
        os.makedirs(os.path.dirname(plist_path()), exist_ok=True)
        with open(plist_path(), "w", encoding="utf-8") as f:
            f.write(plist)
        uid = os.getuid()
        run(["launchctl", "bootout", "gui/%d/%s" % (uid, LABEL)])
        r = run(["launchctl", "bootstrap", "gui/%d" % uid, plist_path()])
        if r.returncode not in (0, 5, 37):  # 5/37 = už načteno
            say("  ! launchctl: %s" % (r.stderr.strip() or r.returncode))
        run(["launchctl", "kickstart", "-k", "gui/%d/%s" % (uid, LABEL)])
        svc["plist"] = plist_path()
    elif IS_WIN:
        vbs = startup_vbs()
        os.makedirs(os.path.dirname(vbs), exist_ok=True)
        with open(vbs, "w", encoding="utf-16") as f:  # VBScript s diakritikou v cestě potřebuje UTF-16
            f.write('Set sh = CreateObject("WScript.Shell")\r\nsh.Environment("PROCESS")("PULT_CONFIG") = "%s"\r\n'
                    'sh.Run """%s"" ""%s""", 0, False\r\n' % (config.config_path(), python_exe(True), server))
        svc["startup"] = vbs
        start_detached(server)
    else:
        start_detached(server)
    svc["source"] = HERE  # odsud se instalovalo: pult update tu stáhne novou verzi
    save_json(os.path.join(config.config_dir(), "service.json"), svc)
    return svc


def start_detached(server):
    logf = open(os.path.join(config.config_dir(), "server.log"), "ab")
    kw = {"creationflags": 0x00000008 | 0x00000200 | NO_WINDOW} if IS_WIN else {"start_new_session": True}
    subprocess.Popen([python_exe(True), server], stdout=logf, stderr=logf, stdin=subprocess.DEVNULL, close_fds=True, **kw)


def xml(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------- příkaz pult ----------
def install_cli(app):
    b = bin_dir()
    os.makedirs(b, exist_ok=True)
    cli = os.path.join(app, "cli.py")
    if IS_WIN:
        shim = os.path.join(b, "pult.cmd")
        with open(shim, "w", encoding="utf-8") as f:
            f.write('@echo off\r\nchcp 65001 >nul\r\nset "PULT_CONFIG=%s"\r\n"%s" "%s" %%*\r\n' % (config.config_path(), python_exe(), cli))
        add_to_user_path_win(b)
    else:
        shim = os.path.join(b, "pult")
        with open(shim, "w", encoding="utf-8") as f:
            f.write('#!/bin/sh\nPULT_CONFIG="%s" exec "%s" "$@"\n' % (config.config_path(), '" "'.join((python_exe(), cli))))
        os.chmod(shim, 0o755)
        add_to_path_posix(b)
    return shim


def add_to_user_path_win(folder):
    import winreg  # noqa: PLC0415
    import ctypes  # noqa: PLC0415
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_READ | winreg.KEY_WRITE) as k:
        try:
            cur, typ = winreg.QueryValueEx(k, "Path")
        except FileNotFoundError:
            cur, typ = "", winreg.REG_EXPAND_SZ
        parts = [p for p in cur.split(";") if p]
        if any(os.path.normcase(p.rstrip("\\")) == os.path.normcase(folder.rstrip("\\")) for p in parts):
            return
        winreg.SetValueEx(k, "Path", 0, typ if typ in (winreg.REG_SZ, winreg.REG_EXPAND_SZ) else winreg.REG_EXPAND_SZ, ";".join(parts + [folder]))
    try:  # ať nově otevřené terminály PATH hned vidí
        ctypes.windll.user32.SendMessageTimeoutW(0xFFFF, 0x1A, 0, "Environment", 0x0002, 5000, ctypes.byref(ctypes.c_ulong()))
    except Exception:
        pass


def remove_from_user_path_win(folder):
    try:
        import winreg  # noqa: PLC0415
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment", 0, winreg.KEY_READ | winreg.KEY_WRITE) as k:
            cur, typ = winreg.QueryValueEx(k, "Path")
            parts = [p for p in cur.split(";") if p and os.path.normcase(p.rstrip("\\")) != os.path.normcase(folder.rstrip("\\"))]
            winreg.SetValueEx(k, "Path", 0, typ, ";".join(parts))
    except OSError:
        pass


PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"  # Pult'


def add_to_path_posix(folder):
    if folder in os.environ.get("PATH", "").split(os.pathsep):
        return
    rc = os.path.join(HOME, ".zshrc" if IS_MAC or os.environ.get("SHELL", "").endswith("zsh") else ".bashrc")
    try:
        txt = open(rc, encoding="utf-8").read() if os.path.exists(rc) else ""
    except OSError:
        txt = ""
    if ".local/bin" not in txt:
        with open(rc, "a", encoding="utf-8") as f:
            f.write("\n" + PATH_LINE + "\n")


# ---------- spouštěč aplikace (Spotlight / nabídka Start) ----------
def ico_from_png(png, out):
    data = open(png, "rb").read()
    w = struct.unpack(">I", data[16:20])[0]
    with open(out, "wb") as f:
        f.write(struct.pack("<HHH", 0, 1, 1))
        f.write(struct.pack("<BBBBHHII", 0 if w >= 256 else w, 0 if w >= 256 else w, 0, 0, 1, 32, len(data), 22))
        f.write(data)


def refresh_chrome_app_icon(icon_png, port):
    """Pult nainstalovaný jako aplikace z Chromu si ikonu uloží při instalaci a sám ji nemění.
    Po změně loga ji tady přepíšeme (ikony v profilu Chromu i v Docku) a Dock obnovíme."""
    import plistlib
    apps = os.path.join(HOME, "Applications", "Chrome Apps.localized")
    changed = False
    for name in (os.listdir(apps) if os.path.isdir(apps) else []):
        info = os.path.join(apps, name, "Contents", "Info.plist")
        try:
            with open(info, "rb") as f:
                pl = plistlib.load(f)
        except Exception:
            continue
        url = str(pl.get("CrAppModeShortcutURL") or "")
        if pl.get("CrAppModeShortcutName") != "Pult" and not url.startswith("http://localhost:%d" % port):
            continue
        app_id = pl.get("CrAppModeShortcutID") or ""
        gdir = os.path.join(HOME, "Library", "Application Support", "Google")
        for root, dirs, files in os.walk(gdir):
            if root.count(os.sep) - gdir.count(os.sep) > 5:
                dirs[:] = []
                continue
            if os.path.basename(root) == app_id and os.path.basename(os.path.dirname(root)) == "Manifest Resources":
                for r2, _, fs in os.walk(root):
                    for fn in fs:
                        if fn.endswith(".png") and fn[:-4].isdigit():
                            px = fn[:-4]
                            src = icon_png.replace("icon-512.png", "icon-maskable-512.png") if "Maskable" in r2 else icon_png
                            run(["sips", "-z", px, px, src, "--out", os.path.join(r2, fn)])
                dirs[:] = []
        icns = os.path.join(apps, name, "Contents", "Resources", "app.icns")
        iconset = os.path.join(config.config_dir(), "PultChrome.iconset")
        shutil.rmtree(iconset, ignore_errors=True)
        os.makedirs(iconset)
        for sz in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                px = sz * scale
                if px > 512:
                    continue
                run(["sips", "-z", str(px), str(px), icon_png, "--out", os.path.join(iconset, "icon_%dx%d%s.png" % (sz, sz, "@2x" if scale == 2 else ""))])
        tmp = icns + ".new"
        run(["iconutil", "-c", "icns", iconset, "-o", tmp])
        shutil.rmtree(iconset, ignore_errors=True)
        if not os.path.exists(tmp):  # macOS nemusí dovolit zápis do cizí aplikace
            continue
        try:
            same = open(tmp, "rb").read() == open(icns, "rb").read()
        except OSError:
            same = False
        if same:
            os.remove(tmp)
            continue
        os.replace(tmp, icns)
        run(["touch", os.path.join(apps, name)])
        changed = True
    if changed:
        run(["killall", "Dock"])


# Verze nativního okna (ne Pultu): mění se jen se Swiftem nebo Info.plist. Ad-hoc podepsaná aplikace
# si oprávnění k mikrofonu drží jen do další změny binárky, proto se zbytečně nepřestavuje.
NATIVE_SHELL_VERSION = "3.0"
DOC_TYPES = ["public.movie", "public.image"]
NATIVE_PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>CFBundleName</key><string>Pult</string><key>CFBundleDisplayName</key><string>Pult</string>
 <key>CFBundleIdentifier</key><string>%(bid)s</string><key>CFBundleVersion</key><string>%(build)s</string>
 <key>CFBundleShortVersionString</key><string>%(v)s</string><key>CFBundlePackageType</key><string>APPL</string>
 <key>CFBundleExecutable</key><string>Pult</string><key>CFBundleIconFile</key><string>Pult</string>
 <key>CFBundleDevelopmentRegion</key><string>en</string>
 <key>CFBundleLocalizations</key><array><string>en</string><string>cs</string></array>
 <key>LSMinimumSystemVersion</key><string>12.0</string><key>NSHighResolutionCapable</key><true/>
 <key>LSApplicationCategoryType</key><string>public.app-category.video</string>
 <key>NSHumanReadableCopyright</key><string>Jan Pils · MIT</string>
 <key>NSMicrophoneUsageDescription</key><string>Pult uses the microphone to dictate comments.</string>
 <key>CFBundleDocumentTypes</key><array>
  <dict><key>CFBundleTypeName</key><string>Video or image</string><key>CFBundleTypeRole</key><string>Viewer</string>
   <key>LSHandlerRank</key><string>Alternate</string><key>LSItemContentTypes</key><array>%(types)s</array></dict>
 </array>
 <key>CFBundleURLTypes</key><array>
  <dict><key>CFBundleURLName</key><string>Pult</string><key>CFBundleURLSchemes</key><array><string>pult</string></array></dict>
 </array>
 <key>PultURL</key><string>%(url)s</string><key>PultPython</key><string>%(py)s</string>
 <key>PultCLI</key><string>%(cli)s</string><key>PultConfig</key><string>%(cfg)s</string>
</dict></plist>
"""


def make_icns(app, out):
    """Ikona aplikace ve všech velikostech (z SVG, aby byla ostrá i 512 @2x)."""
    svg = os.path.join(app, "static", "icons", "icon.svg")
    png = os.path.join(app, "static", "icons", "icon-512.png")
    iconset = os.path.join(config.config_dir(), "Pult.iconset")
    shutil.rmtree(iconset, ignore_errors=True)
    os.makedirs(iconset)
    big = os.path.join(iconset, "src-1024.png")
    src = big if run(["sips", "-s", "format", "png", "-Z", "1024", svg, "--out", big]).returncode == 0 and os.path.exists(big) else png
    for sz in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = sz * scale
            if src == png and px > 512:
                continue
            run(["sips", "-z", str(px), str(px), src, "--out", os.path.join(iconset, "icon_%dx%d%s.png" % (sz, sz, "@2x" if scale == 2 else ""))])
    if os.path.exists(big):
        os.remove(big)
    run(["iconutil", "-c", "icns", iconset, "-o", out])
    shutil.rmtree(iconset, ignore_errors=True)


def build_native_app(app, bundle, url, bundle_id="cz.pult.app"):
    """Nativní aplikace Pultu (AppKit + WebKit). Vrací True, když je aplikace připravená.
    Když se Swift ani Info.plist nezměnily, nechá stávající aplikaci beze změny: macOS u ní
    pak pozná stejný podpis a nezeptá se znovu na mikrofon."""
    src = os.path.join(app, "macapp", "Pult.swift")
    if not os.path.exists(src):
        return False
    import hashlib  # noqa: PLC0415
    import platform  # noqa: PLC0415
    from xml.sax.saxutils import escape  # noqa: PLC0415
    arch = "arm64" if platform.machine() == "arm64" else "x86_64"
    fields = {"v": NATIVE_SHELL_VERSION, "bid": bundle_id, "url": escape(url), "py": escape(python_exe()),
              "cli": escape(os.path.join(app, "cli.py")), "cfg": escape(config.config_path()),
              "types": "".join("<string>%s</string>" % t for t in DOC_TYPES)}
    h = hashlib.sha256()
    for f in (src, os.path.join(app, "static", "icons", "icon.svg")):
        with open(f, "rb") as fh:
            h.update(fh.read())
    h.update((arch + json.dumps(fields, sort_keys=True)).encode("utf-8"))
    fp = h.hexdigest()
    stamp = os.path.join(config.config_dir(), "native-app.sha256")
    try:
        same = open(stamp, encoding="utf-8").read().strip() == fp
    except OSError:
        same = False
    if same and os.path.isfile(os.path.join(bundle, "Contents", "MacOS", "Pult")):
        return True
    tmp = bundle + ".build"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(os.path.join(tmp, "Contents", "MacOS"))
    os.makedirs(os.path.join(tmp, "Contents", "Resources"))
    if run(["xcode-select", "-p"]).returncode != 0:
        shutil.rmtree(tmp, ignore_errors=True)
        return False  # bez Command Line Tools: zůstane jednoduchý spouštěč v prohlížeči (instalátor to oznámí)
    try:
        r = run(["xcrun", "swiftc", "-O", "-target", "%s-apple-macos12" % arch, src, "-o", os.path.join(tmp, "Contents", "MacOS", "Pult")], timeout=300)
    except subprocess.TimeoutExpired:
        shutil.rmtree(tmp, ignore_errors=True)
        return False
    if r.returncode != 0:
        say("  swiftc: %s" % (r.stderr or "").strip()[-400:])
        shutil.rmtree(tmp, ignore_errors=True)
        return False
    fields["build"] = fp[:12]
    with open(os.path.join(tmp, "Contents", "Info.plist"), "w", encoding="utf-8") as f:
        f.write(NATIVE_PLIST % fields)
    make_icns(app, os.path.join(tmp, "Contents", "Resources", "Pult.icns"))
    run(["codesign", "--force", "--deep", "-s", "-", tmp])
    shutil.rmtree(bundle, ignore_errors=True)
    os.replace(tmp, bundle)
    with open(stamp, "w", encoding="utf-8") as f:
        f.write(fp)
    return True


def add_to_dock(bundle):
    """Při první instalaci přidá Pult do Docku (jen když tam žádný Pult ještě není)."""
    r = run(["defaults", "read", "com.apple.dock", "persistent-apps"])
    if r.returncode != 0 or "Pult.app" in (r.stdout or ""):
        return False
    tile = ("<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://%s/</string>"
            "<key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>") % bundle.replace(" ", "%20")
    if run(["defaults", "write", "com.apple.dock", "persistent-apps", "-array-add", tile]).returncode != 0:
        return False
    run(["killall", "Dock"])
    return True


def remove_from_dock(bundle):
    """Odebere z Docku jen dlaždici s naším Pult.app."""
    import plistlib  # noqa: PLC0415
    r = subprocess.run(["defaults", "export", "com.apple.dock", "-"], capture_output=True)
    if r.returncode != 0:
        return
    d = plistlib.loads(r.stdout)
    want = "file://%s/" % bundle.replace(" ", "%20")
    apps = d.get("persistent-apps", [])
    keep = [t for t in apps if t.get("tile-data", {}).get("file-data", {}).get("_CFURLString") != want]
    if len(keep) == len(apps):
        return
    d["persistent-apps"] = keep
    subprocess.run(["defaults", "import", "com.apple.dock", "-"], input=plistlib.dumps(d))
    run(["killall", "Dock"])


def install_launcher(app, port):
    url = "http://localhost:%d/" % port
    icon_png = os.path.join(app, "static", "icons", "icon-512.png")
    if IS_MAC:
        bundle = os.path.join(HOME, "Applications", "Pult.app")
        # nepovedené sestavení nesmí smazat fungující aplikaci (třeba při pult update)
        native = build_native_app(app, bundle, url) or bool(config.native_app())
        if not native:
            shutil.rmtree(bundle, ignore_errors=True)
            os.makedirs(os.path.join(bundle, "Contents", "MacOS"))
            os.makedirs(os.path.join(bundle, "Contents", "Resources"))
            with open(os.path.join(bundle, "Contents", "Info.plist"), "w", encoding="utf-8") as f:
                f.write("""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>CFBundleName</key><string>Pult</string><key>CFBundleDisplayName</key><string>Pult</string>
 <key>CFBundleIdentifier</key><string>cz.pult.launcher</string><key>CFBundleVersion</key><string>%s</string>
 <key>CFBundleShortVersionString</key><string>%s</string><key>CFBundlePackageType</key><string>APPL</string>
 <key>CFBundleExecutable</key><string>pult</string><key>CFBundleIconFile</key><string>Pult</string>
 <key>LSUIElement</key><true/>
</dict></plist>
""" % (config.VERSION, config.VERSION))
            exe = os.path.join(bundle, "Contents", "MacOS", "pult")
            with open(exe, "w", encoding="utf-8") as f:
                f.write("""#!/bin/sh
# Pult: spustí server (když neběží) a otevře aplikaci. Nainstalovaná webová aplikace z Chrome má přednost.
PULT_CONFIG="%s" "%s" "%s" start >/dev/null 2>&1
PWA=$(ls -d "$HOME/Applications/Chrome Apps.localized/"Pult*.app 2>/dev/null | head -1)
if [ -n "$PWA" ]; then open "$PWA"
elif [ -d "/Applications/Google Chrome.app" ]; then open -na "Google Chrome" --args --app="%s"
else open "%s"; fi
""" % (config.config_path(), python_exe(), os.path.join(app, "cli.py"), url, url))
            os.chmod(exe, 0o755)
        if not native:  # nativní aplikace má ikonu a podpis z build_native_app
            make_icns(app, os.path.join(bundle, "Contents", "Resources", "Pult.icns"))
        run(["touch", bundle])
        run(["/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", bundle])
        try:
            refresh_chrome_app_icon(icon_png, port)
        except Exception:  # ikona Chrome verze není podstatná, instalaci nezastaví
            pass
        return bundle
    if IS_WIN:
        ico = os.path.join(os.path.dirname(app), "Pult.ico")
        ico_from_png(icon_png, ico)
        edge = next((p for p in (os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
                                 os.path.join(os.environ.get("ProgramFiles", ""), "Microsoft", "Edge", "Application", "msedge.exe")) if os.path.isfile(p)), None)
        lnk = os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu", "Programs", "Pult.lnk")
        target, args = (edge, "--app=%s" % url) if edge else (os.path.join(os.environ.get("SystemRoot", "C:\\Windows"), "explorer.exe"), url)
        ps = ("$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%s');$s.TargetPath='%s';$s.Arguments='%s';"
              "$s.IconLocation='%s';$s.Description='Pult: image and video review';$s.Save()") % (
            lnk.replace("'", "''"), target.replace("'", "''"), args.replace("'", "''"), ico.replace("'", "''"))
        run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps])
        return lnk
    return None


# ---------- Claude ----------
MARK_A, MARK_B = "<!-- PULT:START -->", "<!-- PULT:END -->"


def claude_dir():
    return os.path.join(HOME, ".claude")


def agent_dirs():
    """Kam zapsat pokyny pro AI agenty: Claude Code (CLAUDE.md) vždy, Codex (AGENTS.md), když je na počítači."""
    out = [(claude_dir(), "CLAUDE.md")]
    default = os.path.join(HOME, ".codex")
    if os.path.isdir(default) or shutil.which("codex") or os.path.isdir("/Applications/Codex.app"):
        out.append((default, "AGENTS.md"))
    env = os.path.expanduser(os.environ.get("CODEX_HOME") or "")
    if env and os.path.isdir(env) and all(os.path.realpath(env) != os.path.realpath(d) for d, _ in out):
        out.append((env, "AGENTS.md"))
    return out


def agent_block(shim, port):
    return "\n".join([
        MARK_A,
        "## Pult (image and video review)",
        "- Pult runs on this computer: http://localhost:%d · command `pult` (`%s`) · library `%s`." % (port, shim, config.library()),
        "- When you create images or videos for the user to review, send them to Pult: `pult add -t \"short title\" -m \"what matters when reviewing\" files…`, then tell the user the batch title and item count. Only things to review or approve, not references. Put the key note (what changed, what to focus on) in `-m` / `--item-note \"N: text\"`: the user sees it right in Pult.",
        "- Right after that run `pult wait <batch id>` in the background (Claude Code: Bash with run_in_background): when the user sends the review in Pult, it arrives straight in this chat. If you cannot run background tasks, skip it; the user will say \"check Pult\". While you work on a review: `pult progress <id> \"what you are doing\"`, at the end `pult archive <folder> -m \"what is done\"`.",
        "- \"Check Pult\" / \"check the reviews\": `pult status`, then read `revize.md` and the images in the new review and act on them. Mark it done with `pult archive <folder>`.",
        "- Clean up after yourself: when a batch you sent gets settled in the chat (approved, answered, no longer needed), remove it with `pult dismiss <batch id> -m \"settled in chat\"`. When you send a new version of a batch nobody reviewed, add `--replaces <old batch id>` to `pult add`. Pult refuses batches with someone's notes: leave those to the user.",
        "- \"Update Pult\": run `pult update`, then tell the user the new version and what changed. If it reports local changes, leave them and tell the user.",
        "- Talk to the user in their language. Details in the `pult` skill.",
        MARK_B])


def block_span(text):
    """Kde v souboru leží blok Pultu: (začátek, konec), nebo None."""
    a = text.find(MARK_A)
    z = text.find(MARK_B, a + len(MARK_A)) if a >= 0 else -1
    return (a, z + len(MARK_B)) if a >= 0 and z >= 0 else None


def read_md(md):
    return open(md, encoding="utf-8", errors="surrogateescape").read() if os.path.exists(md) else ""


def write_md(md, text):
    with open(md, "w", encoding="utf-8", errors="surrogateescape") as f:
        f.write(text)


def install_skill(shim, port):
    """Skill pult pro všechny nalezené agenty (Claude Code, Codex). Načte se, jen když je potřeba."""
    src = open(os.path.join(HERE, "skill", "SKILL.md"), encoding="utf-8").read()
    src = src.replace("{{PULT}}", shim).replace("{{URL}}", "http://localhost:%d" % port).replace("{{LIBRARY}}", config.library())
    skills = []
    for base, _name in agent_dirs():
        skill_dir = os.path.join(base, "skills", "pult")
        os.makedirs(skill_dir, exist_ok=True)
        with open(os.path.join(skill_dir, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write(src)
        skills.append(skill_dir)
    return skills


def sync_agent_blocks(shim, port, add):
    """Globální pokyny se načítají v každém chatu a v každém projektu, proto je bez výslovného přání (add=False)
    instalace nepřidává. Blok, který už v souboru je, jen obnoví. Vrací soubory, které blok obsahují."""
    block = agent_block(shim, port)
    mds = []
    for base, name in agent_dirs():
        md = os.path.join(base, name)
        cur = read_md(md)
        span = block_span(cur)
        if span:
            if cur[span[0]:span[1]] != block:
                shutil.copy2(md, md + ".before-pult-update")  # kdo si blok upravil, má zálohu
                write_md(md, cur[:span[0]] + block + cur[span[1]:])
        elif add:
            os.makedirs(base, exist_ok=True)
            write_md(md, (cur.rstrip() + "\n\n" if cur.strip() else "") + block + "\n")
        else:
            continue
        mds.append(md)
    return mds


def agent_bases():
    bases = [(claude_dir(), "CLAUDE.md"), (os.path.join(HOME, ".codex"), "AGENTS.md")]
    if os.environ.get("CODEX_HOME"):
        bases.append((os.path.expanduser(os.environ["CODEX_HOME"]), "AGENTS.md"))
    return bases


def remove_agent_blocks():
    for base, name in agent_bases():
        md = os.path.join(base, name)
        cur = read_md(md)
        span = block_span(cur)
        if span:
            rest = (cur[:span[0]].rstrip() + "\n\n" + cur[span[1]:].lstrip()).strip()
            write_md(md, rest + "\n" if rest else "")


def remove_claude():
    for base, _name in agent_bases():
        shutil.rmtree(os.path.join(base, "skills", "pult"), ignore_errors=True)
    remove_agent_blocks()


# ---------- pomocné ----------
def load_json(p):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save_json(p, obj):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


def install_ffmpeg():
    if IS_MAC and shutil.which("brew"):
        say("  installing ffmpeg with Homebrew (may take a few minutes)…")
        return run(["brew", "install", "ffmpeg"]).returncode == 0
    if IS_WIN and shutil.which("winget"):
        say("  installing ffmpeg with winget…")
        return run(["winget", "install", "--id", "Gyan.FFmpeg", "-e", "--silent", "--accept-source-agreements", "--accept-package-agreements"]).returncode == 0
    return False


def replace_retry(src, dst):
    """Na Windows drží čerstvě zkopírované soubory chvíli antivir nebo Průzkumník."""
    for i in range(20):
        try:
            return os.replace(src, dst)
        except PermissionError:
            if i == 19:
                raise
            time.sleep(0.5)


def copy_app(dst):
    tmp = dst + ".new"
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.copytree(SRC, tmp, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store"))
    old = dst + ".old"
    shutil.rmtree(old, ignore_errors=True)
    if os.path.exists(dst):
        replace_retry(dst, old)
    try:
        replace_retry(tmp, dst)
    except OSError:
        if os.path.exists(old):
            os.replace(old, dst)  # ať `pult` zůstane funkční
        raise
    shutil.rmtree(old, ignore_errors=True)


# ---------- hlavní ----------
def install(a):
    say("Pult %s · installing for %s" % (config.VERSION, "Windows" if IS_WIN else "macOS" if IS_MAC else sys.platform))
    if sys.version_info < (3, 9):
        sys.exit("Pult needs Python 3.9 or newer (found %s)." % sys.version.split()[0])
    cfg = config.load()
    # Volby pro agenty se pamatují, ať je pult update (spouští instalátor bez voleb) nezruší.
    if a.no_claude:
        cfg["agent_skill"] = False
    if a.agent_skill or a.agent_instructions:
        cfg["agent_skill"] = True
    if a.agent_instructions:
        cfg["agent_instructions"] = True
    if a.no_agent_instructions:
        cfg["agent_instructions"] = False
    if a.port:
        cfg["port"] = a.port
    if getattr(a, "lang", None):
        cfg["lang"] = a.lang
    if a.library:
        cfg["library"] = os.path.abspath(os.path.expanduser(a.library))
    port = int(cfg.get("port") or config.DEFAULT_PORT)
    lib = os.path.realpath(config.library(cfg))
    here = os.path.realpath(HERE)
    if (lib.lower() == here.lower() or lib.lower().startswith(here.lower() + os.sep)
            or (os.path.exists(lib) and os.path.samefile(lib, here))):
        # knihovna nesmí ležet ve složce se staženým kódem (na macOS je ~/pult a ~/Pult tatáž složka)
        cfg["library"] = os.path.join(HOME, "Pult Library")
        say("! The library would be inside the downloaded code folder, using %s instead" % cfg["library"])
    cfg["library"] = config.library(cfg)  # pevná cesta: služba po přihlášení ji najde i bez proměnných prostředí
    os.makedirs(config.config_dir(), exist_ok=True)
    config.save(cfg)
    for sub in ("davky", "revize", "archiv"):
        os.makedirs(os.path.join(config.library(cfg), sub), exist_ok=True)
    say("✓ Settings: %s" % config.config_path())
    say("✓ Library: %s" % config.library(cfg))

    stop_service(port)
    app = app_dir()
    copy_app(app)
    say("✓ App: %s" % app)

    ff = config.tool("ffmpeg", cfg)
    if not ff and a.install_ffmpeg:
        install_ffmpeg()
        ff = config.tool("ffmpeg", cfg)
    if ff:
        say("✓ ffmpeg: %s" % ff)
    else:
        say("! ffmpeg missing: images work, videos will not be prepared. Install: %s" % ("winget install Gyan.FFmpeg" if IS_WIN else "brew install ffmpeg"))

    shim = install_cli(app)
    say("✓ pult command: %s" % shim)
    svc = install_service(app)
    st = server_up(port, wait=12)
    say(("✓ Server running: http://localhost:%d (starts automatically at login)" % port) if st else "! Server did not start, see %s" % os.path.join(config.config_dir(), "server.log"))
    launcher = install_launcher(app, port)
    native = bool(config.native_app())
    if launcher:
        say(("✓ App: %s (native window)" if native else "✓ App launcher: %s") % launcher)
    if IS_MAC and not native:
        say("! Native app not built, Pult opens in the browser for now. Fix: xcode-select --install, then run this installer again.")
    if native and not a.no_dock and not cfg.get("dock_added"):
        if add_to_dock(launcher):
            say("✓ Added to the Dock")
        cfg = config.load()
        cfg["dock_added"] = True
        config.save(cfg)
    if a.no_agent_instructions:
        remove_agent_blocks()
        say("✓ AI agents: Pult's block removed from the global instructions")
    elif cfg.get("agent_skill", True):
        for md in sync_agent_blocks(shim, port, bool(cfg.get("agent_instructions"))):
            say("✓ AI agents: global instructions in %s" % md)
    if cfg.get("agent_skill", True):
        say("✓ AI agents: skill %s" % ", ".join(install_skill(shim, port)))
    if a.dictation:
        say("… Dictation: installing speech-to-text (Whisper large-v3-turbo), may take a few minutes")
        r = subprocess.run([python_exe(), os.path.join(app, "cli.py"), "dictation", "install"], env=dict(os.environ, PULT_CONFIG=config.config_path()))
        say("✓ Dictation ready" if r.returncode == 0 else "! Dictation could not be installed (try later: pult dictation install)")
    if st and not a.no_open:
        if native:
            run(["open", launcher])
        else:
            import webbrowser  # noqa: PLC0415
            webbrowser.open("http://localhost:%d/" % port)
    print(json.dumps({"ok": bool(st), "version": config.VERSION, "url": "http://localhost:%d" % port, "app": app,
                      "library": config.library(cfg), "cli": shim, "ffmpeg": ff, "service": svc, "launcher": launcher, "native": native},
                     ensure_ascii=False, indent=1))


def uninstall(a):
    cfg = config.load()
    port = int(cfg.get("port") or config.DEFAULT_PORT)
    stop_service(port)
    if IS_MAC and os.path.exists(plist_path()):
        os.remove(plist_path())
    if IS_WIN:
        if os.path.exists(startup_vbs()):
            os.remove(startup_vbs())
        lnk = os.path.join(os.environ.get("APPDATA", ""), "Microsoft", "Windows", "Start Menu", "Programs", "Pult.lnk")
        if os.path.exists(lnk):
            os.remove(lnk)
        remove_from_user_path_win(bin_dir())
    for p in (os.path.join(bin_dir(), "pult"), os.path.join(bin_dir(), "pult.cmd")):
        if os.path.exists(p):
            os.remove(p)
    if IS_MAC:
        remove_from_dock(os.path.join(HOME, "Applications", "Pult.app"))
        shutil.rmtree(os.path.join(HOME, "Applications", "Pult.app"), ignore_errors=True)
        if cfg.pop("dock_added", None) is not None and os.path.exists(config.config_path()):
            config.save(cfg)
    for rc in (os.path.join(HOME, ".zshrc"), os.path.join(HOME, ".bashrc")):
        try:
            lines = open(rc, encoding="utf-8").read().splitlines(True)
            if PATH_LINE + "\n" in lines:
                with open(rc, "w", encoding="utf-8") as f:
                    f.write("".join(x for x in lines if x != PATH_LINE + "\n"))
        except OSError:
            pass
    remove_claude()
    shutil.rmtree(app_dir(), ignore_errors=True)
    say("Pult uninstalled. The library was kept: %s" % config.library(cfg))
    if a.purge:
        shutil.rmtree(config.config_dir(), ignore_errors=True)
        say("Settings deleted (delete the library with your files manually if you want).")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Install Pult")
    ap.add_argument("--port", type=int)
    ap.add_argument("--library")
    ap.add_argument("--no-open", action="store_true")
    ap.add_argument("--no-claude", action="store_true", help="do not touch AI agent files at all (remembered for updates)")
    ap.add_argument("--agent-skill", action="store_true", help="install the pult skill again after --no-claude")
    ap.add_argument("--agent-instructions", action="store_true", help="also add a block to the global CLAUDE.md / AGENTS.md (off by default, remembered)")
    ap.add_argument("--no-agent-instructions", action="store_true", help="remove that block and do not add it again (remembered)")
    ap.add_argument("--no-dock", action="store_true", help="macOS: do not add Pult to the Dock")
    ap.add_argument("--install-ffmpeg", action="store_true")
    ap.add_argument("--dictation", action="store_true", help="also install local speech-to-text for dictation (Whisper, about 2.4 GB)")
    ap.add_argument("--lang", choices=["en", "cs"], help="interface language (default: follow the browser)")
    ap.add_argument("--uninstall", action="store_true")
    ap.add_argument("--purge", action="store_true")
    args = ap.parse_args()
    uninstall(args) if args.uninstall else install(args)
