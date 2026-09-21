import Observation
import UIKit
import linphonesw

/// Registers with Asterisk over UDP and answers incoming calls, using the Linphone SDK for SIP and media.
///
/// Foreground only: there is no CallKit or PushKit, so incoming calls are received only while the app is
/// open. The screen is kept awake while registered.
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
    private(set) var callState = CallState.idle

    @ObservationIgnored private var core: Core?
    @ObservationIgnored private var delegate: CoreDelegateStub?
    @ObservationIgnored private var call: Call?

    /// Registers as `config`'s user, replacing any existing registration.
    func register(_ config: SIPConfig) throws {
        unregister()
        registration = .registering

        let factory = Factory.Instance
        let core = try factory.createCore(configPath: "", factoryConfigPath: "", systemContext: nil)
        core.ipv6Enabled = false

        let delegate = CoreDelegateStub(
            onCallStateChanged: { [weak self] _, call, state, _ in self?.callChanged(call, state) },
            onAccountRegistrationStateChanged: { [weak self] _, _, state, message in
                self?.registrationChanged(state, message)
            }
        )
        core.addDelegate(delegate: delegate)

        core.addAuthInfo(
            info: try factory.createAuthInfo(
                username: config.username, userid: nil, passwd: config.password,
                ha1: nil, realm: nil, domain: nil))

        let params = try core.createAccountParams()
        try params.setIdentityaddress(newValue: factory.createAddress(addr: config.identityURI))
        try params.setServeraddress(newValue: factory.createAddress(addr: config.serverURI))
        params.registerEnabled = true
        let account = try core.createAccount(params: params)
        try core.addAccount(account: account)
        core.defaultAccount = account

        try core.start()
        self.core = core
        self.delegate = delegate
        UIApplication.shared.isIdleTimerDisabled = true
    }

    func unregister() {
        core?.stop()
        core = nil
        delegate = nil
        call = nil
        callState = .idle
        registration = .unregistered
        UIApplication.shared.isIdleTimerDisabled = false
    }

    func answer() {
        try? call?.accept()
    }

    /// Declines a ringing call or ends an active one.
    func hangUp() {
        try? call?.terminate()
    }

    private func registrationChanged(_ state: RegistrationState, _ message: String) {
        switch state {
        case .Ok: registration = .registered
        case .Failed: registration = .failed(message)
        case .None, .Cleared: registration = .unregistered
        default: registration = .registering
        }
    }

    private func callChanged(_ call: Call, _ state: Call.State) {
        let peer = call.remoteAddress?.username ?? "unknown"
        switch state {
        case .IncomingReceived:
            self.call = call
            callState = .ringing(from: peer)
        case .Connected, .StreamsRunning:
            callState = .active(with: peer)
        case .End, .Error, .Released:
            self.call = nil
            callState = .idle
        default:
            break
        }
    }
}
