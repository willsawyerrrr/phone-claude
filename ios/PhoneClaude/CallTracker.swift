/// Tracks the single current call, ignoring events for any other call.
///
/// `ID` identifies a call across events.
struct CallTracker<ID: Equatable> {
    private(set) var current: ID?
    private(set) var state = SIPClient.CallState.idle

    /// Records an incoming call and returns `true`, or returns `false` if another call is in progress and
    /// this one should be declined.
    mutating func incoming(_ id: ID, from peer: String) -> Bool {
        guard current == nil else { return false }
        current = id
        state = .ringing(from: peer)
        return true
    }

    /// Marks `id` as connected, if it is the current call.
    mutating func connected(_ id: ID, with peer: String) {
        guard current == id else { return }
        state = .active(with: peer)
    }

    /// Clears the current call if `id` is it.
    mutating func ended(_ id: ID) {
        guard current == id else { return }
        reset()
    }

    mutating func reset() {
        current = nil
        state = .idle
    }
}

extension SIPClient.Registration {
    var isFailed: Bool {
        if case .failed = self { true } else { false }
    }
}
