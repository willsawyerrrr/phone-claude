import XCTest

@testable import PhoneClaude

final class DeviceRegistrationTests: XCTestCase {
    func testHex() {
        XCTAssertEqual(DeviceRegistration.hex(Data([0x00, 0xab, 0x0f, 0xff])), "00ab0fff")
    }

    func testRequest() throws {
        let config = SIPConfig(host: "192.168.1.10", port: 5060, username: "phone", password: "secret")
        let request = try XCTUnwrap(
            DeviceRegistration.request(for: config, token: "abcd", environment: .sandbox))
        XCTAssertEqual(request.url?.absoluteString, "http://192.168.1.10:8081/device")
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
        let body = try JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: String]
        XCTAssertEqual(body, ["token": "abcd", "environment": "sandbox"])
    }

    func testRequestNeedsHostAndValidPort() {
        var config = SIPConfig()
        XCTAssertNil(DeviceRegistration.request(for: config, token: "ab", environment: .production))
        config.host = "192.168.1.10"
        config.devicePort = 0
        XCTAssertNil(DeviceRegistration.request(for: config, token: "ab", environment: .production))
    }
}
