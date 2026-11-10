// Pult: nativní aplikace pro macOS. Rozhraní je webové (lokální server Pultu ve WebKitu), všechno kolem
// je AppKit: okno s ovládáním v liště, menu, Dock, přetažení souborů, oznámení, aktualizace.
// Sestavuje ji install.py (swiftc z Command Line Tools), adresa a cesty jsou v Info.plist.
import Cocoa
import UserNotifications
import WebKit

let info = Bundle.main.infoDictionary ?? [:]
let pultURL = URL(string: (info["PultURL"] as? String) ?? "http://localhost:7858/")!
let shellVersion = (info["CFBundleShortVersionString"] as? String) ?? "1"
/// Web Inspector jen na požádání: defaults write cz.pult.app PultDeveloperMode -bool true
let developerMode = UserDefaults.standard.bool(forKey: "PultDeveloperMode")
let repoURL = URL(string: "https://github.com/jan-visual/pult")!

// MARK: - Jazyk menu (řídí se jazykem rozhraní Pultu)

var lang: String = UserDefaults.standard.string(forKey: "PultLanguage")
    ?? (["cs", "sk"].contains(String((Locale.preferredLanguages.first ?? "en").prefix(2))) ? "cs" : "en")
func L(_ en: String, _ cs: String) -> String { lang == "cs" ? cs : en }

func openExternal(_ u: URL) {
    // ven jen web a e-mail, nikdy file://, smb:// ani jiné aplikace
    if ["http", "https", "mailto"].contains(u.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(u) }
}

func isLocal(_ url: URL?) -> Bool {
    guard let u = url else { return false }
    if u.scheme == "about" || u.scheme == "blob" || u.scheme == "data" { return true }
    guard u.scheme == "http" || u.scheme == "https" else { return false }
    return u.host == pultURL.host && (u.port ?? 80) == (pultURL.port ?? 80)
}

func jsonString(_ v: Any) -> String {
    guard let d = try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed]) else { return "null" }
    return String(data: d, encoding: .utf8) ?? "null"
}

// MARK: - Stav webového rozhraní (podle něj menu ví, co jde udělat)

struct WebState {
    var raw: [String: Any] = [:]
    func flag(_ k: String) -> Bool { (raw[k] as? Bool) ?? false }
    var ready: Bool { !raw.isEmpty }
    var typing: Bool { flag("typing") }
    var modal: Bool { flag("modal") }
    var toReview: Int { (raw["toReview"] as? Int) ?? 0 }
    var version: String { (raw["version"] as? String) ?? "" }
    var batches: [(id: String, title: String)] {
        ((raw["batches"] as? [[String: Any]]) ?? []).compactMap { b in
            guard let id = b["id"] as? String, let t = b["title"] as? String else { return nil }
            return (id, t)
        }
    }
}

// MARK: - Tažení okna za lištu webového rozhraní

/// Průhledná vrstva nad webem. Na prázdných místech lišty (oblasti `data-mac-drag` bez tlačítek) chytí myš
/// a táhne okno; dvojklik dělá to, co má uživatel nastavené v Nastavení systému. Jinde je neviditelná.
final class TitlebarDragView: NSView {
    var drags: [NSRect] = []
    var holes: [NSRect] = []
    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? {
        let p = convert(point, from: superview)
        guard drags.contains(where: { $0.contains(p) }), !holes.contains(where: { $0.contains(p) }) else { return nil }
        return self
    }
    override func mouseDown(with event: NSEvent) {
        guard let w = window else { return }
        if event.clickCount == 2 {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize" {
            case "Minimize": w.performMiniaturize(nil)
            case "None": break
            default: w.performZoom(nil)
            }
        } else {
            w.performDrag(with: event)
        }
    }
}

// MARK: - WebKit

final class PultWebView: WKWebView {
    /// Soubory puštěné do okna: true = vyřízeno nativně (bez kopírování), false = postará se web (nahrání).
    var onFileDrop: (([URL]) -> Bool)?
    private var droppedNatively = false

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = (sender.draggingPasteboard.readObjects(forClasses: [NSURL.self],
                                                          options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
        if !urls.isEmpty, onFileDrop?(urls) == true {
            droppedNatively = true
            super.draggingExited(sender)  // web schová překryv „Pusť soubory na Pult“
            return true
        }
        droppedNatively = false
        return super.performDragOperation(sender)
    }
    override func concludeDragOperation(_ sender: NSDraggingInfo?) {
        if droppedNatively { droppedNatively = false; return }
        super.concludeDragOperation(sender)
    }

    // Kontextové menu jako v nativní aplikaci: text ano, prohlížečové věci (Reload, Zpět, video…) ne.
    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        let keep: Set<String> = ["WKMenuItemIdentifierCopy", "WKMenuItemIdentifierCut", "WKMenuItemIdentifierPaste",
                                 "WKMenuItemIdentifierLookUp", "WKMenuItemIdentifierSearchWeb", "WKMenuItemIdentifierShareMenu",
                                 "WKMenuItemIdentifierSpellingMenu", "WKMenuItemIdentifierCopyLink", "WKMenuItemIdentifierTranslate"]
        for item in menu.items {
            let id = item.identifier?.rawValue ?? ""
            if id.hasPrefix("WKMenuItemIdentifier") && !keep.contains(id) && !(developerMode && id == "WKMenuItemIdentifierInspectElement") {
                menu.removeItem(item)
            }
        }
        while let f = menu.items.first, f.isSeparatorItem { menu.removeItem(f) }
        while let l = menu.items.last, l.isSeparatorItem { menu.removeItem(l) }
        super.willOpenMenu(menu, with: event)
    }
}

