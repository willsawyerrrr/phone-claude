/// Orders a clean shutdown: the account un-registers (`REGISTER` with `Expires: 0`) and the core stops only
/// once that completes or times out, so Asterisk drops the contact at once rather than after its qualify fails.
struct DeregistrationSequence {
    enum Action: Equatable {
        case none
        case deregister
        case stop
    }

    /// How long to wait for the un-registration before stopping anyway.
    static let timeout: Duration = .seconds(2)

    private(set) var isDeregistering = false

    /// Starts a shutdown. A core that may have a registration at the server must un-register first.
    mutating func begin(registration: SIPClient.Registration) -> Action {
        guard !isDeregistering else { return .none }
        switch registration {
        case .registered, .registering:
            isDeregistering = true
            return .deregister
        case .unregistered, .failed:
            return .stop
        }
    }

    /// The account's registration was cleared.
    mutating func cleared() -> Action { finish() }

    /// The wait for the un-registration ran out.
    mutating func timedOut() -> Action { finish() }

    /// Abandons the shutdown, e.g. when the core is replaced or stopped directly.
    mutating func cancel() { isDeregistering = false }

    private mutating func finish() -> Action {
        guard isDeregistering else { return .none }
        isDeregistering = false
        return .stop
    }
}
