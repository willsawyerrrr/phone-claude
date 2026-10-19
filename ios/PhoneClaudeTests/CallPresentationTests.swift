import XCTest

@testable import PhoneClaude

final class CallPresentationTests: XCTestCase {
    func testIdleShowsSettings() {
        XCTAssertNil(CallPresentation.of(.idle))
    }

    func testRingingOffersAnswer() {
        let p = CallPresentation.of(.ringing(from: "x"))
        XCTAssertEqual(p, CallPresentation(caller: "Claude", status: "Ringing", showsTimer: false, showsAnswer: true))
    }

    func testActiveShowsTimer() {
        let p = CallPresentation.of(.active(with: "x"))
        XCTAssertEqual(p, CallPresentation(caller: "Claude", status: "On a call", showsTimer: true, showsAnswer: false))
    }
}

final class CallTimerTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1000)

    func testFormat() {
        XCTAssertEqual(CallTimer.format(0), "0:00")
        XCTAssertEqual(CallTimer.format(65.9), "1:05")
        XCTAssertEqual(CallTimer.format(600), "10:00")
        XCTAssertEqual(CallTimer.format(3661), "1:01:01")
        XCTAssertEqual(CallTimer.format(-5), "0:00")
    }

    func testStartsWhenActiveAndKeepsStart() {
        var timer = CallTimer()
        timer.update(.ringing(from: "x"), now: t0)
        XCTAssertNil(timer.startedAt)
        timer.update(.active(with: "x"), now: t0)
        timer.update(.active(with: "x"), now: t0 + 30)
        XCTAssertEqual(timer.startedAt, t0)
        XCTAssertEqual(timer.elapsed(at: t0 + 45), 45)
    }

    func testClearsWhenCallEnds() {
        var timer = CallTimer()
        timer.update(.active(with: "x"), now: t0)
        timer.update(.idle, now: t0 + 10)
        XCTAssertNil(timer.startedAt)
        XCTAssertEqual(timer.elapsed(at: t0 + 20), 0)
    }
}
