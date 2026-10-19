import Foundation

/// What the in-call screen shows for a call state.
struct CallPresentation: Equatable {
    let caller: String
    let status: String
    let showsTimer: Bool
    let showsAnswer: Bool

    /// Whether the speaker toggle shows, which is while the call is connected.
    var showsSpeaker: Bool { showsTimer }

    /// The in-call screen for the SIP call `state` together with the CallKit call's `phase`, or `nil` when
    /// there is no call and the settings screen shows.
    static func of(
        _ state: SIPClient.CallState, callKit phase: CallKitCalls.Phase = .none, caller: String = "Claude"
    ) -> CallPresentation? {
        let ringing = CallPresentation(caller: caller, status: "Ringing", showsTimer: false, showsAnswer: true)
        let connecting = CallPresentation(caller: caller, status: "Connecting…", showsTimer: false, showsAnswer: false)
        switch (state, phase) {
        case (.active, _):
            return CallPresentation(caller: caller, status: "On a call", showsTimer: true, showsAnswer: false)
        case (.ringing, .answered), (.idle, .answered):
            return connecting
        case (.ringing, _), (.idle, .ringing):
            return ringing
        case (.idle, .none):
            return nil
        }
    }
}

/// Elapsed time of the current call, measured from when it became active.
struct CallTimer: Equatable {
    private(set) var startedAt: Date?

    /// Starts on the first active state, keeps the start while it stays active, and clears otherwise.
    mutating func update(_ state: SIPClient.CallState, now: Date = .now) {
        if case .active = state {
            startedAt = startedAt ?? now
        } else {
            startedAt = nil
        }
    }

    func elapsed(at now: Date) -> TimeInterval {
        startedAt.map { max(0, now.timeIntervalSince($0)) } ?? 0
    }

    /// `m:ss`, or `h:mm:ss` from one hour.
    static func format(_ interval: TimeInterval) -> String {
        let total = Int(max(0, interval))
        let (h, m, s) = (total / 3600, total % 3600 / 60, total % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}
