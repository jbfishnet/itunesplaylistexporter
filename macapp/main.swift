// Native window wrapper for the Playlist Exporter web UI. Starts the local
// Node server if it isn't already running (idempotent — server.js exits
// cleanly on EADDRINUSE, see server.js's "error" handler), then loads it into
// a plain WKWebView with no browser chrome. If a LaunchAgent is already
// keeping the server running in the background (optional autostart, see
// macapp/install-autostart.sh), this is a no-op and the app just connects.
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

let port = 4173
let serverURL = URL(string: "http://localhost:\(port)/")!

let appSupportDir: URL = {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Playlist Exporter", isDirectory: true)
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    return base
}()

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

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var retryCount = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMainMenu()
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

        webView = WKWebView(frame: frame)
        webView.navigationDelegate = self
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)

        NSApp.activate(ignoringOtherApps: true)

        loadServer()
    }

    /** Fire-and-forget: if the server's already up (LaunchAgent or a
     * previous launch of this app), the new process just exits(1) on
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
                message: "Playlist Exporter needs Node.js 18 or later installed to run its "
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
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:\(nodeDir)",
            "PLE_NO_OPEN": "1",
            "PORT": String(port),
            "PLE_LIBRARY_DB": appSupportDir.appendingPathComponent("library.sqlite3").path,
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

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
