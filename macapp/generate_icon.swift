// Generates AppIcon.iconset/*.png at every size macOS expects, from simple
// Core Graphics drawing (no external image assets needed) — colors match the
// web UI's dark theme (public/styles.css). Run with: swift generate_icon.swift
import AppKit

let bg = NSColor(srgbRed: 0x13/255.0, green: 0x15/255.0, blue: 0x13/255.0, alpha: 1)
let accent = NSColor(srgbRed: 0xe0/255.0, green: 0x8a/255.0, blue: 0x4d/255.0, alpha: 1)

// macOS applies its own rounded-square mask + shadow to app icons, so this
// draws full-bleed square art with no pre-rounded corners of its own.
func renderIcon(size: Int) -> NSImage {
    let dim = CGFloat(size)
    let image = NSImage(size: NSSize(width: dim, height: dim))
    image.lockFocus()

    bg.setFill()
    NSBezierPath(rect: NSRect(x: 0, y: 0, width: dim, height: dim)).fill()

    let sizeConfig = NSImage.SymbolConfiguration(pointSize: dim * 0.56, weight: .semibold)
    let colorConfig = NSImage.SymbolConfiguration(paletteColors: [accent])
    let config = sizeConfig.applying(colorConfig)
    if let symbol = NSImage(systemSymbolName: "music.note", accessibilityDescription: nil)?
        .withSymbolConfiguration(config) {
        let symSize = symbol.size
        let drawRect = NSRect(
            x: (dim - symSize.width) / 2,
            y: (dim - symSize.height) / 2 - dim * 0.02,
            width: symSize.width,
            height: symSize.height
        )
        symbol.draw(in: drawRect)
    }

    image.unlockFocus()
    return image
}

func writePNG(_ image: NSImage, size: Int, to path: String) {
    let rect = NSRect(x: 0, y: 0, width: size, height: size)
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
    else { fatalError("could not create bitmap rep") }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    image.draw(in: rect)
    NSGraphicsContext.restoreGraphicsState()

    guard let data = rep.representation(using: .png, properties: [:]) else { fatalError("png encode failed") }
    try! data.write(to: URL(fileURLWithPath: path))
}

let outDir = "AppIcon.iconset"
try? FileManager.default.removeItem(atPath: outDir)
try! FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

// (base size, filename, pixel size to render at)
let specs: [(Int, String)] = [
    (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"),
]

for (px, name) in specs {
    let img = renderIcon(size: px)
    writePNG(img, size: px, to: "\(outDir)/\(name)")
    print("wrote \(outDir)/\(name) (\(px)x\(px))")
}
