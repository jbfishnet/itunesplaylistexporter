// Native wrapper for the Playlist Exporter web UI. Starts the local Node server
// if it isn't already running (idempotent — server.js exits cleanly on
// EADDRINUSE), then loads it into a plain WKWebView with no browser chrome.
// The optional login LaunchAgent starts this app in menu-bar-only mode.
//
// Fully relocatable/redistributable: nothing here points at this
// developer's machine. The server's own source (server.js, src/, public/,
// node_modules) is copied into Contents/Resources/app at build time (see
// build.sh) and located here via Bundle.main, Node.js is located at launch
// by searching common install locations plus the user's shell PATH, and
// runtime data (the search index, logs) lives under this user's own
// ~/Library, never inside the app bundle itself (which isn't writable once
// installed, and would be wiped on every update/reinstall anyway).
import Cocoa
import WebKit
import UserNotifications

let port = 4173
let serverURL = URL(string: "http://localhost:\(port)/")!

let appSupportDir: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Playlist Exporter", isDirectory: true)
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    return base
}()

let acoustidKeyFile = appSupportDir.appendingPathComponent("acoustid-api-key")

let logDir: URL = {
    let base = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Logs/Playlist Exporter", isDirectory: true)
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    return base
}()

/** The bundled copy of server.js/src/public/node_modules, placed at
 * Contents/Resources/app by build.sh — not any particular developer's
 * checkout, so the built .app works unmodified on any Mac it's copied to. */
func bundledAppDir() -> URL? {
    guard let resourceURL = Bundle.main.resourceURL else { return nil }
    let dir = resourceURL.appendingPathComponent("app", isDirectory: true)
    return FileManager.default.fileExists(atPath: dir.appendingPathComponent("server.js").path) ? dir : nil
}

/** Node isn't guaranteed to be on this app's minimal PATH (it isn't launched
 * from a shell), and its install location varies by how the user got it
 * (Homebrew on Apple Silicon vs. Intel, the official installer, nvm/volta/
 * asdf, ...). Check the common fixed locations first, then fall back to
 * asking the user's own login shell to resolve it — that covers version
 * managers that only modify PATH in shell rc files. */
