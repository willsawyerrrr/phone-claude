import XCTest

@testable import PhoneClaude

final class CallTrackerTests: XCTestCase {
    func testIncomingThenConnectedThenEnded() {
        var tracker = CallTracker<Int>()
        XCTAssertTrue(tracker.incoming(1, from: "claude"))
        XCTAssertEqual(tracker.state, .ringing(from: "claude"))
        tracker.connected(1, with: "claude")
        XCTAssertEqual(tracker.state, .active(with: "claude"))
        tracker.ended(1)
        XCTAssertEqual(tracker.state, .idle)
        XCTAssertNil(tracker.current)
    }

    func testSecondIncomingCallIsRejectedAndLeavesFirstIntact() {
        var tracker = CallTracker<Int>()
        XCTAssertTrue(tracker.incoming(1, from: "a"))
        XCTAssertFalse(tracker.incoming(2, from: "b"))
        XCTAssertEqual(tracker.current, 1)
        XCTAssertEqual(tracker.state, .ringing(from: "a"))
    }

    func testEventsForOtherCallsAreIgnored() {
        var tracker = CallTracker<Int>()
        _ = tracker.incoming(1, from: "a")
        tracker.connected(2, with: "b")
        tracker.ended(2)
        XCTAssertEqual(tracker.current, 1)
        XCTAssertEqual(tracker.state, .ringing(from: "a"))
    }

    func testAcceptsNewCallAfterEnd() {
        var tracker = CallTracker<Int>()
        _ = tracker.incoming(1, from: "a")
        tracker.ended(1)
        XCTAssertTrue(tracker.incoming(2, from: "b"))
    }
}
