/// Decides when the SIP core may be started or replaced.
enum RegistrationPolicy {
    /// Whether to start a core on launch, foreground or push: only when registration is enabled and no core
    /// is running, so repeated triggers never restart a core.
    static func shouldStart(enabled: Bool, coreRunning: Bool) -> Bool {
        enabled && !coreRunning
    }

    /// Whether a running core may be stopped or replaced: never while a SIP call or CallKit call exists.
    static func maySuspend(sipCallActive: Bool, callKitCallActive: Bool) -> Bool {
        !sipCallActive && !callKitCallActive
    }
}
