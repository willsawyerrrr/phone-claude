import XCTest

@testable import PhoneClaude

final class CallKitCallsTests: XCTestCase {
    private let id = UUID()

    func testPushThenInviteThenAnswer() {
        var calls = CallKitCalls()
        XCTAssertTrue(calls.pushed(id))
        XCTAssertEqual(calls.inviteReceived(), .ring)
        XCTAssertEqual(calls.answered(id), .accept)
    }

    func testAnswerBeforeInviteWaitsThenAccepts() {
        var calls = CallKitCalls()
        _ = calls.pushed(id)
        XCTAssertEqual(calls.answered(id), .waitForInvite)
        XCTAssertEqual(calls.inviteReceived(), .accept)
    }

    func testInviteWithoutPushReportsNewCall() {
        var calls = CallKitCalls()
        let new = UUID()
        XCTAssertEqual(calls.inviteReceived(newID: new), .report(new))
        XCTAssertEqual(calls.current, new)
    }

    func testSecondPushIsNotTracked() {
        var calls = CallKitCalls()
        XCTAssertTrue(calls.pushed(id))
        XCTAssertFalse(calls.pushed(UUID()))
        XCTAssertEqual(calls.current, id)
    }

    func testSecondInviteIsDeclined() {
        var calls = CallKitCalls()
        _ = calls.pushed(id)
        _ = calls.inviteReceived()
        XCTAssertEqual(calls.inviteReceived(), .decline)
    }

    func testEndAfterInviteHangsUp() {
        var calls = CallKitCalls()
        _ = calls.pushed(id)
        _ = calls.inviteReceived()
        XCTAssertTrue(calls.ended(id))
        XCTAssertNil(calls.current)
    }

    func testEndBeforeInviteDeclinesTheInviteOnce() {
        var calls = CallKitCalls()
        _ = calls.pushed(id)
        XCTAssertFalse(calls.ended(id))
        XCTAssertEqual(calls.inviteReceived(), .decline)
        XCTAssertEqual(calls.inviteReceived(newID: id), .report(id))
    }

    func testNewPushClearsPendingDecline() {
        var calls = CallKitCalls()
        _ = calls.pushed(id)
        _ = calls.ended(id)
        XCTAssertTrue(calls.pushed(UUID()))
        XCTAssertEqual(calls.inviteReceived(), .ring)
    }

    func testEventsForOtherCallsAreIgnored() {
        var calls = CallKitCalls()
        _ = calls.pushed(id)
        XCTAssertNil(calls.answered(UUID()))
        XCTAssertFalse(calls.ended(UUID()))
        XCTAssertEqual(calls.current, id)
    }

    func testInviteEndedReturnsCallToEnd() {
        var calls = CallKitCalls()
        _ = calls.pushed(id)
        _ = calls.inviteReceived()
        XCTAssertEqual(calls.inviteEnded(), id)
        XCTAssertNil(calls.current)
        XCTAssertNil(calls.inviteEnded())
    }

    func testTimeoutEndsOnlyCallsWithoutInvite() {
        var calls = CallKitCalls()
        _ = calls.pushed(id)
        XCTAssertEqual(calls.timedOut(), id)
        XCTAssertNil(calls.current)

        _ = calls.pushed(id)
        _ = calls.inviteReceived()
        XCTAssertNil(calls.timedOut())
        XCTAssertEqual(calls.current, id)
    }
}
