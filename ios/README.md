# Phone Claude (iOS)

A SwiftUI SIP soft-phone that registers to the local Asterisk stack (`../local/`) as its PJSIP endpoint and answers `ask_by_phone` calls. It replaces a third-party soft-phone (Groundwire, Linphone, Zoiper). SIP and media come from the [Linphone SDK](https://github.com/BelledonneCommunications/linphone-sdk-swift-ios) (AGPL-3.0, audio-only build), added as a Swift package.

**Foreground only.** There is no CallKit or PushKit, so calls ring only while the app is open. The screen is kept awake while registered. Background wake-up needs a VoIP push and a paid Apple Developer account.

## Build

Requires Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`). The Xcode project is generated from `project.yml` and not committed.

```sh
cd ios
xcodegen generate
open PhoneClaude.xcodeproj   # run on a simulator or device
```

Unit tests: `xcodebuild test -project PhoneClaude.xcodeproj -scheme PhoneClaude -destination 'platform=iOS Simulator,name=<simulator>'`.

## Pair with Asterisk

Enter the same values as for any soft-phone (see [`../local/README.md`](../local/README.md#pairing-the-soft-phone)) and tap Register:

- **Host / port:** `HOST_LAN_IP` / `SIP_PORT`
- **Username:** `SOFTPHONE_USERNAME` (default `phone`)
- **Password:** `SOFTPHONE_PASSWORD`

Signalling is UDP. The password is stored in the Keychain; the rest in `UserDefaults`. Allow Local Network access when prompted, or the phone can't reach Asterisk.

## Layout

- `SIPClient.swift` — wraps the Linphone `Core`: registers, tracks registration and call state, answers and hangs up.
- `SIPConfig.swift`, `Keychain.swift` — connection settings and their persistence.
- `ContentView.swift` — settings form, registration status, and answer/decline/hang-up controls.

## Simulator

Registration, ringing, answering, and playback of the spoken question work on the simulator. Its audio I/O can time out while a call starts and abort the app (`AURemoteIO::Initialize`); relaunch and retry, or use a device.
