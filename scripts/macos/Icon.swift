import Cocoa

// Vector artwork, rendered at each macOS icon size: a message carrying an agent spark.
let output = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        let transform = NSAffineTransform()
        transform.scale(by: CGFloat(pixels) / 1024)
        transform.concat()
        let tile = NSBezierPath(roundedRect: NSRect(x: 72, y: 72, width: 880, height: 880), xRadius: 206, yRadius: 206)
        NSGradient(starting: NSColor(calibratedRed: 0.10, green: 0.75, blue: 0.68, alpha: 1), ending: NSColor(calibratedRed: 0.06, green: 0.38, blue: 0.86, alpha: 1))!.draw(in: tile, angle: -65)
        let bubble = NSBezierPath(roundedRect: NSRect(x: 230, y: 302, width: 564, height: 442), xRadius: 140, yRadius: 140)
        NSColor.white.setFill(); bubble.fill()
        let tail = NSBezierPath()
        tail.move(to: NSPoint(x: 326, y: 362)); tail.line(to: NSPoint(x: 295, y: 235)); tail.line(to: NSPoint(x: 469, y: 325)); tail.close(); tail.fill()
        let spark = NSBezierPath()
        spark.move(to: NSPoint(x: 518, y: 665))
        spark.curve(to: NSPoint(x: 653, y: 526), controlPoint1: NSPoint(x: 547, y: 564), controlPoint2: NSPoint(x: 554, y: 555))
        spark.curve(to: NSPoint(x: 518, y: 387), controlPoint1: NSPoint(x: 554, y: 497), controlPoint2: NSPoint(x: 547, y: 488))
        spark.curve(to: NSPoint(x: 383, y: 526), controlPoint1: NSPoint(x: 489, y: 488), controlPoint2: NSPoint(x: 482, y: 497))
        spark.curve(to: NSPoint(x: 518, y: 665), controlPoint1: NSPoint(x: 482, y: 555), controlPoint2: NSPoint(x: 489, y: 564))
        NSColor(calibratedRed: 0.07, green: 0.52, blue: 0.74, alpha: 1).setFill(); spark.fill()
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(output)/icon_\(size)x\(size)\(suffix).png"))
    }
}
