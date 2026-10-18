import CallKit
import XCTest

@testable import PhoneClaude

final class CallKitControllerTests: XCTestCase {
    func testDescribeNamesIncomingCallErrors() {
        let error = NSError(
            domain: CXErrorDomainIncomingCall, code: CXErrorCodeIncomingCallError.filteredByDoNotDisturb.rawValue)
        XCTAssertTrue(CallKitController.describe(error).contains("filteredByDoNotDisturb"))
    }

    func testDescribeOtherErrorsByDomainAndCode() {
        let error = NSError(domain: "other", code: 7)
        XCTAssertTrue(CallKitController.describe(error).hasPrefix("other 7"))
    }
}
