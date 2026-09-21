import SwiftUI

struct ContentView: View {
    @State private var client = SIPClient()
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
                }
                .disabled(client.registration != .unregistered)

                Section {
                    LabeledContent("Status", value: statusText)
                    if client.registration == .unregistered {
                        Button("Register", action: register)
                            .disabled(!config.isComplete)
                    } else {
                        Button("Unregister", role: .destructive, action: client.unregister)
                    }
                    if let error {
                        Text(error).foregroundStyle(.red)
                    }
                }

                switch client.callState {
                case .idle:
                    EmptyView()
                case .ringing(let peer):
                    Section("Incoming call from \(peer)") {
                        Button("Answer", action: client.answer)
                        Button("Decline", role: .destructive, action: client.hangUp)
                    }
                case .active(let peer):
                    Section("In call with \(peer)") {
                        Button("Hang up", role: .destructive, action: client.hangUp)
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
        config.save()
        do {
            try client.register(config)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
