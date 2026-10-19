import CallKit
import Observation
import UIKit
import os

/// Wires the SIP client to PushKit and CallKit, so calls ring from the lock screen.
///
/// While the app is in the background the SIP client is stopped, so Asterisk sees the phone as offline and
/// sends a VoIP push, which re-registers it.
@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    /// How long a pushed call waits for its INVITE before being dropped.
    private static let inviteTimeout: Duration = .seconds(30)
    private static let caller = "Claude"
    private static let tokenKey = "push.token"

    let client = SIPClient()
    private(set) var deviceError: String?

    @ObservationIgnored private let callKit = CallKitController()
    @ObservationIgnored private let push = VoIPPush()
    /// The CallKit call's phase, observable so the call screen follows it before the SIP INVITE arrives.
    private(set) var callKitPhase = CallKitCalls.Phase.none
    @ObservationIgnored private var kitCalls = CallKitCalls() {
        didSet { callKitPhase = kitCalls.phase }
    }
    @ObservationIgnored private let timeout = InviteTimer()
    @ObservationIgnored private let log = Logger(subsystem: "dev.willsawyerrrr.phone-claude", category: "app")

    private init() {
        callKit.onAnswer = { [weak self] id in self?.userAnswered(id) }
        callKit.onEnd = { [weak self] id in self?.userEnded(id) }
        callKit.onAudioSession = { [weak self] active in self?.client.activateAudioSession(active) }
        client.onIncoming = { [weak self] _ in self?.inviteReceived() }
        client.onEnded = { [weak self] in self?.callEnded() }
        push.onToken = { [weak self] token in self?.tokenUpdated(token) }
        push.onPush = { [weak self] completion in self?.pushReceived(completion) }
    }

    /// Starts registering if the user has enabled it and the settings are complete.
    func registerIfEnabled() {
        guard RegistrationPolicy.shouldStart(enabled: SIPConfig.registrationEnabled, coreRunning: client.isRunning)
        else { return }
        let config = SIPConfig.load()
        guard config.isComplete else { return }
        try? client.register(config)
        sendToken(config)
    }

    func enable(_ config: SIPConfig) throws {
        try config.save()
        if callInProgress {
            SIPConfig.registrationEnabled = true
            return
        }
        try client.register(config)
        SIPConfig.registrationEnabled = true
        sendToken(config)
    }

    func disable() {
        SIPConfig.registrationEnabled = false
        guard !callInProgress else { return }
        stopClient()
    }

    private var callInProgress: Bool {
        !RegistrationPolicy.maySuspend(sipCallActive: client.callState != .idle, callKitCallActive: kitCalls.current != nil)
    }

    /// Answers the ringing call through CallKit, so its UI stays in step.
    func answer() {
        if let id = kitCalls.current { callKit.requestAnswer(id) } else { client.answer() }
    }

    /// Declines or ends the current call through CallKit, so its UI stays in step.
    func hangUp() {
        if let id = kitCalls.current { callKit.requestEnd(id) } else { client.hangUp() }
    }

    /// Stops the SIP client while the app is in the background with no call, so the phone is offline.
    func suspendIfBackground() {
        guard UIApplication.shared.applicationState != .active, !callInProgress else { return }
        stopClient()
    }

    /// Un-registers and stops the SIP client, unless a call has appeared by the time it would stop.
    private func stopClient() {
        client.deregisterThenStop { [weak self] in self.map { !$0.callInProgress } ?? true }
    }

    // MARK: Push

    private func pushReceived(_ completion: @escaping () -> Void) {
        let id = UUID()
        let tracked = kitCalls.pushed(id)
        let enabled = SIPConfig.registrationEnabled
        let complete = SIPConfig.load().isComplete
        let canRegister = enabled && complete
        let application = UIApplication.shared
        Log.push.notice("handling push \(id, privacy: .public): tracked \(tracked, privacy: .public)")
        Log.push.notice(
            "registration enabled \(enabled, privacy: .public), config complete \(complete, privacy: .public)")
        Log.push.notice(
            "app state \(application.applicationState.rawValue, privacy: .public), protected data available \(application.isProtectedDataAvailable, privacy: .public)"
        )
        callKit.reportIncoming(id, from: Self.caller) { [weak self] error in
            completion()
            let outcome = error == nil ? "reported" : "failed"
            Log.push.notice("report outcome \(id, privacy: .public): \(outcome, privacy: .public)")
            guard let self else { return }
            if !tracked {
                callKit.reportEnded(id, reason: .failed)
            } else if error != nil {
                kitCalls.reset()
            } else if !canRegister, let id = kitCalls.timedOut() {
                callKit.reportEnded(id, reason: .failed)
            }
        }
        guard tracked, canRegister else { return }
        registerIfEnabled()
        timeout.start(after: Self.inviteTimeout) { [weak self] in
            guard let self, let id = kitCalls.timedOut() else { return }
            callKit.reportEnded(id, reason: .unanswered)
            suspendIfBackground()
        }
    }

    // MARK: SIP

    private func inviteReceived() {
        switch kitCalls.inviteReceived() {
        case .report(let id): callKit.reportIncoming(id, from: Self.caller) { _ in }
        case .ring: break
        case .accept: client.answer()
        case .decline: client.hangUp()
        }
    }

    private func callEnded() {
        timeout.cancel()
        if let id = kitCalls.inviteEnded() { callKit.reportEnded(id, reason: .remoteEnded) }
        if !SIPConfig.registrationEnabled { stopClient() }
        suspendIfBackground()
    }

    // MARK: CallKit

    private func userAnswered(_ id: UUID) {
        if kitCalls.answered(id) == .accept { client.answer() }
    }

    private func userEnded(_ id: UUID) {
        if kitCalls.ended(id) { client.hangUp() } else { suspendIfBackground() }
    }

    // MARK: Device token

    private func tokenUpdated(_ token: Data) {
        UserDefaults.standard.set(DeviceRegistration.hex(token), forKey: Self.tokenKey)
        sendToken(SIPConfig.load())
    }

    private func sendToken(_ config: SIPConfig) {
        guard let token = UserDefaults.standard.string(forKey: Self.tokenKey),
            let request = DeviceRegistration.request(
                for: config, token: token, environment: .current)
        else { return }
        Task { @MainActor [weak self] in
            do {
                let (_, response) = try await URLSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                self?.deviceError = status == 204 ? nil : "Push registration failed (\(status))"
            } catch {
                self?.deviceError = "Push registration failed: \(error.localizedDescription)"
                self?.log.error("device registration: \(error.localizedDescription)")
            }
        }
    }
}
