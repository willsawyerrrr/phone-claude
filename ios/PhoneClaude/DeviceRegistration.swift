import Foundation

/// Which APNs environment a PushKit token belongs to.
enum APNsEnvironment: String {
    case sandbox
    case production

    /// Debug builds are signed for the sandbox; others for production.
    static var current: APNsEnvironment {
        #if DEBUG
            .sandbox
        #else
            .production
        #endif
    }
}

/// Delivers the PushKit token to the stack, so it knows where to send the VoIP push.
enum DeviceRegistration {
    static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// The `PUT /device` request that registers `token`, authenticated with the SIP password; `nil` if
    /// `config` has no usable host or port.
    static func request(
        for config: SIPConfig, token: String, environment: APNsEnvironment
    ) -> URLRequest? {
        guard let url = config.deviceURL else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.httpMethod = "PUT"
        request.setValue("Bearer \(config.password)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["token": token, "environment": environment.rawValue])
        return request
    }
}
