import AVFoundation
import Observation
import linphonesw

/// Routes a call's audio between the speakerphone and the rest of the system's outputs.
@MainActor
protocol AudioRouting: AnyObject {
    /// Whether the system is playing call audio through the built-in speaker.
    var isSpeakerActive: Bool { get }
    /// Routes audio to the speaker when `on`; otherwise to the best other output (receiver, headset, Bluetooth).
    func setSpeaker(_ on: Bool)
}

/// The speaker toggle's state, which follows the system's route.
@MainActor
@Observable
final class SpeakerRoute {
    private(set) var isOn = false
    @ObservationIgnored var routing: AudioRouting? {
        didSet { refresh() }
    }
    @ObservationIgnored private var observer: NSObjectProtocol?
    @ObservationIgnored private let notifications: NotificationCenter

    /// Follows route changes made elsewhere, such as headphones or Bluetooth connecting or the system call UI.
    init(notifications: NotificationCenter = .default) {
        self.notifications = notifications
        observer = notifications.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    deinit {
        if let observer { notifications.removeObserver(observer) }
    }

    /// Switches between the speaker and the other outputs; does nothing without a call.
    func toggle() {
        guard let routing else { return }
        let on = !isOn
        routing.setSpeaker(on)
        isOn = on
    }

    /// Adopts the system's current route.
    func refresh() {
        isOn = routing?.isSpeakerActive ?? false
    }

    /// Returns to the default route and clears the toggle.
    func reset() {
        if isOn { routing?.setSpeaker(false) }
        isOn = false
    }
}

/// What the speaker button shows for its state.
struct SpeakerPresentation: Equatable {
    let label = "Speaker"
    let identifier = "call.speaker"
    let symbol: String
    let value: String

    init(isOn: Bool) {
        symbol = isOn ? "speaker.wave.3.fill" : "speaker.wave.3"
        value = isOn ? "On" : "Off"
    }
}

/// Routes through Linphone's output audio devices, which apply the AVAudioSession override under CallKit.
@MainActor
final class LinphoneAudioRouting: AudioRouting {
    private let core: Core

    init(core: Core) { self.core = core }

    var isSpeakerActive: Bool {
        AVAudioSession.sharedInstance().currentRoute.outputs.contains { $0.portType == .builtInSpeaker }
    }

    func setSpeaker(_ on: Bool) {
        let device = core.audioDevices.first { device in
            device.hasCapability(capability: .CapabilityPlay) && (device.type == .Speaker) == on
        }
        if let device { core.outputAudioDevice = device }
    }
}
