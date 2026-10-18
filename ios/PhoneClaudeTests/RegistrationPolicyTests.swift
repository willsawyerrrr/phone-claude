import XCTest

@testable import PhoneClaude

final class RegistrationPolicyTests: XCTestCase {
    func testStartsOnlyWhenEnabledAndNoCoreRunning() {
        XCTAssertTrue(RegistrationPolicy.shouldStart(enabled: true, coreRunning: false))
        XCTAssertFalse(RegistrationPolicy.shouldStart(enabled: true, coreRunning: true))
        XCTAssertFalse(RegistrationPolicy.shouldStart(enabled: false, coreRunning: false))
    }

    func testSuspendsOnlyWithoutAnyCall() {
        XCTAssertTrue(RegistrationPolicy.maySuspend(sipCallActive: false, callKitCallActive: false))
        XCTAssertFalse(RegistrationPolicy.maySuspend(sipCallActive: true, callKitCallActive: false))
        XCTAssertFalse(RegistrationPolicy.maySuspend(sipCallActive: false, callKitCallActive: true))
    }
}
