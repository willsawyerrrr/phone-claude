# Phone Claude (iOS)

A SwiftUI SIP soft-phone that registers to the local Asterisk stack (`../local/`) as its PJSIP endpoint and answers `ask_by_phone` calls. SIP and media come from the [Linphone SDK](https://github.com/BelledonneCommunications/linphone-sdk-swift-ios) (AGPL-3.0, audio-only build), added as a Swift package.

Calls ring through CallKit, including from the lock screen. The app un-registers and stops its SIP client when backgrounded, so Asterisk sees it offline at once and `mcp-server` has the stack send a PushKit VoIP push. The app reports a CallKit call for every push, re-registers, and answers the SIP INVITE when you accept in the native call UI. Over UDP the phone must be on the LAN; over TLS it works from any network. The screen is kept awake while registered in the foreground.

## Build

Requires Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`). The Xcode project, `Info.plist` (background modes `voip` and `audio`), and entitlements (`aps-environment`) are generated from `project.yml` and not committed.

```sh
cd ios
xcodegen generate
open PhoneClaude.xcodeproj   # run on a device (push does not work on a simulator)
```

Unit tests: `xcodebuild test -project PhoneClaude.xcodeproj -scheme PhoneClaude -destination 'platform=iOS Simulator,name=<simulator>,OS=latest'`.

## Apple setup

Needs a paid Apple Developer account. Debug builds use the APNs sandbox; archived builds use production.

1. In Xcode, select the `PhoneClaude` target, Signing & Capabilities, choose your team, and make sure Push Notifications is enabled (the bundle ID `dev.willsawyerrrr.phone-claude` gets it automatically from the `aps-environment` entitlement).
2. In the developer portal (Certificates, Identifiers & Profiles, Keys), create a key with Apple Push Notifications service (APNs) enabled and download the `.p8` once. Note its Key ID and your Team ID.
3. Put the key outside the repo, make it readable by the container (`chmod 644`), and set `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_KEY_PATH` in the Environment (see [`../local/README.md`](../local/README.md#ringing-a-locked-phone)). Restart the stack.

## Pair with Asterisk

Enter the same values as for any soft-phone (see [`../local/README.md`](../local/README.md#pairing-the-soft-phone)) and tap Register:

- **Connection:** UDP (LAN) for the local stack, TLS for the cloud-hosted one; changing it moves any port still at the old default to the new one's
- **Host / port:** UDP: `HOST_LAN_IP` / `SIP_PORT` (5060). TLS: the stack's DNS name / 5061
- **Username:** `SOFTPHONE_USERNAME` (default `phone`)
- **Password:** `SOFTPHONE_PASSWORD`
- **Push registration port:** where the app sends its PushKit token: `DEVICE_PORT` (default `8081`) over `http` for UDP; over TLS, `https://<host>/device` on 443, with a port in the URL only if set to something else

UDP signalling has no TLS or SRTP: SIP and media are unencrypted, so use it on a trusted LAN only. TLS mode registers over SIP TLS with the server certificate verified (the host must be the certificate's DNS name), and requires SRTP (SDES) for media, so calls fail rather than fall back to plain RTP. `https` needs no App Transport Security exception, and `http` to a LAN IP is exempt from it. The password is stored in the Keychain (readable after first unlock, so a push can register the app while locked); the rest in `UserDefaults`. Allow Local Network and Microphone access when prompted. Answering from the banner or lock screen is handled by iOS, which may bring the app to the foreground; the app does nothing to request that and keeps the call running either way. Whenever iOS opens the app on answer (or you open it mid-call), `ContentView` shows a full-screen call screen instead of the settings form: "Claude", "Ringing" with Answer and Decline while ringing in-app, "Connecting…" once answered in CallKit until the SIP call connects, then "On a call" with a live timer, a Speaker toggle and a red End button. Speaker routes through Linphone's output audio device (which applies the AVAudioSession speaker override under CallKit); its state follows `AVAudioSession.routeChangeNotification`, so headphones, Bluetooth and the system call UI keep it in step, and the call returns to the default route when it ends. The settings form returns when the call ends. Once registered, the app registers again on launch, in the foreground, and on each push until you tap Unregister.

## Debugging push and CallKit

The app logs the push and CallKit path (`push` and `callkit` categories, subsystem `dev.willsawyerrrr.phone-claude`) at `.notice`: token updates, each push, whether its call was reported, CallKit's error domain and code (including `filteredByDoNotDisturb` and `filteredByBlockList`), and the provider's answer, end and audio-session callbacks. Tokens and credentials are never logged. Collect them from the connected device:

```sh
sudo /usr/bin/log collect --device-udid <udid> --last 10m --output x.logarchive
log show x.logarchive --predicate 'subsystem == "dev.willsawyerrrr.phone-claude"'
```

## Layout

- `PhoneClaudeApp.swift` — app entry point; creates `AppModel` at launch so a push can start the app in the background.
- `AppModel.swift` — wires `SIPClient` to PushKit and CallKit, suspends the SIP client in the background, and sends the token to the stack.
- `InviteTimer.swift` — runs the 30 s wait for a pushed call's INVITE on the main actor. `AppModel` and `SIPClient` are `@MainActor`, since they touch UIKit and observed state; PushKit, CallKit and Linphone callbacks all arrive on the main queue and enter them via `MainActor.assumeIsolated`.
- `SIPClient.swift` — wraps the Linphone `Core`: registers, tracks registration and call state, answers and hangs up. A failed registration is stopped and can be retried. The core is never stopped inside a Linphone notification: the end of a call is reported on a later main-queue turn, once the call is released.
- `RegistrationPolicy.swift` — the core is started only when none is running and never stopped or replaced while a SIP or CallKit call exists, so foregrounding mid-call leaves the call alone.
- `CodecPolicy.swift` — enables G.722 on the core and puts it ahead of PCMU and PCMA, so calls are answered with 16 kHz wideband audio when the INVITE offers it.
- `CallTracker.swift` — tracks the single current SIP call; a second incoming call is declined as busy.
- `CallKitCalls.swift` — matches a push's CallKit call to its SIP INVITE and decides what to answer, decline, or end.
- `Log.swift` — the `push` and `callkit` loggers.
- `CallKitController.swift`, `VoIPPush.swift` — thin CallKit and PushKit wrappers; CallKit activates the audio session for Linphone.
- `DeviceRegistration.swift` — builds the token registration request.
- `TransportPolicy.swift` — in TLS mode, sets the core to dial out over TLS with certificate verification and mandatory SRTP.
- `SIPConfig.swift`, `Keychain.swift` — connection settings and their persistence.
- `ContentView.swift` — settings form and registration status; shows `CallView` while a call exists.
- `SpeakerRoute.swift` — the speaker toggle's state machine, the `AudioRouting` protocol it drives, and the Linphone implementation.
- `CallView.swift`, `CallPresentation.swift` — the in-call screen, the pure mapping from call state to what it shows, and the call timer.
- `PhoneClaudeTests/` — unit tests for the above that need no device.

## TestFlight

Each push to `main` that changes `ios/` uploads a build to TestFlight (`.github/workflows/deploy-ios.yml`, using platform's `ios-testflight.yml`). The build number is the workflow run number; the marketing version is `MARKETING_VERSION` in `project.yml`. The repository needs the `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_P8` secrets.

## Simulator

Registration, ringing, answering, and playback of the spoken question work on the simulator, but PushKit tokens and VoIP pushes do not arrive. Its audio I/O can time out while a call starts and abort the app (`AURemoteIO::Initialize`); relaunch and retry, or use a device.
