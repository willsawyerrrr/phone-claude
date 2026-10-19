import XCTest

@testable import PhoneClaude

final class DeregistrationSequenceTests: XCTestCase {
    func testRegisteredAccountDeregistersBeforeStopping() {
        var sequence = DeregistrationSequence()
        XCTAssertEqual(sequence.begin(registration: .registered), .deregister)
        XCTAssertTrue(sequence.isDeregistering)
        XCTAssertEqual(sequence.cleared(), .stop)
        XCTAssertFalse(sequence.isDeregistering)
    }

    func testRegisteringAccountDeregisters() {
        var sequence = DeregistrationSequence()
        XCTAssertEqual(sequence.begin(registration: .registering), .deregister)
    }

    func testUnregisteredAccountStopsAtOnce() {
        var sequence = DeregistrationSequence()
        XCTAssertEqual(sequence.begin(registration: .unregistered), .stop)
        XCTAssertEqual(sequence.begin(registration: .failed("x")), .stop)
        XCTAssertFalse(sequence.isDeregistering)
    }

    func testTimeoutStopsWhenNothingClears() {
        var sequence = DeregistrationSequence()
        _ = sequence.begin(registration: .registered)
        XCTAssertEqual(sequence.timedOut(), .stop)
    }

    func testStopsOnlyOnce() {
        var sequence = DeregistrationSequence()
        _ = sequence.begin(registration: .registered)
        XCTAssertEqual(sequence.cleared(), .stop)
        XCTAssertEqual(sequence.timedOut(), .none)
        XCTAssertEqual(sequence.cleared(), .none)
    }

    func testRepeatedBeginWhileDeregisteringDoesNothing() {
        var sequence = DeregistrationSequence()
        _ = sequence.begin(registration: .registered)
        XCTAssertEqual(sequence.begin(registration: .registered), .none)
    }

    func testCancelDiscardsPendingStop() {
        var sequence = DeregistrationSequence()
        _ = sequence.begin(registration: .registered)
        sequence.cancel()
        XCTAssertEqual(sequence.cleared(), .none)
        XCTAssertEqual(sequence.timedOut(), .none)
    }
}
