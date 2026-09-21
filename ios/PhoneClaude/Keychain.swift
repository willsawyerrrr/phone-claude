import Foundation
import Security

/// Minimal generic-password Keychain store.
enum Keychain {
    private static func query(_ account: String) -> [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "dev.willsawyerrrr.phone-claude",
            kSecAttrAccount: account,
        ]
    }

    static func get(_ account: String) -> String? {
        var q = query(account)
        q[kSecReturnData] = true
        q[kSecMatchLimit] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
            let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ value: String, for account: String) {
        SecItemDelete(query(account) as CFDictionary)
        var q = query(account)
        q[kSecValueData] = Data(value.utf8)
        SecItemAdd(q as CFDictionary, nil)
    }
}
