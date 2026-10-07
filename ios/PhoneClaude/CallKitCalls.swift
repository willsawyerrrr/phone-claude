import Foundation

/// Tracks the CallKit call for the single current call.
///
/// iOS requires a CallKit call to be reported for every VoIP push, and the SIP INVITE only arrives once the
/// app has re-registered, so the push and the INVITE are matched up here. Decisions are returned for the
/// caller to carry out.
struct CallKitCalls {
    enum Invite: Equatable {
        /// No push preceded the INVITE: report this new call to CallKit.
        case report(UUID)
        /// The INVITE belongs to the call a push already reported; keep ringing.
        case ring
        /// The user already answered in CallKit: answer the INVITE.
        case accept
        /// Decline the INVITE as busy.
        case decline
    }

    enum Answer: Equatable {
        case accept
        case waitForInvite
    }

    private(set) var current: UUID?
    private var hasInvite = false
    private var isAnswered = false
    private var isDeclined = false

    /// Records the call reported for a push and returns `true`, or returns `false` if a call is in progress, in
    /// which case the push's call must still be reported to CallKit and then ended.
    mutating func pushed(_ id: UUID) -> Bool {
        guard current == nil else { return false }
        reset()
        current = id
        return true
    }

    /// Matches a SIP INVITE to the current call, or starts one.
    mutating func inviteReceived(newID: UUID = UUID()) -> Invite {
        if current == nil {
            if isDeclined {
                reset()
                return .decline
            }
            current = newID
            hasInvite = true
            return .report(newID)
        }
        guard !hasInvite else { return .decline }
        hasInvite = true
        return isAnswered ? .accept : .ring
    }

    /// Records that the user answered `id` in CallKit; `nil` if `id` is not the current call.
    mutating func answered(_ id: UUID) -> Answer? {
        guard current == id else { return nil }
        isAnswered = true
        return hasInvite ? .accept : .waitForInvite
    }

    /// Records that the user ended `id` in CallKit and returns whether the SIP call must be hung up. An
    /// INVITE still to come is declined when it arrives.
    mutating func ended(_ id: UUID) -> Bool {
        guard current == id else { return false }
        let hangUp = hasInvite
        reset()
        isDeclined = !hangUp
        return hangUp
    }

    /// Clears the current call because its SIP call ended and returns the CallKit call to end, if any.
    mutating func inviteEnded() -> UUID? {
        defer { reset() }
        return current
    }

    /// Clears a call whose INVITE never arrived and returns the CallKit call to end, if any.
    mutating func timedOut() -> UUID? {
        guard !hasInvite else { return nil }
        defer { reset() }
        return current
    }

    mutating func reset() {
        current = nil
        hasInvite = false
        isAnswered = false
        isDeclined = false
    }
}
