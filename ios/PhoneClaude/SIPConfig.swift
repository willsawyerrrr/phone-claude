import Foundation

/// Credentials and address of the Asterisk PJSIP endpoint the app registers as.
struct SIPConfig: Equatable {
    var host = ""
    var port = 5060
    var username = "phone"
    var password = ""

    var isComplete: Bool {
        !host.isEmpty && (1...65535).contains(port) && !username.isEmpty && !password.isEmpty
    }
    var identityURI: String { "sip:\(username)@\(host)" }
    var serverURI: String { "sip:\(host):\(port);transport=udp" }
}

extension SIPConfig {
    private enum Key {
        static let host = "sip.host"
        static let port = "sip.port"
        static let username = "sip.username"
    }

    private static let passwordAccount = "sip.password"

    /// Reads the saved config; the password comes from the Keychain, the rest from `UserDefaults`.
    static func load() -> SIPConfig {
        let defaults = UserDefaults.standard
        var config = SIPConfig()
        config.host = defaults.string(forKey: Key.host) ?? config.host
        config.port = defaults.object(forKey: Key.port) as? Int ?? config.port
        config.username = defaults.string(forKey: Key.username) ?? config.username
        config.password = Keychain.get(passwordAccount) ?? ""
        return config
    }

    /// Writes the config; an empty password removes the Keychain item.
    func save() throws {
        let defaults = UserDefaults.standard
        defaults.set(host, forKey: Key.host)
        defaults.set(port, forKey: Key.port)
        defaults.set(username, forKey: Key.username)
        if password.isEmpty {
            try Keychain.delete(Self.passwordAccount)
        } else {
            try Keychain.set(password, for: Self.passwordAccount)
        }
    }
}
