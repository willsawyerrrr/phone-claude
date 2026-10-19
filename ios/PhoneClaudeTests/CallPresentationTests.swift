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

final class CallPresentationCallKitTests: XCTestCase {
    func testCallKitRingingBeforeInviteShowsRinging() {
        XCTAssertEqual(CallPresentation.of(.idle, callKit: .ringing)?.status, "Ringing")
        XCTAssertEqual(CallPresentation.of(.idle, callKit: .ringing)?.showsAnswer, true)
    }

    func testCallKitAnsweredBeforeInviteShowsConnecting() {
        let p = CallPresentation.of(.idle, callKit: .answered)
        XCTAssertEqual(p, CallPresentation(caller: "Claude", status: "Connecting…", showsTimer: false, showsAnswer: false))
    }

    func testAnsweredInviteStillConnectingUntilActive() {
        XCTAssertEqual(CallPresentation.of(.ringing(from: "x"), callKit: .answered)?.status, "Connecting…")
    }

    func testSIPActiveShowsTimerWhateverCallKitSays() {
        for phase in [CallKitCalls.Phase.none, .ringing, .answered] {
            XCTAssertEqual(CallPresentation.of(.active(with: "x"), callKit: phase)?.showsTimer, true)
        }
    }

    func testEndedShowsSettings() {
        XCTAssertNil(CallPresentation.of(.idle, callKit: .none))
    }

    func testPhase() {
        var calls = CallKitCalls()
        XCTAssertEqual(calls.phase, .none)
        let id = UUID()
        _ = calls.pushed(id)
        XCTAssertEqual(calls.phase, .ringing)
        _ = calls.answered(id)
        XCTAssertEqual(calls.phase, .answered)
        calls.reset()
        XCTAssertEqual(calls.phase, .none)
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

    func testSpeakerShowsOnlyWhileConnected() {
        XCTAssertTrue(CallPresentation.of(.active(with: "x"))!.showsSpeaker)
        XCTAssertFalse(CallPresentation.of(.ringing(from: "x"))!.showsSpeaker)
        XCTAssertFalse(CallPresentation.of(.idle, callKit: .answered)!.showsSpeaker)
    }
}
