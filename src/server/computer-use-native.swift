import AppKit
import ScreenCaptureKit
import ApplicationServices

// One helper per stdio connection. Grants and screenshot coordinates never leave memory.
@main struct Desktop {
    struct Failure: Error { let message: String }
    struct Snapshot { let pid: pid_t; let window: CGWindowID; let frame: CGRect; let width: Int; let height: Int }
    @MainActor static var grants: [String: URL] = [:]
    @MainActor static var snapshots: [String: Snapshot] = [:]
    static func consentCopy() -> [String] {
        let language = String((ProcessInfo.processInfo.environment["TIPATASK_DESKTOP_LOCALE"] ?? Locale.current.identifier).prefix(2))
        switch language {
        case "uk": return ["Дозволити цьому завданню керувати цими програмами?", "Доступ завершується після закриття з’єднання. Знімки містять лише вікно дозволеної програми.", "Відхилити", "Дозволити"]
        case "zh": return ["允许此任务控制这些应用吗？", "工具连接关闭后，访问权限失效。截图仅包含已授权应用的窗口。", "拒绝", "允许"]
        case "es": return ["¿Permitir que esta tarea controle estas aplicaciones?", "El acceso termina cuando se cierra la conexión. Las capturas contienen solo la ventana de una aplicación autorizada.", "Denegar", "Permitir"]
        default: return ["Allow this task to control these apps?", "Access ends when this tool connection closes. Screenshots contain only an approved app's window.", "Deny", "Allow"]
        }
    }

