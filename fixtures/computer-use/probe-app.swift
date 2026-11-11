import AppKit

final class Probe: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var input: NSTextField!
    let output: String
    init(output: String) { self.output = output }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 600, height: 240), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Tipatask isolated desktop probe"
        input = NSTextField(frame: NSRect(x: 30, y: 120, width: 540, height: 40))
        input.placeholderString = "Type DESKTOP_OK here"
        window.contentView!.addSubview(input)
        let button = NSButton(title: "Record check", target: self, action: #selector(record))
        button.frame = NSRect(x: 30, y: 45, width: 180, height: 40)
        window.contentView!.addSubview(button)
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        try? String(ProcessInfo.processInfo.processIdentifier).write(toFile: output + ".ready", atomically: true, encoding: .utf8)
    }
    @objc func record() {
        try? input.stringValue.write(toFile: output, atomically: true, encoding: .utf8)
    }
}
let app = NSApplication.shared
let delegate = Probe(output: CommandLine.arguments[1])
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
