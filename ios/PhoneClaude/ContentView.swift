import SwiftUI

struct ContentView: View {
    private var client: SIPClient { model.client }
    @State private var model = AppModel.shared
    @State private var config = SIPConfig.load()
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("Host", text: $config.host)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    TextField("Port", value: $config.port, format: .number.grouping(.never))
                        .keyboardType(.numberPad)
                    TextField("Username", text: $config.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $config.password)
                    TextField("Push registration port", value: $config.devicePort, format: .number.grouping(.never))
                        .keyboardType(.numberPad)
                }
                .disabled(client.registration != .unregistered)

                Section {
                    LabeledContent("Status", value: statusText)
                    if client.registration == .unregistered {
                        Button("Register", action: register)
                            .disabled(!config.isComplete)
                    } else {
                        Button(
                            client.registration.isFailed ? "Retry" : "Unregister",
                            role: client.registration.isFailed ? nil : .destructive,
                            action: client.registration.isFailed ? register : model.disable)
                    }
                    if let error = error ?? client.error ?? model.deviceError {
                        Text(error).foregroundStyle(.red)
                    }
                }

                switch client.callState {
                case .idle:
                    EmptyView()
                case .ringing(let peer):
                    Section("Incoming call from \(peer)") {
                        Button("Answer", action: model.answer)
                        Button("Decline", role: .destructive, action: model.hangUp)
                    }
                case .active(let peer):
                    Section("In call with \(peer)") {
                        Button("Hang up", role: .destructive, action: model.hangUp)
                    }
                }
            }
            .navigationTitle("Phone Claude")
        }
    }

    private var statusText: String {
        switch client.registration {
        case .unregistered: "Not registered"
        case .registering: "Registering…"
        case .registered: "Registered"
        case .failed(let message): "Failed: \(message)"
        }
    }

    private func register() {
        error = nil
        do {
            try model.enable(config)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