    @MainActor static func fail(_ message: String) throws -> Never { throw Failure(message: message) }
    @MainActor static func appURL(_ id: String) throws -> URL {
        let resolved = NSRunningApplication.runningApplications(withBundleIdentifier: id).first?.bundleURL
            ?? NSWorkspace.shared.urlForApplication(withBundleIdentifier: id)
        guard id != "com.tipatask.app", let url = resolved,
              let bundle = Bundle(url: url), bundle.bundleIdentifier == id else {
            try fail("Application unavailable or protected: \(id). Use an installed app's exact bundle identifier; never target the live TipATask app.")
        }
        return url.resolvingSymlinksInPath()
    }
    @MainActor static func application(_ id: String) throws -> NSRunningApplication {
        guard let approved = grants[id], try appURL(id) == approved else { try fail("Access not granted. Call request_access for this application in this session.") }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first,
              app.bundleURL?.resolvingSymlinksInPath() == approved else { try fail("Approved application is not running. Call open_application first.") }
        return app
    }
    @MainActor static func authorize(_ name: String, _ args: [String: Any]) async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["TIPATASK_DESKTOP_URL"], let url = URL(string: address),
              url.host == "127.0.0.1", url.scheme == "http", url.path == "/check",
              let token = env["TIPATASK_DESKTOP_TOKEN"], !token.isEmpty else { try fail("Computer-use session expired. Start a fresh task in the updated Task App.") }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["hook_event_name": "PreToolUse", "tool_name": "computer-use__" + name, "tool_input": args])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let verdict = try JSONSerialization.jsonObject(with: data) as? [String: Any], verdict["decision"] as? String == "allow" else { try fail("Desktop action denied by the live session permission policy. Retry after confirming the run mode.") }
    }
    @MainActor static func handle(_ name: String, _ args: [String: Any]) async throws -> [String: Any] {
        let id = args["app"] as? String ?? ""
        switch name {
        case "status":
            return ["protocol": 1, "screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
        case "request_access":
            guard let ids = args["apps"] as? [String], !ids.isEmpty, ids.count <= 8,
                  let reason = args["reason"] as? String, !reason.isEmpty, reason.count <= 500 else { try fail("Supply 1–8 exact application bundle identifiers and a short reason.") }
            var requested: [String: URL] = [:]
            for id in Set(ids) { requested[id] = try appURL(id) }
            let fresh = requested.filter { grants[$0.key] != $0.value }
            if !fresh.isEmpty {
                let alert = NSAlert()
                let copy = consentCopy()
                alert.messageText = copy[0]
                alert.informativeText = reason + "\n\n" + fresh.keys.sorted().joined(separator: "\n") + "\n\n" + copy[1]
                alert.addButton(withTitle: copy[2])
                alert.addButton(withTitle: copy[3])
                NSApplication.shared.activate(ignoringOtherApps: true)
                let timer = Timer(timeInterval: 120, repeats: false) { _ in NSApplication.shared.abortModal() }
                RunLoop.main.add(timer, forMode: .modalPanel)
                let choice = alert.runModal()
                timer.invalidate()
                alert.window.orderOut(nil)
                if choice == .alertSecondButtonReturn { for (id, url) in fresh { grants[id] = url } }
            }
            return ["granted": ids.filter { grants[$0] == requested[$0] }, "denied": ids.filter { grants[$0] != requested[$0] }, "screenshotFiltering": "single-approved-window"]
        case "list_granted_applications":
            // An app replaced at a different path loses its grant.
            grants = grants.filter { (try? appURL($0.key)) == $0.value }
            return ["apps": grants.keys.sorted(), "coordinateMode": "approved-window-pixels", "clipboardRead": false, "clipboardWrite": false, "systemKeyCombos": false]
        case "open_application":
            guard let url = grants[id], try appURL(id) == url else { try fail("Access not granted. Call request_access first.") }
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            _ = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
            return ["opened": id]
        case "screenshot":
            let app = try application(id)
            guard CGPreflightScreenCaptureAccess() else {
                _ = CGRequestScreenCaptureAccess()
                try fail("Screen Recording is unavailable. Allow this helper's hosting app in System Settings → Privacy & Security → Screen Recording, then start a fresh task run. App consent has not granted OS permission.")
            }
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            let windows = content.windows.filter { $0.owningApplication?.processID == app.processIdentifier && $0.windowLayer == 0 && $0.frame.width > 1 && $0.frame.height > 1 }
            let window: SCWindow
            if let number = args["window_id"] as? UInt32, let selected = windows.first(where: { $0.windowID == number }) { window = selected }
            else if args["window_id"] == nil, let first = windows.first { window = first }
            else { try fail("No matching visible window for the approved app. Open its window and retry.") }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let config = SCStreamConfiguration()
            config.width = Int(window.frame.width)
            config.height = Int(window.frame.height)
            config.showsCursor = false
            config.ignoreShadowsSingleWindow = true
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            try await authorize(name, args)
            guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { try fail("PNG encoding failed.") }
            snapshots[id] = Snapshot(pid: app.processIdentifier, window: window.windowID, frame: window.frame, width: image.width, height: image.height)
            return ["image": png.base64EncodedString(), "width": image.width, "height": image.height, "window_id": window.windowID, "app": id]
        case "left_click", "type":
            let app = try application(id)
            guard AXIsProcessTrusted() else {
                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                _ = AXIsProcessTrustedWithOptions(options)
                try fail("Accessibility is unavailable. Allow the hosting app in System Settings → Privacy & Security → Accessibility, then retry. App consent has not granted OS permission.")
            }
            guard let shot = snapshots[id], shot.pid == app.processIdentifier else { try fail("Take a fresh screenshot of this app before interacting; its process or tool connection changed.") }
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            guard content.windows.contains(where: { $0.windowID == shot.window && $0.owningApplication?.processID == shot.pid && $0.frame == shot.frame }) else { snapshots.removeValue(forKey: id); try fail("Window changed. Take a fresh screenshot before interacting.") }
            try await authorize(name, args)
            let application = AXUIElementCreateApplication(app.processIdentifier)
            // AX actions are addressed to the approved process and return a result. Posting
            // synthetic CGEvents to a PID can return without AppKit consuming the input.
            if name == "left_click" {
                guard let xy = args["coordinate"] as? [Double], xy.count == 2, xy.allSatisfy({ $0.isFinite }), xy[0] >= 0, xy[1] >= 0, xy[0] < Double(shot.width), xy[1] < Double(shot.height) else { try fail("Click must be inside the most recent approved-window screenshot.") }
                let point = CGPoint(x: shot.frame.minX + xy[0] * shot.frame.width / Double(shot.width), y: shot.frame.minY + xy[1] * shot.frame.height / Double(shot.height))
                var target: AXUIElement?
                guard AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &target) == .success, let element = target else { try fail("No accessible control at these app-window coordinates. Take a fresh screenshot and choose an accessible control.") }
                var pid: pid_t = 0
                guard AXUIElementGetPid(element, &pid) == .success, pid == app.processIdentifier else { try fail("Accessibility target does not belong to the approved app.") }
                var actions: CFArray?
                _ = AXUIElementCopyActionNames(element, &actions)
                if (actions as? [String] ?? []).contains(kAXPressAction as String) {
                    guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else { try fail("Approved app refused the accessibility press action.") }
                } else {
                    var settable = DarwinBoolean(false)
                    guard AXUIElementIsAttributeSettable(element, kAXFocusedAttribute as CFString, &settable) == .success, settable.boolValue,
                          AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else { try fail("This control cannot be pressed or focused through app-scoped accessibility. No global-input fallback is available.") }
                }
            } else {
                guard let text = args["text"] as? String, text.utf16.count <= 2000 else { try fail("Type accepts at most 2000 UTF-16 code units.") }
                var focused: CFTypeRef?
                guard AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
                      let raw = focused, CFGetTypeID(raw) == AXUIElementGetTypeID() else { try fail("Focus an accessible text control in the approved app first.") }
                let element = unsafeBitCast(raw, to: AXUIElement.self)
                var pid: pid_t = 0
                guard AXUIElementGetPid(element, &pid) == .success, pid == app.processIdentifier else { try fail("Focused control does not belong to the approved app.") }
                var subrole: CFTypeRef?
                _ = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subrole)
                if subrole as? String == kAXSecureTextFieldSubrole as String { try fail("Secure text fields do not support this verifiable app-scoped insertion backend.") }
                var value: CFTypeRef?
                var selected: CFTypeRef?
                var settable = DarwinBoolean(false)
                var range = CFRange()
                guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success, let existing = value as? String,
                      AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &selected) == .success,
                      let selection = selected, CFGetTypeID(selection) == AXValueGetTypeID(),
                      AXValueGetValue(unsafeBitCast(selection, to: AXValue.self), .cfRange, &range),
                      range.location >= 0, range.length >= 0, range.length <= existing.utf16.count,
                      range.location <= existing.utf16.count - range.length else { try fail("This focused control does not support verifiable app-scoped text insertion. No clipboard or global-input fallback is available.") }
                let updated = (existing as NSString).replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
                _ = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
                let result: AXError
                if settable.boolValue {
                    // Assigning the computed value avoids controls interpreting a selected-text
                    // setter as more than one insertion. Never retry an input side effect.
                    result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, updated as CFString)
                } else {
                    result = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString)
                }
                guard result == .success else { try fail("Approved app refused text insertion.") }
                var actual: CFTypeRef?
                guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &actual) == .success, actual as? String == updated else { try fail("App text did not match the requested insertion. Inspect a fresh screenshot before taking another action; input was not retried.") }
                var caret = CFRange(location: range.location + text.utf16.count, length: 0)
                if let caretValue = AXValueCreate(.cfRange, &caret) { _ = AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, caretValue) }
            }
            return ["performed": name, "app": id]
        default: try fail("Unsupported desktop action.")
        }
    }
    @MainActor static func respond(_ line: String) async {
        do {
            guard let data = line.data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? [String: Any], let name = request["name"] as? String else { try fail("Invalid request.") }
            let args = request["arguments"] as? [String: Any] ?? [:]
            if name != "status" { try await authorize(name, args) }
            let result = try await handle(name, args)
            let output = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            print(String(decoding: output, as: UTF8.self))
        } catch {
            let message = (error as? Failure)?.message ?? error.localizedDescription
            let output = try! JSONSerialization.data(withJSONObject: ["error": message])
            print(String(decoding: output, as: UTF8.self))
        }
        fflush(stdout)
    }
    @MainActor static func main() {
        guard #available(macOS 14.4, *) else { print("{\"error\":\"Computer use requires macOS 14.4 or later.\"}"); return }
        _ = NSApplication.shared
        NSApplication.shared.setActivationPolicy(.accessory)
        if CommandLine.arguments.contains("--check") { print("{\"protocol\":1}"); return }
        // AppKit must own the OS main thread. An async CLI main plus blocking readLine
        // can starve native modal timers/capture callbacks when MainActor hops queues.
        DispatchQueue.global().async {
            while let line = readLine() {
                let done = DispatchSemaphore(value: 0)
                Task { @MainActor in await respond(line); done.signal() }
                done.wait()
            }
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }
        NSApplication.shared.run()
    }
}
