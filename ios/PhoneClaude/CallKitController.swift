import CallKit
import AVFoundation

/// Reports calls to CallKit and relays the user's actions in the native call UI.
final class CallKitController: NSObject, CXProviderDelegate {
    var onAnswer: ((UUID) -> Void)?
    var onEnd: ((UUID) -> Void)?
    var onAudioSession: ((Bool) -> Void)?

    private let provider: CXProvider
    private let controller = CXCallController()

    override init() {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = false
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: .main)
    }

    /// Shows an incoming call from `caller`; `completion` receives CallKit's error, if any.
    func reportIncoming(_ id: UUID, from caller: String, completion: @escaping (Error?) -> Void) {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: caller)
        update.localizedCallerName = caller
        update.hasVideo = false
        provider.reportNewIncomingCall(with: id, update: update, completion: completion)
    }

    func reportEnded(_ id: UUID, reason: CXCallEndedReason) {
        provider.reportCall(with: id, endedAt: nil, reason: reason)
    }

    /// Answers `id` as though the user had in the call UI.
    func requestAnswer(_ id: UUID) {
        controller.request(CXTransaction(action: CXAnswerCallAction(call: id))) { _ in }
    }

    /// Ends `id` as though the user had in the call UI.
    func requestEnd(_ id: UUID) {
        controller.request(CXTransaction(action: CXEndCallAction(call: id))) { _ in }
    }

    func providerDidReset(_ provider: CXProvider) {}

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        onAnswer?(action.callUUID)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        onEnd?(action.callUUID)
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        onAudioSession?(true)
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        onAudioSession?(false)
    }
}
