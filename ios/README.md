# Phone Claude (iOS)

A SwiftUI SIP soft-phone that registers to the local Asterisk stack (`../local/`) as its PJSIP endpoint and answers `ask_by_phone` calls. SIP and media come from the [Linphone SDK](https://github.com/BelledonneCommunications/linphone-sdk-swift-ios) (AGPL-3.0, audio-only build), added as a Swift package.

Calls ring through CallKit, including from the lock screen. The app stops its SIP client when backgrounded, so Asterisk sees it offline and `mcp-server` has the stack send a PushKit VoIP push. The app reports a CallKit call for every push, re-registers over the LAN, and answers the SIP INVITE when you accept in the native call UI. The phone must be on the LAN. The screen is kept awake while registered in the foreground.

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
3. Put the key outside the repo, make it readable by the container (`chmod 644`), and set `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_KEY_PATH` in `local/.env` (see [`../local/README.md`](../local/README.md#ringing-a-locked-phone)). Restart the stack.

## Pair with Asterisk

Enter the same values as for any soft-phone (see [`../local/README.md`](../local/README.md#pairing-the-soft-phone)) and tap Register:

- **Host / port:** `HOST_LAN_IP` / `SIP_PORT`
- **Username:** `SOFTPHONE_USERNAME` (default `phone`)
- **Password:** `SOFTPHONE_PASSWORD`
- **Push registration port:** `DEVICE_PORT` (default `8081`), where the app sends its PushKit token

Signalling is UDP, with no TLS or SRTP: SIP and media are unencrypted, so use it on a trusted LAN only. The password is stored in the Keychain (readable after first unlock, so a push can register the app while locked); the rest in `UserDefaults`. Allow Local Network and Microphone access when prompted. Once registered, the app registers again on launch, in the foreground, and on each push until you tap Unregister.

## Layout

- `PhoneClaudeApp.swift` — app entry point; creates `AppModel` at launch so a push can start the app in the background.
- `AppModel.swift` — wires `SIPClient` to PushKit and CallKit, suspends the SIP client in the background, and sends the token to the stack.
- `SIPClient.swift` — wraps the Linphone `Core`: registers, tracks registration and call state, answers and hangs up. A failed registration is stopped and can be retried.
- `CallTracker.swift` — tracks the single current SIP call; a second incoming call is declined as busy.
- `CallKitCalls.swift` — matches a push's CallKit call to its SIP INVITE and decides what to answer, decline, or end.
- `CallKitController.swift`, `VoIPPush.swift` — thin CallKit and PushKit wrappers; CallKit activates the audio session for Linphone.
- `DeviceRegistration.swift` — builds the token registration request.
- `SIPConfig.swift`, `Keychain.swift` — connection settings and their persistence.
- `ContentView.swift` — settings form, registration status, and answer/decline/hang-up controls.
- `PhoneClaudeTests/` — unit tests for the above that need no device.

## Simulator

Registration, ringing, answering, and playback of the spoken question work on the simulator, but PushKit tokens and VoIP pushes do not arrive. Its audio I/O can time out while a call starts and abort the app (`AURemoteIO::Initialize`); relaunch and retry, or use a device.
