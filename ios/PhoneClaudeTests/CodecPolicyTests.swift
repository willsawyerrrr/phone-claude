import XCTest

@testable import PhoneClaude

final class CodecPolicyTests: XCTestCase {
    func testPrefersG722ThenUlawThenAlaw() {
        XCTAssertEqual(
            CodecPolicy.ordered(["opus", "PCMA", "telephone-event", "PCMU", "G722"]),
            ["G722", "PCMU", "PCMA", "opus", "telephone-event"])
    }

    func testMatchesMimeTypesCaseInsensitively() {
        XCTAssertTrue(CodecPolicy.isPreferred("g722"))
        XCTAssertTrue(CodecPolicy.isPreferred("pcmu"))
        XCTAssertFalse(CodecPolicy.isPreferred("opus"))
    }

    func testKeepsOtherCodecsInOrder() {
        XCTAssertEqual(CodecPolicy.ordered(["speex", "opus", "G722"]), ["G722", "speex", "opus"])
    }
}
