import XCTest

@testable import PhoneClaude

@MainActor
final class InviteTimerTests: XCTestCase {
    func testActionRunsOnMainThread() async {
        let timer = InviteTimer()
        let ran = expectation(description: "ran")
        var onMain = false
        timer.start(after: .milliseconds(1)) {
            onMain = Thread.isMainThread
            ran.fulfill()
        }
        await fulfillment(of: [ran], timeout: 5)
        XCTAssertTrue(onMain)
    }

    func testCancelPreventsAction() async throws {
        let timer = InviteTimer()
        var ran = false
        timer.start(after: .milliseconds(20)) { ran = true }
        timer.cancel()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertFalse(ran)
    }

    func testRestartReplacesPendingAction() async {
        let timer = InviteTimer()
        let ran = expectation(description: "ran")
        var runs: [Int] = []
        timer.start(after: .milliseconds(50)) { runs.append(1) }
        timer.start(after: .milliseconds(1)) {
            runs.append(2)
            ran.fulfill()
        }
        await fulfillment(of: [ran], timeout: 5)
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(runs, [2])
    }
}
