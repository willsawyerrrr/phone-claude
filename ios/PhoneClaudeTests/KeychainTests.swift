import XCTest

@testable import PhoneClaude

final class KeychainTests: XCTestCase {
    private let account = "test.keychain-round-trip"

    override func tearDownWithError() throws {
        try Keychain.delete(account)
    }

    func testRoundTrip() throws {
        try Keychain.set("one", for: account)
        XCTAssertEqual(Keychain.get(account), "one")
        try Keychain.set("two", for: account)
        XCTAssertEqual(Keychain.get(account), "two")
    }

    func testItemsAreReadableWhileLocked() throws {
        try Keychain.set("one", for: account)
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: "dev.willsawyerrrr.phone-claude",
            kSecAttrAccount: account,
            kSecReturnAttributes: true,
        ]
        var result: AnyObject?
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &result), errSecSuccess)
        let attributes = try XCTUnwrap(result as? [CFString: Any])
        XCTAssertEqual(
            attributes[kSecAttrAccessible] as? String,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }

    func testDelete() throws {
        try Keychain.set("one", for: account)
        try Keychain.delete(account)
        XCTAssertNil(Keychain.get(account))
    }

    func testDeleteMissingItemSucceeds() throws {
        try Keychain.delete(account)
    }
}
