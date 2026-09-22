import SwiftUI
import AppKit

/// Observe user scrolling, not layout-driven bounds changes. Appending a reply
/// must not disable following, and a queued layout update must not override a scroll.
struct ConversationScrollObserver: NSViewRepresentable {
    @Binding var following: Bool
    func makeNSView(context: Context) -> ScrollObservationView {
        let view = ScrollObservationView()
        view.onScroll = { following = $0 }
        return view
    }
    func updateNSView(_ view: ScrollObservationView, context: Context) {
        view.onScroll = { following = $0 }
    }
    static func dismantleNSView(_ view: ScrollObservationView, coordinator: ()) { view.detach() }
}

final class ScrollObservationView: NSView {
    var onScroll: (Bool) -> Void = { _ in }
    private weak var observedScrollView: NSScrollView?
    private var observers: [NSObjectProtocol] = []
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { detach() }
        else { DispatchQueue.main.async { [weak self] in self?.attach() } }
    }
    private func attach() {
        guard let scroll = enclosingScrollView, scroll !== observedScrollView else { return }
        detach()
        observedScrollView = scroll
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSScrollView.willStartLiveScrollNotification, object: scroll, queue: .main) { [weak self] _ in
            self?.onScroll(false)
        })
        for name in [NSScrollView.didLiveScrollNotification, NSScrollView.didEndLiveScrollNotification] {
            observers.append(center.addObserver(forName: name, object: scroll, queue: .main) { [weak self] _ in
                guard let self, let scroll = self.observedScrollView, let document = scroll.documentView else { return }
                let visible = scroll.documentVisibleRect
                let distance = document.isFlipped ? document.bounds.maxY - visible.maxY : visible.minY - document.bounds.minY
                self.onScroll(distance <= 1)
            })
        }
    }
    func detach() {
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        observedScrollView = nil
    }
    deinit { observers.forEach(NotificationCenter.default.removeObserver) }
}

struct ConversationContentHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
