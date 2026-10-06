import XCTest

@testable import PhoneClaude

final class SIPConfigTests: XCTestCase {
    func testURIs() {
        let config = SIPConfig(host: "192.168.1.10", port: 5070, username: "phone", password: "secret")
        XCTAssertEqual(config.identityURI, "sip:phone@192.168.1.10")
        XCTAssertEqual(config.serverURI, "sip:192.168.1.10:5070;transport=udp")
    }

    func testIsComplete() {
        var config = SIPConfig()
        XCTAssertFalse(config.isComplete)
        config.host = "192.168.1.10"
        XCTAssertFalse(config.isComplete)
        config.password = "secret"
        XCTAssertTrue(config.isComplete)
    }

    func testIsCompleteRequiresValidPort() {
        var config = SIPConfig(host: "192.168.1.10", port: 5060, username: "phone", password: "secret")
        XCTAssertTrue(config.isComplete)
        for port in [0, -1, 65536] {
            config.port = port
            XCTAssertFalse(config.isComplete, "port \(port)")
        }
        config.port = 65535
        XCTAssertTrue(config.isComplete)
    }
}
