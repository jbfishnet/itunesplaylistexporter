// Native window wrapper for the Playlist Exporter web UI. Starts the local
// Node server if it isn't already running (idempotent — server.js exits
// cleanly on EADDRINUSE, see server.js's "error" handler), then loads it into
// a plain WKWebView with no browser chrome. If a LaunchAgent is already
// keeping the server running in the background (optional autostart, see
// macapp/install-autostart.sh), this is a no-op and the app just connects.
import Cocoa
import WebKit

let repoPath = "/Users/jan-boikefischer/Dev/itunesplaylistexporter"
let nodePath = "/opt/homebrew/bin/node"
let port = 4173
let serverURL = URL(string: "http://localhost:\(port)/")!

class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var retryCount = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
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
        let task = Process()
        task.executableURL = URL(fileURLWithPath: nodePath)
        task.arguments = ["server.js"]
        task.currentDirectoryURL = URL(fileURLWithPath: repoPath)
        task.environment = [
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
            "PLE_NO_OPEN": "1",
            "PORT": String(port),
        ]
        if !FileManager.default.fileExists(atPath: "/tmp/playlistexporter-app.log") {
            FileManager.default.createFile(atPath: "/tmp/playlistexporter-app.log", contents: nil)
        }
        let logHandle = FileHandle(forWritingAtPath: "/tmp/playlistexporter-app.log")
        task.standardOutput = logHandle
        task.standardError = logHandle
        try? task.run()
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
