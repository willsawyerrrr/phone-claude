import XCTest
import linphonesw

@testable import PhoneClaude

final class TransportPolicyTests: XCTestCase {
    private func makeCore() throws -> Core {
        try Factory.Instance.createCore(configPath: "", factoryConfigPath: "", systemContext: nil)
    }

    func testTLSRequiresSRTPAndVerifiesCertificates() throws {
        let core = try makeCore()
        try TransportPolicy.apply(.tls, to: core)
        XCTAssertEqual(core.mediaEncryption, .SRTP)
        XCTAssertTrue(core.isMediaEncryptionMandatory)
        XCTAssertEqual(core.transports?.tlsPort, -2)
        XCTAssertEqual(core.transports?.udpPort, 0)
        XCTAssertEqual(core.transports?.tcpPort, 0)
    }

    func testUDPLeavesMediaUnencrypted() throws {
        let core = try makeCore()
        try TransportPolicy.apply(.udp, to: core)
        XCTAssertEqual(core.mediaEncryption, .None)
        XCTAssertFalse(core.isMediaEncryptionMandatory)
    }
}
