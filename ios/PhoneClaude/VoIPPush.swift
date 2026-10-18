import PushKit

/// Receives the PushKit token and VoIP pushes.
final class VoIPPush: NSObject, PKPushRegistryDelegate {
    var onToken: (@MainActor (Data) -> Void)?
    /// Called for each push; `completion` must be called once its call has been reported to CallKit.
    var onPush: (@MainActor (_ completion: @escaping () -> Void) -> Void)?

    private let registry = PKPushRegistry(queue: .main)

    override init() {
        super.init()
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
    }

    func pushRegistry(
        _ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType
    ) {
        Log.push.notice("token updated (\(pushCredentials.token.count, privacy: .public) bytes)")
        MainActor.assumeIsolated { onToken?(pushCredentials.token) }
    }

    func pushRegistry(
        _ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType, completion: @escaping () -> Void
    ) {
        Log.push.notice("push received (type \(type.rawValue, privacy: .public))")
        MainActor.assumeIsolated {
            onPush? {
                Log.push.notice("completion invoked")
                completion()
            }
        }
    }
}

extension VoIPPush {
    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        Log.push.notice("token invalidated (type \(type.rawValue, privacy: .public))")
    }
}
