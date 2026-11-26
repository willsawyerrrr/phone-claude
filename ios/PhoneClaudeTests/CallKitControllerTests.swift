import CallKit
import XCTest

@testable import PhoneClaude

final class CallKitControllerTests: XCTestCase {
    func testDescribeNamesIncomingCallErrors() {
        let names: [(CXErrorCodeIncomingCallError.Code, String)] = [
            (.filteredByDoNotDisturb, "filteredByDoNotDisturb"),
            (.filteredDuringRestrictedSharingMode, "filteredDuringRestrictedSharingMode"),
            (.callIsProtected, "callIsProtected"),
            (.filteredBySensitiveParticipants, "filteredBySensitiveParticipants"),
        ]
        for (code, name) in names {
            let error = NSError(domain: CXErrorDomainIncomingCall, code: code.rawValue)
            XCTAssertTrue(CallKitController.describe(error).contains("(\(name))"), name)
        }
    }

    func testDescribeOtherErrorsByDomainAndCode() {
        let error = NSError(domain: "other", code: 7)
        XCTAssertTrue(CallKitController.describe(error).hasPrefix("other 7"))
    }
}
