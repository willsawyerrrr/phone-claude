import Foundation

/// How the app reaches the stack: plain UDP on the LAN, or TLS and SRTP over the internet.
enum SIPTransport: String, CaseIterable {
    case udp
    case tls

    var label: String {
        switch self {
        case .udp: "UDP (LAN)"
        case .tls: "TLS"
        }
    }
    var defaultPort: Int { self == .tls ? 5061 : 5060 }
    /// Port of the device endpoint: Caddy's HTTPS port over TLS, the pipeline's LAN port otherwise.
    var defaultDevicePort: Int { self == .tls ? 443 : 8081 }
}

/// Credentials and address of the Asterisk PJSIP endpoint the app registers as.
struct SIPConfig: Equatable {
    var host = ""
    var port = SIPTransport.udp.defaultPort
    var username = "phone"
    var password = ""
    /// Port of the stack's device-registration endpoint, which receives the PushKit token.
    var devicePort = SIPTransport.udp.defaultDevicePort
    var transport = SIPTransport.udp

    var isComplete: Bool {
        !host.isEmpty && (1...65535).contains(port) && !username.isEmpty && !password.isEmpty
    }
    var deviceURL: URL? {
        guard !host.isEmpty, (1...65535).contains(devicePort) else { return nil }
        var components = URLComponents()
        components.scheme = transport == .tls ? "https" : "http"
        components.host = host
        if devicePort != (transport == .tls ? 443 : 80) { components.port = devicePort }
        components.path = "/device"
        return components.url
    }
    var identityURI: String { "sip:\(username)@\(host)" }
    var serverURI: String { "sip:\(host):\(port);transport=\(transport.rawValue)" }

    /// Switches to `newTransport`, moving any port still at the old transport's default to the new one's.
    mutating func select(_ newTransport: SIPTransport) {
        if port == transport.defaultPort { port = newTransport.defaultPort }
        if devicePort == transport.defaultDevicePort { devicePort = newTransport.defaultDevicePort }
        transport = newTransport
    }
}

extension SIPConfig {
    private enum Key {
        static let host = "sip.host"
        static let port = "sip.port"
        static let username = "sip.username"
        static let devicePort = "sip.devicePort"
        static let transport = "sip.transport"
    }

    private static let passwordAccount = "sip.password"

    /// Reads the saved config; the password comes from the Keychain, the rest from `UserDefaults`.
    static func load() -> SIPConfig {
        let defaults = UserDefaults.standard
        var config = SIPConfig()
        config.host = defaults.string(forKey: Key.host) ?? config.host
        config.transport =
            defaults.string(forKey: Key.transport).flatMap(SIPTransport.init(rawValue:)) ?? config.transport
        config.port = defaults.object(forKey: Key.port) as? Int ?? config.port
        config.username = defaults.string(forKey: Key.username) ?? config.username
        config.devicePort = defaults.object(forKey: Key.devicePort) as? Int ?? config.devicePort
        config.password = Keychain.get(passwordAccount) ?? ""
        return config
    }

    /// Writes the config; an empty password removes the Keychain item.
    func save() throws {
        let defaults = UserDefaults.standard
        defaults.set(host, forKey: Key.host)
        defaults.set(port, forKey: Key.port)
        defaults.set(username, forKey: Key.username)
        defaults.set(devicePort, forKey: Key.devicePort)
        defaults.set(transport.rawValue, forKey: Key.transport)
        if password.isEmpty {
            try Keychain.delete(Self.passwordAccount)
        } else {
            try Keychain.set(password, for: Self.passwordAccount)
        }
    }
}

extension SIPConfig {
    private static let enabledKey = "sip.enabled"

    /// Whether the app should register whenever it can: on launch, in the foreground, and on a VoIP push.
    static var registrationEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: enabledKey) }
        set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
    }
}