// MARK: - Aplikace

final class Pult: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuItemValidation, NSMenuDelegate,
                  WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler,
                  UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var web: PultWebView!
    let dragView = TitlebarDragView()
    let loading = NSView()
    let loadingLabel = NSTextField(labelWithString: "")
    var state = WebState()
    var retries = 0
    var loadedOnce = false
    var pending: [(String, Any)] = []  // příkazy pro web, než se načte (otevřené soubory, odkazy pult://)
    var downloads: [ObjectIdentifier: URL] = [:]
    var titleObservation: NSKeyValueObservation?
    var updating = false

    // MARK: Start

    func applicationWillFinishLaunching(_ n: Notification) {
        NSWindow.allowsAutomaticWindowTabbing = false
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURLEvent(_:reply:)),
                                                     forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenu()
        UNUserNotificationCenter.current().delegate = self

        let cfg = WKWebViewConfiguration()
        cfg.applicationNameForUserAgent = "Version/18.0 Safari/605.1.15 PultApp/\(shellVersion)"
        cfg.mediaTypesRequiringUserActionForPlayback = []
        if #available(macOS 12.3, *) { cfg.preferences.isElementFullscreenEnabled = true }
        let ucc = cfg.userContentController
        ucc.add(self, name: "pult")
        ucc.addUserScript(WKUserScript(source: bootstrapScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))

        web = PultWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false
        web.allowsMagnification = false  // štípnutí přiblíží obraz v přehrávači, ne celé okno
        web.allowsLinkPreview = false
        web.underPageBackgroundColor = NSColor(red: 0.043, green: 0.043, blue: 0.043, alpha: 1)
        if #available(macOS 13.3, *) { web.isInspectable = developerMode }
        web.onFileDrop = { [weak self] urls in self?.addFiles(urls, fromDrop: true) ?? false }
        web.isHidden = true  // do prvního načtení jen nativní „Spouštím Pult…“, žádné bílé probliknutí

        window = NSWindow(contentRect: initialFrame(),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Pult"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        // Prázdný toolbar: macOS sám umístí semafor doprostřed vysoké lišty (jako Finder, Mail, Xcode)
        let tb = NSToolbar(identifier: "PultToolbar")
        tb.showsBaselineSeparator = false
        tb.allowsUserCustomization = false
        window.toolbar = tb
        window.toolbarStyle = .unified
        window.titlebarSeparatorStyle = .none
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(red: 0.043, green: 0.043, blue: 0.043, alpha: 1)
        window.minSize = NSSize(width: 760, height: 520)
        window.tabbingMode = .disallowed
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.isReleasedWhenClosed = false
        window.delegate = self

        let root = NSView()
        web.frame = root.bounds
        web.autoresizingMask = [.width, .height]
        root.addSubview(web)
        dragView.frame = root.bounds
        dragView.autoresizingMask = [.width, .height]
        root.addSubview(dragView)
        buildLoadingView(in: root)
        window.contentView = root
        window.setFrameAutosaveName("PultMain")

        titleObservation = web.observe(\.title, options: [.new]) { [weak self] w, _ in
            let t = w.title ?? ""
            self?.window.title = t.isEmpty ? "Pult" : t  // Okno › seznam oken, Mission Control
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        load()
    }

    func initialFrame() -> NSRect {
        let vis = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let w = min(1440, vis.width - 80), h = min(900, vis.height - 60)
        return NSRect(x: vis.midX - w / 2, y: vis.midY - h / 2, width: w, height: h)
    }

    func buildLoadingView(in root: NSView) {
        loading.frame = root.bounds
        loading.autoresizingMask = [.width, .height]
        loading.wantsLayer = true
        loading.layer?.backgroundColor = window.backgroundColor.cgColor
        let spin = NSProgressIndicator()
        spin.style = .spinning
        spin.controlSize = .small
        spin.startAnimation(nil)
        loadingLabel.stringValue = L("Starting Pult…", "Spouštím Pult…")
        loadingLabel.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [spin, loadingLabel])
        stack.orientation = .vertical
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        loading.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: loading.centerXAnchor),
                                     stack.centerYAnchor.constraint(equalTo: loading.centerYAnchor)])
        root.addSubview(loading)
    }

    /// Spustí se v každé stránce Pultu před jejími skripty: třída pro nativní vzhled a odsazení od semaforu.
    func bootstrapScript() -> String {
        """
        (function () {
          var d = document.documentElement;
          d.classList.add('mac-native');
          window.__pultMac = {
            apply: function (o) {
              if (o.inset != null) d.style.setProperty('--mac-tl', o.inset + 'px');
              if (o.fullscreen != null) d.classList.toggle('mac-fullscreen', !!o.fullscreen);
              if (o.key != null) d.classList.toggle('mac-inactive', !o.key);
            }
          };
          window.__pultMac.apply(\(jsonString(chromeInfo())));
        })();
        """
    }

    func load() { web.load(URLRequest(url: pultURL)) }

    // MARK: Okno

    /// Kde končí semafor (zavřít, minimalizovat, zvětšit): web od něj odsadí svou lištu.
    func chromeInfo() -> [String: Any] {
        let full = window?.styleMask.contains(.fullScreen) ?? false
        var inset: CGFloat = 86
        if let w = window, let zoom = w.standardWindowButton(.zoomButton), let sv = zoom.superview {
            inset = ceil(sv.convert(zoom.frame, to: nil).maxX + 14)
        }
        return ["inset": full ? 0 : inset, "fullscreen": full, "key": window?.isKeyWindow ?? true]
    }
    func pushChrome() { web?.evaluateJavaScript("window.__pultMac&&__pultMac.apply(\(jsonString(chromeInfo())))") }

    func windowDidBecomeKey(_ n: Notification) { pushChrome() }
    func windowDidResignKey(_ n: Notification) { pushChrome() }
    func windowDidEnterFullScreen(_ n: Notification) { pushChrome() }
    func windowDidExitFullScreen(_ n: Notification) { pushChrome() }
    func windowDidChangeBackingProperties(_ n: Notification) { pushChrome() }
    func windowWillClose(_ n: Notification) { command("pause") }  // zavřené okno nehraje dál

    func showWindow() {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // Pult je jedno okno: ⌘W ho zavře, aplikace zůstane v Docku (jako Hudba nebo Zprávy).
    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows f: Bool) -> Bool {
        if !f { showWindow() }
        return true
    }
    func applicationShouldTerminate(_ s: NSApplication) -> NSApplication.TerminateReply {
        guard state.flag("busy") else { return .terminateNow }
        let a = NSAlert()
        a.messageText = L("Files are still uploading to Pult", "Soubory se ještě nahrávají na Pult")
        a.informativeText = L("If you quit now, the upload stops.", "Když teď aplikaci ukončíš, nahrávání se zastaví.")
        a.addButton(withTitle: L("Keep Uploading", "Nechat nahrávat"))
        a.addButton(withTitle: L("Quit", "Ukončit"))
        return a.runModal() == .alertSecondButtonReturn ? .terminateNow : .terminateCancel
    }

    // MARK: Most do webu

    func command(_ name: String, _ arg: Any = NSNull()) {
        guard state.ready, web != nil else { pending.append((name, arg)); return }
        web.evaluateJavaScript("window.PultNative&&PultNative.command(\(jsonString(name)),\(jsonString(arg)))")
    }
    @objc func runCommand(_ sender: NSMenuItem) {
        guard let c = sender.representedObject as? String else { return }
        if c.hasPrefix("tool:") { command("tool", String(c.dropFirst(5))) } else { command(c) }
    }

    func userContentController(_ ucc: WKUserContentController, didReceive m: WKScriptMessage) {
        guard m.frameInfo.isMainFrame, isLocal(m.frameInfo.request.url),
              let body = m.body as? [String: Any], let t = body["t"] as? String else { return }
        switch t {
        case "state":
            let wasReady = state.ready
            state = WebState(raw: body)
            if let l = body["lang"] as? String, l != lang, ["cs", "en"].contains(l) {
                lang = l
                UserDefaults.standard.set(l, forKey: "PultLanguage")
                buildMenu()
            }
            NSApp.dockTile.badgeLabel = state.toReview > 0 ? String(state.toReview) : nil
            if !wasReady {
                let queued = pending
                pending = []
                queued.forEach { command($0.0, $0.1) }
            }
        case "drag":
            func rects(_ k: String) -> [NSRect] {
                ((body[k] as? [[Double]]) ?? []).filter { $0.count == 4 }.map { NSRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) }
            }
            dragView.drags = rects("drags")
            dragView.holes = rects("holes")
        case "notify":
            notify(title: (body["title"] as? String) ?? "Pult", body: (body["body"] as? String) ?? "", batch: body["batch"] as? String)
        default: break
        }
    }

    // MARK: Načítání a server

    func webView(_ w: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError e: Error) {
        let err = e as NSError
        if err.code == NSURLErrorCancelled || err.code == 102 { return }  // zrušeno / převedeno na stažení
        retries += 1
        if retries == 1 || retries % 10 == 0 { startServer() }
        loadingLabel.stringValue = retries < 3 ? L("Starting Pult…", "Spouštím Pult…") : L("Waiting for the Pult server…", "Čekám na server Pultu…")
        loading.isHidden = false
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.load() }
    }
    func webView(_ w: WKWebView, didFinish nav: WKNavigation!) {
        guard isLocal(w.url), w.url?.scheme != "about" else { return }
        retries = 0
        loading.isHidden = true
        web.isHidden = false
        if !loadedOnce { loadedOnce = true; window.makeFirstResponder(web) }
        pushChrome()
        importStorage()
    }
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { state = WebState(); load() }

    // Jednorázový přenos nastavení z prohlížeče: migrate-storage.json vedle config.json ({"pult.name": "\"Jan\"", …}).
    func importStorage() {
        guard let c = info["PultConfig"] as? String else { return }
        let f = URL(fileURLWithPath: c).deletingLastPathComponent().appendingPathComponent("migrate-storage.json")
        guard let data = try? Data(contentsOf: f),
              let items = (try? JSONSerialization.jsonObject(with: data)) as? [String: String] else { return }
        web.evaluateJavaScript("(function(o){for(const k in o){if(k.indexOf('pult.')===0)localStorage.setItem(k,o[k])}return true})(\(jsonString(items)))") { _, err in
            if err == nil { try? FileManager.default.removeItem(at: f); self.load() }
        }
    }

    func cliProcess(_ args: [String]) -> Process? {
        guard let py = info["PultPython"] as? String, let cli = info["PultCLI"] as? String else { return nil }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: py)
        p.arguments = [cli] + args
        var env = ProcessInfo.processInfo.environment
        if let c = info["PultConfig"] as? String { env["PULT_CONFIG"] = c }
        p.environment = env
        return p
    }
    func startServer() {
        guard let p = cliProcess(["start"]) else { return }
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }

    // MARK: Soubory do Pultu (originály zůstanou na místě, nic se nekopíruje)

    /// Smí server ty soubory číst? (macOS mu občas nepustí externí disk nebo složky jako Plocha.)
    func serverCanRead(_ paths: [String]) -> Bool {
        var req = URLRequest(url: pultURL.appendingPathComponent("api/can-read"), timeoutInterval: 2)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["paths": paths])
        let done = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let d = data, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
               let bad = j["unreadable"] as? [Any] { ok = bad.isEmpty }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 2.5)
        return ok
    }

    /// Složky rozbalí na soubory (bez skrytých), aby šlo ověřit, že je server přečte.
    func expand(_ urls: [URL]) -> [URL] {
        var out: [URL] = []
        for u in urls {
            var dir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: u.path, isDirectory: &dir) else { continue }
            if dir.boolValue {
                let en = FileManager.default.enumerator(at: u, includingPropertiesForKeys: [.isRegularFileKey],
                                                        options: [.skipsHiddenFiles, .skipsPackageDescendants])
                while let f = en?.nextObject() as? URL, out.count < 2000 {
                    if (try? f.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true { out.append(f) }
                }
            } else {
                out.append(u)
            }
        }
        return out
    }

    /// true = soubory jdou do Pultu jako cesty (bez kopie). false = server je nepřečte, ať je web nahraje.
    @discardableResult
    func addFiles(_ urls: [URL], fromDrop: Bool, useInputTarget: Bool = false) -> Bool {
        guard state.flag("local") || !state.ready else { return false }
        let files = expand(urls)
        guard !files.isEmpty, serverCanRead(files.map { $0.path }) else {
            if !fromDrop && !files.isEmpty {
                let a = NSAlert()
                a.messageText = L("Pult can't read these files", "Pult tyhle soubory nepřečte")
                a.informativeText = L("macOS doesn't let the Pult server into that folder. Drag the files into the Pult window instead.",
                                      "macOS do té složky server Pultu nepustí. Přetáhni soubory rovnou do okna Pultu.")
                a.runModal()
            }
            return false
        }
        var title = ""
        if urls.count == 1, (try? urls[0].resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true { title = urls[0].lastPathComponent }
        let list: [[String: Any]] = files.map { f in
            ["path": f.path, "name": f.lastPathComponent,
             "size": (try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0]
        }
        command("add-paths", ["files": list, "title": title, "useInputTarget": useInputTarget])
        showWindow()
        return true
    }

    func application(_ s: NSApplication, open urls: [URL]) {
        let files = urls.filter { $0.isFileURL }
        urls.filter { $0.scheme == "pult" }.forEach(openPultURL)
        if !files.isEmpty { addFiles(files, fromDrop: false) }
    }
    @objc func handleURLEvent(_ e: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        if let s = e.paramDescriptor(forKeyword: keyDirectObject)?.stringValue, let u = URL(string: s) { openPultURL(u) }
    }
    /// pult://open?batch=ID&n=2
    func openPultURL(_ u: URL) {
        let q = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard let id = q.first(where: { $0.name == "batch" })?.value else { showWindow(); return }
        command("open-batch", ["id": id, "n": Int(q.first(where: { $0.name == "n" })?.value ?? "") ?? 1])
        showWindow()
    }

    // MARK: Odkazy, okna, mikrofon, dialogy

    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler h: @escaping (WKNavigationActionPolicy) -> Void) {
        if #available(macOS 11.3, *), a.shouldPerformDownload { h(.download); return }
        if let u = a.request.url, !isLocal(u) {
            if a.targetFrame?.isMainFrame ?? true { openExternal(u) }
            h(.cancel); return  // cizí obsah ve vnořených rámech nepouštět
        }
        h(.allow)
    }
    func webView(_ w: WKWebView, decidePolicyFor r: WKNavigationResponse, decisionHandler h: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disp = (r.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if #available(macOS 11.3, *), !r.canShowMIMEType || disp.lowercased().hasPrefix("attachment") { h(.download); return }
        h(.allow)
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { openExternal(u) }  // target=_blank: do výchozího prohlížeče
        return nil
    }

    @available(macOS 12.0, *)
    func webView(_ w: WKWebView, requestMediaCapturePermissionFor o: WKSecurityOrigin, initiatedByFrame f: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler h: @escaping (WKPermissionDecision) -> Void) {
        let same = o.host == pultURL.host && o.port == (pultURL.port ?? 80) && o.protocol == (pultURL.scheme ?? "http")
        h(same && f.isMainFrame && type == .microphone ? .grant : .deny)  // jen mikrofon a jen pro Pult
    }

    // <input type=file>: vybrané soubory jdou do Pultu jako cesty (bez kopie), když je server přečte
    func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo,
                 completionHandler h: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = p.allowsMultipleSelection
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.prompt = L("Add to Pult", "Přidat na Pult")
        panel.beginSheetModal(for: window) { r in
            guard r == .OK else { h(nil); return }
            if self.addFiles(panel.urls, fromDrop: true, useInputTarget: true) { h(nil) } else { h(panel.urls.filter { !$0.hasDirectoryPath }) }
        }
    }

    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler h: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK")
        a.beginSheetModal(for: window) { _ in h() }
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler h: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK"); a.addButton(withTitle: L("Cancel", "Zrušit"))
        a.beginSheetModal(for: window) { r in h(r == .alertFirstButtonReturn) }
    }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt m: String, defaultText d: String?, initiatedByFrame f: WKFrameInfo,
                 completionHandler h: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "OK"); a.addButton(withTitle: L("Cancel", "Zrušit"))
        let t = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24)); t.stringValue = d ?? ""
        a.accessoryView = t
        a.beginSheetModal(for: window) { r in h(r == .alertFirstButtonReturn ? t.stringValue : nil) }
    }

    // MARK: Stahování do složky Stažené soubory

    @available(macOS 11.3, *)
    func webView(_ w: WKWebView, navigationAction a: WKNavigationAction, didBecome d: WKDownload) { d.delegate = self }
    @available(macOS 11.3, *)
    func webView(_ w: WKWebView, navigationResponse r: WKNavigationResponse, didBecome d: WKDownload) { d.delegate = self }
    @available(macOS 11.3, *)
    func download(_ d: WKDownload, decideDestinationUsing r: URLResponse, suggestedFilename name: String, completionHandler h: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let base = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
        var url = dir.appendingPathComponent(name), i = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = dir.appendingPathComponent(ext.isEmpty ? "\(base) \(i)" : "\(base) \(i).\(ext)"); i += 1
        }
        downloads[ObjectIdentifier(d)] = url
        h(url)
    }
    @available(macOS 11.3, *)
    func downloadDidFinish(_ d: WKDownload) {
        if let u = downloads.removeValue(forKey: ObjectIdentifier(d)) {
            DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: u.path)  // poskočí složka v Docku
            NSWorkspace.shared.activateFileViewerSelecting([u])
        }
    }
    @available(macOS 11.3, *)
    func download(_ d: WKDownload, didFailWithError e: Error, resumeData: Data?) { downloads.removeValue(forKey: ObjectIdentifier(d)) }

    // MARK: Oznámení (jen když Pult není vepředu)

    func notify(title: String, body: String, batch: String?) {
        guard !NSApp.isActive else { return }
        let c = UNUserNotificationCenter.current()
        c.requestAuthorization(options: [.alert, .sound, .badge]) { ok, _ in
            guard ok else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            if let b = batch { content.userInfo = ["batch": b]; content.threadIdentifier = b }
            c.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }
    func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler h: @escaping () -> Void) {
        if let b = r.notification.request.content.userInfo["batch"] as? String { command("open-batch", ["id": b, "n": 1]) }
        showWindow()
        h()
    }
    func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification,
                                withCompletionHandler h: @escaping (UNNotificationPresentationOptions) -> Void) { h([]) }

    // MARK: Dock

    func applicationDockMenu(_ s: NSApplication) -> NSMenu? {
        let m = NSMenu()
        m.addItem(item(L("New Batch from Files…", "Nová dávka ze souborů…"), "add-files", ""))
        let open = state.batches.prefix(8)
        if !open.isEmpty {
            m.addItem(.separator())
            for b in open { m.addItem(batchItem(b)) }
        }
        return m
    }

    // MARK: Aktualizace (pult update)

    @objc func checkForUpdates(_ s: Any?) {
        guard !updating, let p = cliProcess(["update"]) else { return }
        updating = true
        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        p.terminationHandler = { proc in
            let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            DispatchQueue.main.async {
                self.updating = false
                let updated = proc.terminationStatus == 0 && text.contains("updated")
                let a = NSAlert()
                a.messageText = proc.terminationStatus != 0 ? L("Pult could not be updated", "Pult se nepodařilo aktualizovat")
                    : updated ? L("Pult was updated", "Pult je aktualizovaný") : L("Pult is up to date", "Pult je aktuální")
                a.informativeText = String(text.trimmingCharacters(in: .whitespacesAndNewlines).suffix(1200))
                if updated { a.addButton(withTitle: L("Restart Pult", "Restartovat Pult")); a.addButton(withTitle: L("Later", "Později")) }
                a.beginSheetModal(for: self.window) { r in if updated && r == .alertFirstButtonReturn { self.relaunch() } }
            }
        }
        do { try p.run() } catch { updating = false }
    }
    func relaunch() {
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: cfg) { _, _ in
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    // MARK: Menu

    @objc func about(_ s: Any?) {
        var opts: [NSApplication.AboutPanelOptionKey: Any] = [.applicationName: "Pult"]
        if !state.version.isEmpty { opts[.applicationVersion] = state.version; opts[.version] = "" }
        let credits = NSMutableAttributedString(string: L("Image and video review for creators and their AI agents.\n",
                                                          "Revize obrázků a videí pro tvůrce a jejich AI agenty.\n"),
                                                attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor])
        credits.append(NSAttributedString(string: "github.com/jan-visual/pult",
                                          attributes: [.font: NSFont.systemFont(ofSize: 11), .link: repoURL]))
        let center = NSMutableParagraphStyle(); center.alignment = .center
        credits.addAttribute(.paragraphStyle, value: center, range: NSRange(location: 0, length: credits.length))
        opts[.credits] = credits
        NSApp.orderFrontStandardAboutPanel(options: opts)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func reload(_ s: Any?) { web.reload() }
    @objc func openInBrowser(_ s: Any?) { NSWorkspace.shared.open(web.url ?? pultURL) }
    @objc func openHelp(_ s: Any?) { NSWorkspace.shared.open(repoURL) }
    @objc func reportProblem(_ s: Any?) { NSWorkspace.shared.open(repoURL.appendingPathComponent("issues")) }
    @objc func showMainWindow(_ s: Any?) { showWindow() }
    @objc func openBatchItem(_ s: NSMenuItem) {
        if let id = s.representedObject as? String { command("open-batch", ["id": id, "n": 1]); showWindow() }
    }
    // Zpět / Znovu: při psaní platí pro text, jinak pro kresby
    @objc func pultUndo(_ s: Any?) {
        if state.typing { NSApp.sendAction(Selector(("undo:")), to: nil, from: s) } else { command("undo") }
    }
    @objc func pultRedo(_ s: Any?) {
        if state.typing { NSApp.sendAction(Selector(("redo:")), to: nil, from: s) } else { command("redo") }
    }

    func item(_ title: String, _ cmd: String, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: #selector(runCommand(_:)), keyEquivalent: key)
        i.keyEquivalentModifierMask = mods
        i.representedObject = cmd
        i.target = self
        return i
    }
    func sel(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.keyEquivalentModifierMask = mods
        i.target = target
        return i
    }
    func batchItem(_ b: (id: String, title: String)) -> NSMenuItem {
        let i = NSMenuItem(title: b.title, action: #selector(openBatchItem(_:)), keyEquivalent: "")
        i.representedObject = b.id
        i.target = self
        return i
    }
    func key(_ c: Int) -> String { String(Character(UnicodeScalar(c)!)) }

    func buildMenu() {
        let main = NSMenu()
        func sub(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let it = NSMenuItem(); let m = NSMenu(title: title)
            items.forEach { m.addItem($0) }; it.submenu = m; main.addItem(it); return m
        }
        let none: NSEvent.ModifierFlags = []
        let services = NSMenu()
        let servicesItem = NSMenuItem(title: L("Services", "Služby"), action: nil, keyEquivalent: ""); servicesItem.submenu = services
        NSApp.servicesMenu = services

        _ = sub("Pult", [
            sel(L("About Pult", "O aplikaci Pult"), #selector(about(_:)), target: self),
            sel(L("Check for Updates…", "Vyhledat aktualizace…"), #selector(checkForUpdates(_:)), target: self),
            .separator(),
            item(L("Settings…", "Nastavení…"), "settings", ","),
            .separator(),
            servicesItem,
            .separator(),
            sel(L("Hide Pult", "Skrýt Pult"), #selector(NSApplication.hide(_:)), "h"),
            sel(L("Hide Others", "Skrýt ostatní"), #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            sel(L("Show All", "Zobrazit vše"), #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            sel(L("Quit Pult", "Ukončit Pult"), #selector(NSApplication.terminate(_:)), "q"),
        ])

        let openMenu = NSMenu(title: L("Open Batch", "Otevřít dávku"))
        openMenu.delegate = self
        let openItem = NSMenuItem(title: L("Open Batch", "Otevřít dávku"), action: nil, keyEquivalent: ""); openItem.submenu = openMenu
        _ = sub(L("File", "Soubor"), [
            item(L("New Batch from Files…", "Nová dávka ze souborů…"), "add-files", "o"),
            item(L("Add Files to Batch…", "Přidat soubory do dávky…"), "add-to-batch", "o", [.command, .shift]),
            openItem,
            .separator(),
            item(L("Show Batch in Finder", "Ukázat dávku ve Finderu"), "reveal-batch", "r", [.command, .shift]),
            item(L("Open Library in Finder", "Otevřít knihovnu ve Finderu"), "reveal-library", ""),
            .separator(),
            sel(L("Close Window", "Zavřít okno"), #selector(NSWindow.performClose(_:)), "w"),
        ])

        let spelling = NSMenu(title: L("Spelling and Grammar", "Pravopis a gramatika"))
        [sel(L("Show Spelling and Grammar", "Zobrazit pravopis a gramatiku"), #selector(NSText.showGuessPanel(_:)), ":"),
         sel(L("Check Document Now", "Zkontrolovat dokument"), #selector(NSText.checkSpelling(_:)), ";"),
         sel(L("Check Spelling While Typing", "Kontrolovat pravopis při psaní"), #selector(NSTextView.toggleContinuousSpellChecking(_:)))].forEach { spelling.addItem($0) }
        let spellingItem = NSMenuItem(title: spelling.title, action: nil, keyEquivalent: ""); spellingItem.submenu = spelling
        let speech = NSMenu(title: L("Speech", "Řeč"))
        [sel(L("Start Speaking", "Začít předčítat"), #selector(NSTextView.startSpeaking(_:))),
         sel(L("Stop Speaking", "Přestat předčítat"), #selector(NSTextView.stopSpeaking(_:)))].forEach { speech.addItem($0) }
        let speechItem = NSMenuItem(title: speech.title, action: nil, keyEquivalent: ""); speechItem.submenu = speech
        _ = sub(L("Edit", "Úpravy"), [
            sel(L("Undo", "Zpět"), #selector(pultUndo(_:)), "z", target: self),
            sel(L("Redo", "Znovu"), #selector(pultRedo(_:)), "z", [.command, .shift], target: self),
            .separator(),
            sel(L("Cut", "Vyjmout"), #selector(NSText.cut(_:)), "x"),
            sel(L("Copy", "Kopírovat"), #selector(NSText.copy(_:)), "c"),
            sel(L("Paste", "Vložit"), #selector(NSText.paste(_:)), "v"),
            sel(L("Paste and Match Style", "Vložit a přizpůsobit styl"), #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
            sel(L("Delete", "Smazat"), #selector(NSText.delete(_:))),
            sel(L("Select All", "Vybrat vše"), #selector(NSText.selectAll(_:)), "a"),
            .separator(),
            item(L("Find Batch…", "Hledat dávku…"), "find", "f"),
            .separator(),
            spellingItem,
            speechItem,
        ])

        _ = sub(L("View", "Zobrazení"), [
            item(L("Hide Sidebar", "Skrýt boční panel"), "toggle-sidebar", "s", [.command, .control]),
            item(L("Hide Notes", "Skrýt připomínky"), "toggle-notes", "i", [.command, .option]),
            .separator(),
            item(L("Theater Mode", "Kino"), "theater", "f", none),
            item(L("Safe Zones", "Bezpečné zóny"), "zones", "g", none),
            .separator(),
            item(L("Zoom In", "Přiblížit"), "zoom-in", "="),
            item(L("Zoom Out", "Oddálit"), "zoom-out", "-"),
            item(L("Actual Size", "Skutečná velikost"), "zoom-reset", "0"),
            .separator(),
            sel(L("Reload", "Načíst znovu"), #selector(reload(_:)), "r", target: self),
            sel(L("Open in Browser", "Otevřít v prohlížeči"), #selector(openInBrowser(_:)), "o", [.command, .option], target: self),
            .separator(),
            sel(L("Enter Full Screen", "Celá obrazovka"), #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])

        // Klávesy bez modifikátoru: menu je ukazuje a umí je spustit kliknutím, stisk vyřizuje web
        // (macOS je menu nepošle, když se píše do textového pole).
        _ = sub(L("Playback", "Přehrávání"), [
            item(L("Play/Pause", "Přehrát/Pozastavit"), "play-pause", " ", none),
            .separator(),
            item(L("Previous Frame", "Předchozí snímek"), "frame-prev", ",", none),
            item(L("Next Frame", "Další snímek"), "frame-next", ".", none),
            item(L("Back 5 Seconds", "O 5 s zpět"), "back", key(NSLeftArrowFunctionKey), none),
            item(L("Forward 5 Seconds", "O 5 s vpřed"), "forward", key(NSRightArrowFunctionKey), none),
            item(L("Go to Start", "Na začátek"), "start", key(NSHomeFunctionKey), none),
            item(L("Go to End", "Na konec"), "end", key(NSEndFunctionKey), none),
            .separator(),
            item(L("Previous Item", "Předchozí položka"), "item-prev", key(NSUpArrowFunctionKey), none),
            item(L("Next Item", "Další položka"), "item-next", key(NSDownArrowFunctionKey), none),
            item(L("Previous Note", "Předchozí připomínka"), "note-prev", "N", none),
            item(L("Next Note", "Další připomínka"), "note-next", "n", none),
            .separator(),
            item(L("Slower", "Pomaleji"), "slower", "<", none),
            item(L("Faster", "Rychleji"), "faster", ">", none),
            item(L("Loop", "Smyčka"), "loop", "L", none),
            item(L("Stop at Notes", "Zastavovat na připomínkách"), "stop-at-notes", ""),
            item(L("Mute", "Ztlumit"), "mute", "m", none),
            .separator(),
            item(L("Play Together", "Přehrávat spolu"), "together", "t", none),
        ])

        _ = sub(L("Review", "Revize"), [
            item(L("Approve", "Schválit"), "approve", "s", none),
            item(L("Reject", "Zamítnout"), "reject", "x", none),
            .separator(),
            item(L("Comment", "Komentář"), "comment", "c", none),
            item(L("Dictate", "Diktovat"), "dictate", "d", none),
            .separator(),
            item(L("Pen", "Pero"), "tool:pen", "p", none),
            item(L("Arrow", "Šipka"), "tool:arrow", "a", none),
            item(L("Ellipse", "Kroužek"), "tool:ellipse", "o", none),
            item(L("Rectangle", "Obdélník"), "tool:rect", "r", none),
            item(L("Eraser", "Guma"), "tool:eraser", "e", none),
            item(L("Clear Frame", "Smazat kresby na snímku"), "clear-frame", key(NSBackspaceCharacter), none),
            .separator(),
            item(L("Send Review", "Odeslat revizi"), "send-review", "\r"),
        ])

        let win = sub(L("Window", "Okno"), [
            sel(L("Minimize", "Minimalizovat"), #selector(NSWindow.performMiniaturize(_:)), "m"),
            sel(L("Zoom", "Zvětšit"), #selector(NSWindow.performZoom(_:))),
            .separator(),
            sel("Pult", #selector(showMainWindow(_:)), target: self),
            .separator(),
            sel(L("Bring All to Front", "Vše do popředí"), #selector(NSApplication.arrangeInFront(_:))),
        ])
        NSApp.windowsMenu = win

        let help = sub(L("Help", "Nápověda"), [
            sel(L("Pult Help", "Nápověda k Pultu"), #selector(openHelp(_:)), target: self),
            item(L("Keyboard Shortcuts", "Klávesové zkratky"), "help", "/"),
            .separator(),
            sel(L("Report a Problem…", "Nahlásit problém…"), #selector(reportProblem(_:)), target: self),
        ])
        NSApp.helpMenu = help
        NSApp.mainMenu = main
    }

    // Podmenu „Otevřít dávku“ se plní při otevření (aktuální dávky k revizi)
    func menuNeedsUpdate(_ m: NSMenu) {
        m.removeAllItems()
        let list = state.batches
        if list.isEmpty {
            let i = NSMenuItem(title: L("Nothing to review", "Nic k revizi"), action: nil, keyEquivalent: ""); i.isEnabled = false
            m.addItem(i)
        }
        list.prefix(20).forEach { m.addItem(batchItem($0)) }
    }

    func validateMenuItem(_ i: NSMenuItem) -> Bool {
        if i.action == #selector(pultUndo(_:)) || i.action == #selector(pultRedo(_:)) { return state.ready }
        if i.action == #selector(checkForUpdates(_:)) { return !updating }
        guard i.action == #selector(runCommand(_:)), let c = i.representedObject as? String else { return true }
        let s = state
        // klávesy bez modifikátoru nesmí vzít text z pole, kam se píše
        if i.keyEquivalentModifierMask.isEmpty && !i.keyEquivalent.isEmpty && (s.typing || s.modal) { return false }
        switch c {
        case "toggle-sidebar":
            i.title = s.flag("sidebar") ? L("Hide Sidebar", "Skrýt boční panel") : L("Show Sidebar", "Zobrazit boční panel")
        case "toggle-notes":
            i.title = s.flag("notes") ? L("Hide Notes", "Skrýt připomínky") : L("Show Notes", "Zobrazit připomínky")
        case "theater": i.state = s.flag("kino") ? .on : .off
        case "loop": i.state = s.flag("loop") ? .on : .off
        case "stop-at-notes": i.state = s.flag("stopAtNotes") ? .on : .off
        case "mute": i.state = s.flag("muted") ? .on : .off
        case "together": i.state = s.flag("together") ? .on : .off
        case "play-pause": i.title = s.flag("playing") ? L("Pause", "Pozastavit") : L("Play", "Přehrát")
        default: break
        }
        if !s.ready { return false }
        switch c {
        case "add-files", "reveal-library": return s.flag("local")
        case "add-to-batch", "reveal-batch": return s.flag("local") && s.flag("batch")
        case "send-review": return s.flag("canSend")
        case "play-pause", "frame-prev", "frame-next", "back", "forward", "start", "end", "slower", "faster", "loop", "mute", "stop-at-notes", "note-prev", "note-next":
            return s.flag("video")
        case "approve", "reject", "comment", "clear-frame", "zones", "theater", "zoom-in", "zoom-out", "zoom-reset", "item-prev", "item-next":
            return s.flag("item")
        default: return true
        }
    }
}

let app = NSApplication.shared
let delegate = Pult()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
