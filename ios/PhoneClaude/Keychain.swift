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

    /// Readable while the phone is locked, so a VoIP push can register the app.
    private static let accessibility = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

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

    /// Stores `value`, replacing any existing item for `account`.
    static func set(_ value: String, for account: String) throws {
        let data = Data(value.utf8)
        let status = SecItemUpdate(
            query(account) as CFDictionary,
            [kSecValueData: data, kSecAttrAccessible: accessibility] as CFDictionary)
        switch status {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var q = query(account)
            q[kSecValueData] = data
            q[kSecAttrAccessible] = accessibility
            try check(SecItemAdd(q as CFDictionary, nil))
        default:
            try check(status)
        }
    }

    /// Removes the item for `account`; succeeds if there is none.
    static func delete(_ account: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        if status != errSecItemNotFound { try check(status) }
    }

    private static func check(_ status: OSStatus) throws {
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }
}

struct KeychainError: LocalizedError {
    let status: OSStatus

    var errorDescription: String? {
        let message = SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
        return "Keychain error: \(message)"
    }
}