func findNode() -> String? {
    let commonPaths = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    for path in commonPaths where FileManager.default.isExecutableFile(atPath: path) {
        return path
    }

    let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    let task = Process()
    task.executableURL = URL(fileURLWithPath: shell)
    task.arguments = ["-l", "-c", "command -v node"]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = FileHandle.nullDevice
    do {
        try task.run()
        task.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let output, !output.isEmpty, FileManager.default.isExecutableFile(atPath: output) {
            return output
        }
    } catch {
        // fall through to nil — reported to the user by the caller
    }
    return nil
}

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate, WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var statusItem: NSStatusItem!
    var retryCount = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        let startsInBackground = CommandLine.arguments.contains("--background")
        NSApp.setActivationPolicy(startsInBackground ? .accessory : .regular)
        buildMainMenu()
        buildStatusItem()
        UNUserNotificationCenter.current().delegate = self
        startServerIfNeeded()

        let frame = NSRect(x: 0, y: 0, width: 1280, height: 840)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        window.title = "Playlist Exporter"
        window.center()
        window.minSize = NSSize(width: 860, height: 560)
        window.delegate = self
        window.isReleasedWhenClosed = false

        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "pleNotifications")
        configuration.userContentController.add(self, name: "pleRequestNotificationPermission")
        configuration.userContentController.add(self, name: "pleSaveAcoustidKey")
        webView = WKWebView(frame: frame, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.contentView = webView

        if !startsInBackground {
            showMainWindow()
        }

        loadServer()
    }

    func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "music.note.list", accessibilityDescription: "Playlist Exporter")
            button.toolTip = "Playlist Exporter"
        }
        let menu = NSMenu()
        let openItem = menu.addItem(withTitle: "Open Playlist Exporter", action: #selector(showMainWindowFromMenu), keyEquivalent: "")
        openItem.target = self
        menu.addItem(.separator())
        let quitItem = menu.addItem(withTitle: "Quit Playlist Exporter", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quitItem.target = NSApp
        statusItem.menu = menu
    }

    @objc func showMainWindowFromMenu() {
        showMainWindow()
    }

    func showMainWindow() {
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /** Fire-and-forget: if the server is already up from a previous app
     * instance, the new process just exits(1) on
     * EADDRINUSE and this is a harmless no-op. */
    func startServerIfNeeded() {
        guard let appDir = bundledAppDir() else {
            showFatalAlert(
                title: "Playlist Exporter app bundle is incomplete",
                message: "This copy of the app is missing its bundled server files "
                    + "(Contents/Resources/app). Rebuild it with macapp/build.sh."
            )
            return
        }
        guard let nodePath = findNode() else {
            showFatalAlert(
                title: "Node.js not found",
                message: "Playlist Exporter needs Node.js 24 or later installed to run its "
                    + "local server. Install it from nodejs.org or Homebrew, then reopen the app.",
                helpURL: URL(string: "https://nodejs.org/")
            )
            return
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: nodePath)
        task.arguments = ["server.js"]
        task.currentDirectoryURL = appDir
        let nodeDir = URL(fileURLWithPath: nodePath).deletingLastPathComponent().path
        task.environment = [
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:\(nodeDir)",
            "PLE_NO_OPEN": "1",
            "PORT": String(port),
            "PLE_LIBRARY_DB": appSupportDir.appendingPathComponent("library.sqlite3").path,
            "PLE_ACOUSTID_KEY_FILE": acoustidKeyFile.path,
        ]

        let logPath = logDir.appendingPathComponent("server.log").path
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }
        let logHandle = FileHandle(forWritingAtPath: logPath)
        logHandle?.seekToEndOfFile()
        task.standardOutput = logHandle
        task.standardError = logHandle
        try? task.run()
    }

    /** A problem here means the web view will just spin retrying forever
     * with nothing telling the user why — surface it immediately instead. */
    func showFatalAlert(title: String, message: String, helpURL: URL? = nil) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        if let helpURL {
            alert.addButton(withTitle: "Get Node.js")
            if alert.runModal() == .alertSecondButtonReturn {
                NSWorkspace.shared.open(helpURL)
            }
        } else {
            alert.runModal()
        }
    }

    /** No storyboard/nib means AppKit builds no menu bar at all by default —
     * without this, there's no Cmd+Q, Cmd+W, Cmd+H, no Edit menu (so no
     * Cmd+C/V in the web UI's text fields), and no About panel. */
    func buildMainMenu() {
        let appName = "Playlist Exporter"
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        appMenu.addItem(withTitle: "About \(appName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
            .keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenuItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenuItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "pleSaveAcoustidKey",
           let key = message.body as? String {
            let trimmedKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
            let success = saveAcoustidKey(trimmedKey)
            let detail = success
                ? (trimmedKey.isEmpty ? "removed" : "saved")
                : "failed"
            DispatchQueue.main.async {
                self.webView.evaluateJavaScript(
                    "window.dispatchEvent(new CustomEvent('ple:acoustid-key-result', { detail: { success: \(success), status: '\(detail)' } }))"
                )
            }
            if !success {
                NSLog("Playlist Exporter couldn't save the local AcoustID key file")
            }
            return
        }
        guard let payload = message.body as? [String: Any] else { return }
        if message.name == "pleRequestNotificationPermission" {
            requestNotificationPermission()
            return
        }
        guard message.name == "pleNotifications",
              let title = payload["title"] as? String,
              let body = payload["body"] as? String else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                NSLog("Playlist Exporter couldn't deliver a macOS notification: %@", error.localizedDescription)
            }
        }
    }

    func saveAcoustidKey(_ key: String) -> Bool {
        let fileManager = FileManager.default
        do {
            try fileManager.createDirectory(at: appSupportDir, withIntermediateDirectories: true)
            try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: appSupportDir.path)
            if key.isEmpty {
                if fileManager.fileExists(atPath: acoustidKeyFile.path) {
                    try fileManager.removeItem(at: acoustidKeyFile)
                }
            } else {
                try Data(key.utf8).write(to: acoustidKeyFile, options: .atomic)
                try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: acoustidKeyFile.path)
            }
            return true
        } catch {
            NSLog("Playlist Exporter couldn't save the local AcoustID key file: %@", error.localizedDescription)
            return false
        }
    }

    func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error {
                NSLog("Playlist Exporter notification permission request failed: %@", error.localizedDescription)
            }
            DispatchQueue.main.async {
                let result = error == nil && granted ? "true" : "false"
                self.webView.evaluateJavaScript(
                    "window.dispatchEvent(new CustomEvent('ple:notification-permission', { detail: { granted: \(result) } }))"
                )
            }
        }
    }

    func loadServer() {
        webView.load(URLRequest(url: serverURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3))
    }

    /** The server takes a brief moment to bind its port on a cold start —
     * retry a few times rather than showing WebKit's connection-refused page. */
    func retryLoad() {
        guard retryCount < 30 else { return }
        retryCount += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.loadServer() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { retryLoad() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { retryLoad() }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        NSApp.setActivationPolicy(.accessory)
        return false
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        showMainWindow()
        completionHandler()
    }

    // WKWebView has no built-in UI for window.alert/confirm/prompt — without
    // a WKUIDelegate implementing these, the web UI's confirm() calls (e.g.
    // "Delete playlist…", "Delete All Duplicates") have no native panel to
    // show at all and just silently fail every time, with nothing visibly
    // wrong to the user beyond "the button doesn't do anything". These three
    // methods are the fix: a plain NSAlert standing in for the browser panel
    // that a real browser tab would have shown for free.
    func webView(
        _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(
        _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = prompt
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
