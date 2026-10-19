import AVFoundation
import XCTest

@testable import PhoneClaude

@MainActor
final class SpeakerRouteTests: XCTestCase {
    private final class FakeRouting: AudioRouting {
        var isSpeakerActive = false
        var requests: [Bool] = []
        func setSpeaker(_ on: Bool) {
            requests.append(on)
            isSpeakerActive = on
        }
    }

    private var routing: FakeRouting!
    private var route: SpeakerRoute!

    override func setUp() {
        routing = FakeRouting()
        route = SpeakerRoute(notifications: NotificationCenter())
        route.routing = routing
    }

    func testStartsOff() {
        XCTAssertFalse(route.isOn)
    }

    func testToggleSwitchesOnThenOff() {
        route.toggle()
        XCTAssertTrue(route.isOn)
        route.toggle()
        XCTAssertFalse(route.isOn)
        XCTAssertEqual(routing.requests, [true, false])
    }

    func testToggleWithoutRoutingDoesNothing() {
        route.routing = nil
        route.toggle()
        XCTAssertFalse(route.isOn)
    }

    func testRefreshFollowsExternalChange() {
        routing.isSpeakerActive = true
        route.refresh()
        XCTAssertTrue(route.isOn)
        routing.isSpeakerActive = false
        route.refresh()
        XCTAssertFalse(route.isOn)
    }

    func testRouteChangeNotificationRefreshes() {
        let center = NotificationCenter()
        let route = SpeakerRoute(notifications: center)
        route.routing = routing
        routing.isSpeakerActive = true
        center.post(name: AVAudioSession.routeChangeNotification, object: nil)
        XCTAssertTrue(route.isOn)
    }

    func testResetReturnsToDefaultRoute() {
        route.toggle()
        route.reset()
        XCTAssertFalse(route.isOn)
        XCTAssertEqual(routing.requests, [true, false])
    }

    func testResetWhenOffLeavesRouteAlone() {
        route.reset()
        XCTAssertTrue(routing.requests.isEmpty)
    }

    func testPresentationOff() {
        let p = SpeakerPresentation(isOn: false)
        XCTAssertEqual(p.value, "Off")
        XCTAssertEqual(p.symbol, "speaker.wave.3")
        XCTAssertEqual(p.label, "Speaker")
        XCTAssertEqual(p.identifier, "call.speaker")
    }

    func testPresentationOn() {
        let p = SpeakerPresentation(isOn: true)
        XCTAssertEqual(p.value, "On")
        XCTAssertEqual(p.symbol, "speaker.wave.3.fill")
    }
}
