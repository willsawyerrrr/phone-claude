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

    func testTLSURIs() {
        let config = SIPConfig(
            host: "phone.example.com", port: 5061, username: "phone", password: "secret", transport: .tls)
        XCTAssertEqual(config.identityURI, "sip:phone@phone.example.com")
        XCTAssertEqual(config.serverURI, "sip:phone.example.com:5061;transport=tls")
    }

    func testDeviceURLOverUDPNamesThePort() {
        let config = SIPConfig(host: "192.168.1.10")
        XCTAssertEqual(config.deviceURL?.absoluteString, "http://192.168.1.10:8081/device")
    }

    func testDeviceURLOverTLSIsHTTPSWithoutPort() {
        var config = SIPConfig(host: "phone.example.com")
        config.select(.tls)
        XCTAssertEqual(config.deviceURL?.absoluteString, "https://phone.example.com/device")
        config.devicePort = 8443
        XCTAssertEqual(config.deviceURL?.absoluteString, "https://phone.example.com:8443/device")
    }

    func testSelectMovesDefaultPorts() {
        var config = SIPConfig()
        config.select(.tls)
        XCTAssertEqual(config.transport, .tls)
        XCTAssertEqual(config.port, 5061)
        XCTAssertEqual(config.devicePort, 443)
        config.select(.udp)
        XCTAssertEqual(config.port, 5060)
        XCTAssertEqual(config.devicePort, 8081)
    }

    func testSelectKeepsCustomPorts() {
        var config = SIPConfig(port: 5070, devicePort: 9000)
        config.select(.tls)
        XCTAssertEqual(config.port, 5070)
        XCTAssertEqual(config.devicePort, 9000)
    }

    func testSaveAndLoadRoundTripsTransport() throws {
        let saved = SIPConfig.load()
        defer { try? saved.save() }
        var config = SIPConfig(host: "phone.example.com", password: "secret")
        config.select(.tls)
        try config.save()
        XCTAssertEqual(SIPConfig.load(), config)
    }
}
