import Observation
import UIKit
import linphonesw

/// Registers with Asterisk over UDP and answers incoming calls, using the Linphone SDK for SIP and media.
///
/// Linphone leaves the audio session to CallKit: `activateAudioSession(_:)` must follow CallKit's
/// activation. The screen is kept awake while registered.
@MainActor
@Observable
final class SIPClient {
    enum Registration: Equatable {
        case unregistered
        case registering
        case registered
        case failed(String)
    }

    enum CallState: Equatable {
        case idle
        case ringing(from: String)
        case active(with: String)
    }

    private(set) var registration = Registration.unregistered
    private(set) var error: String?
    var callState: CallState { calls.state }
    /// Whether a core exists that is not on its way out, whatever its registration state.
    var isRunning: Bool { core != nil && !shutdown.isDeregistering }

    /// Called when an incoming call is accepted for ringing, with the caller.
    @ObservationIgnored var onIncoming: (@MainActor (String) -> Void)?
    /// Called on a later main-queue turn, outside Linphone's notification, once the current call is released.
    @ObservationIgnored var onEnded: (@MainActor () -> Void)?

    @ObservationIgnored private var core: Core?
    @ObservationIgnored private var delegate: CoreDelegateStub?
    @ObservationIgnored private var call: Call?
    @ObservationIgnored private var shutdown = DeregistrationSequence()
    @ObservationIgnored private var shutdownTimeout: Task<Void, Never>?
    @ObservationIgnored private var canStop: (@MainActor () -> Bool)?
    private var calls = CallTracker<ObjectIdentifier>()

    /// Registers as `config`'s user, replacing any existing registration.
    ///
    /// On failure the partially created core is stopped and `registration` returns to `.unregistered`.
    func register(_ config: SIPConfig) throws {
        unregister()
        registration = .registering

        let factory = Factory.Instance
        var core: Core?
        var delegate: CoreDelegateStub?
        do {
            let newCore = try factory.createCore(configPath: "", factoryConfigPath: "", systemContext: nil)
            core = newCore
            newCore.ipv6Enabled = false
            newCore.callkitEnabled = true

            let newDelegate = CoreDelegateStub(
                onCallStateChanged: { [weak self] _, call, state, _ in
                    MainActor.assumeIsolated { self?.callChanged(call, state) }
                },
                onAccountRegistrationStateChanged: { [weak self] _, _, state, message in
                    MainActor.assumeIsolated { self?.registrationChanged(state, message) }
                }
            )
            delegate = newDelegate
            newCore.addDelegate(delegate: newDelegate)

            newCore.addAuthInfo(
                info: try factory.createAuthInfo(
                    username: config.username, userid: nil, passwd: config.password,
                    ha1: nil, realm: nil, domain: nil))

            let params = try newCore.createAccountParams()
            try params.setIdentityaddress(newValue: factory.createAddress(addr: config.identityURI))
            try params.setServeraddress(newValue: factory.createAddress(addr: config.serverURI))
            params.registerEnabled = true
            let account = try newCore.createAccount(params: params)
            try newCore.addAccount(account: account)
            newCore.defaultAccount = account

            try newCore.start()
        } catch {
            if let core, let delegate { core.removeDelegate(delegate: delegate) }
            core?.stop()
            registration = .unregistered
            throw error
        }
        self.core = core
        self.delegate = delegate
        UIApplication.shared.isIdleTimerDisabled = true
    }

    /// Un-registers the account, then stops the core once Asterisk has dropped the contact or a short timeout
    /// passes, so the endpoint goes offline at once.
    ///
    /// The core is stopped on a later main-queue turn, outside Linphone's notification. If `canStop` is false by
    /// then (a call has appeared), the core is kept and registers again. A later `register(_:)` or
    /// `unregister()` supersedes the shutdown.
    func deregisterThenStop(canStop: @escaping @MainActor () -> Bool) {
        guard let core else { return }
        self.canStop = canStop
        switch shutdown.begin(registration: registration) {
        case .none: break
        case .stop: stopIfAllowed()
        case .deregister:
            setRegistrationEnabled(false, on: core)
            shutdownTimeout = Task { @MainActor [weak self] in
                try? await Task.sleep(for: DeregistrationSequence.timeout)
                guard !Task.isCancelled, let self else { return }
                handle(shutdown.timedOut())
            }
        }
    }

    /// Stops the core and returns to `.unregistered`, discarding any call and error.
    func unregister() {
        shutdown.cancel()
        shutdownTimeout?.cancel()
        shutdownTimeout = nil
        canStop = nil
        if let core, let delegate { core.removeDelegate(delegate: delegate) }
        core?.stop()
        core = nil
        delegate = nil
        call = nil
        calls.reset()
        error = nil
        registration = .unregistered
        UIApplication.shared.isIdleTimerDisabled = false
    }

    /// Tells Linphone whether CallKit has activated the audio session.
    func activateAudioSession(_ activated: Bool) {
        core?.activateAudioSession(activated: activated)
    }

    /// Answers the ringing call, recording `error` on failure.
    func answer() {
        do { try call?.accept() } catch { self.error = error.localizedDescription }
    }

    /// Declines a ringing call or ends an active one, recording `error` on failure.
    func hangUp() {
        do { try call?.terminate() } catch { self.error = error.localizedDescription }
    }

    private func handle(_ action: DeregistrationSequence.Action) {
        if action == .stop { stopIfAllowed() }
    }

    private func stopIfAllowed() {
        shutdownTimeout?.cancel()
        shutdownTimeout = nil
        if canStop?() ?? true {
            unregister()
        } else if let core {
            setRegistrationEnabled(true, on: core)
        }
        canStop = nil
    }

    private func setRegistrationEnabled(_ enabled: Bool, on core: Core) {
        guard let account = core.defaultAccount, let params = account.params?.clone() else { return }
        params.registerEnabled = enabled
        account.params = params
    }

    private func registrationChanged(_ state: RegistrationState, _ message: String) {
        if state == .Cleared || state == .None, shutdown.isDeregistering {
            // The core must not be stopped inside Linphone's own notification.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                handle(shutdown.cleared())
            }
        }
        switch state {
        case .Ok: registration = .registered
        case .Failed: registration = .failed(message)
        case .None, .Cleared: registration = .unregistered
        default: registration = .registering
        }
    }

    private func callChanged(_ call: Call, _ state: Call.State) {
        let id = ObjectIdentifier(call)
        let peer = call.remoteAddress?.username ?? "unknown"
        switch state {
        case .IncomingReceived:
            if calls.incoming(id, from: peer) {
                self.call = call
                onIncoming?(peer)
            } else {
                do { try call.decline(reason: .Busy) } catch { self.error = error.localizedDescription }
            }
        case .Connected, .StreamsRunning:
            calls.connected(id, with: peer)
        case .Released:
            // The media stream is gone only once the call is released.
            guard calls.current == id else { break }
            calls.ended(id)
            self.call = nil
            // `onEnded` may stop the core, which Linphone forbids inside its own notifications.
            DispatchQueue.main.async { [weak self] in self?.onEnded?() }
        default:
            break
        }
    }
}
