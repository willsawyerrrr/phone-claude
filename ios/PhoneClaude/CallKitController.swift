import CallKit
import AVFoundation

/// Reports calls to CallKit and relays the user's actions in the native call UI.
final class CallKitController: NSObject, CXProviderDelegate {
    var onAnswer: (@MainActor (UUID) -> Void)?
    var onEnd: (@MainActor (UUID) -> Void)?
    var onAudioSession: (@MainActor (Bool) -> Void)?

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
        Log.callKit.notice("reportIncoming start \(id, privacy: .public)")
        provider.reportNewIncomingCall(with: id, update: update) { error in
            if let error {
                Log.callKit.error(
                    "reportIncoming failed \(id, privacy: .public): \(Self.describe(error), privacy: .public)")
            } else {
                Log.callKit.notice("reportIncoming succeeded \(id, privacy: .public)")
            }
            completion(error)
        }
    }

    func reportEnded(_ id: UUID, reason: CXCallEndedReason) {
        Log.callKit.notice("reportEnded \(id, privacy: .public) reason \(reason.rawValue, privacy: .public)")
        provider.reportCall(with: id, endedAt: nil, reason: reason)
    }

    /// Describes `error` by domain and code, naming the code if it is an incoming-call error.
    static func describe(_ error: Error) -> String {
        let nsError = error as NSError
        var text = "\(nsError.domain) \(nsError.code)"
        if nsError.domain == CXErrorDomainIncomingCall,
            let code = CXErrorCodeIncomingCallError.Code(rawValue: nsError.code)
        {
            text += " (\(name(of: code)))"
        }
        return "\(text): \(nsError.localizedDescription)"
    }

    private static func name(of code: CXErrorCodeIncomingCallError.Code) -> String {
        switch code {
        case .unknown: "unknown"
        case .unentitled: "unentitled"
        case .callUUIDAlreadyExists: "callUUIDAlreadyExists"
        case .filteredByDoNotDisturb: "filteredByDoNotDisturb"
        case .filteredByBlockList: "filteredByBlockList"
        @unknown default: "unrecognised"
        }
    }

    /// Answers `id` as though the user had in the call UI.
    func requestAnswer(_ id: UUID) {
        controller.request(CXTransaction(action: CXAnswerCallAction(call: id))) { _ in }
    }

    /// Ends `id` as though the user had in the call UI.
    func requestEnd(_ id: UUID) {
        controller.request(CXTransaction(action: CXEndCallAction(call: id))) { _ in }
    }

    func providerDidReset(_ provider: CXProvider) {
        Log.callKit.notice("provider reset")
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        Log.callKit.notice("answer action \(action.callUUID, privacy: .public)")
        MainActor.assumeIsolated { onAnswer?(action.callUUID) }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Log.callKit.notice("end action \(action.callUUID, privacy: .public)")
        MainActor.assumeIsolated { onEnd?(action.callUUID) }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        Log.callKit.notice("audio session activated")
        MainActor.assumeIsolated { onAudioSession?(true) }
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        Log.callKit.notice("audio session deactivated")
        MainActor.assumeIsolated { onAudioSession?(false) }
    }
}
