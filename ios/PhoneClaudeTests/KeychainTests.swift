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

    func testDelete() throws {
        try Keychain.set("one", for: account)
        try Keychain.delete(account)
        XCTAssertNil(Keychain.get(account))
    }

    func testDeleteMissingItemSucceeds() throws {
        try Keychain.delete(account)
    }
}
