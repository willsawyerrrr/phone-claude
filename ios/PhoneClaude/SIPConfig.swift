import Foundation

/// Credentials and address of the Asterisk PJSIP endpoint the app registers as.
struct SIPConfig: Equatable {
    var host = ""
    var port = 5060
    var username = "phone"
    var password = ""

    var isComplete: Bool { !host.isEmpty && !username.isEmpty && !password.isEmpty }
    var identityURI: String { "sip:\(username)@\(host)" }
    var serverURI: String { "sip:\(host):\(port);transport=udp" }
}

extension SIPConfig {
    private enum Key {
        static let host = "sip.host"
        static let port = "sip.port"
        static let username = "sip.username"
        static let password = "sip.password"
    }

    /// Reads the saved config; the password comes from the Keychain, the rest from `UserDefaults`.
    static func load() -> SIPConfig {
        let defaults = UserDefaults.standard
        var config = SIPConfig()
        config.host = defaults.string(forKey: Key.host) ?? config.host
        config.port = defaults.object(forKey: Key.port) as? Int ?? config.port
        config.username = defaults.string(forKey: Key.username) ?? config.username
        config.password = Keychain.get(Key.password) ?? ""
        return config
    }

    func save() {
        let defaults = UserDefaults.standard
        defaults.set(host, forKey: Key.host)
        defaults.set(port, forKey: Key.port)
        defaults.set(username, forKey: Key.username)
        Keychain.set(password, for: Key.password)
    }
}
