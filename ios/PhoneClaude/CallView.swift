import SwiftUI

/// Full-screen in-call UI.
struct CallView: View {
    let presentation: CallPresentation
    let state: SIPClient.CallState
    let onAnswer: () -> Void
    let onEnd: () -> Void
    @State private var timer = CallTimer()

    var body: some View {
        VStack(spacing: 8) {
            Spacer()
            Text(presentation.caller)
                .font(.system(size: 44, weight: .semibold))
                .accessibilityIdentifier("call.caller")
            if presentation.showsTimer {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(CallTimer.format(timer.elapsed(at: context.date)))
                        .font(.title2.monospacedDigit())
                        .accessibilityLabel("On a call")
                        .accessibilityValue(CallTimer.format(timer.elapsed(at: context.date)))
                        .accessibilityIdentifier("call.timer")
                }
            } else {
                Text(presentation.status)
                    .font(.title2)
                    .accessibilityIdentifier("call.status")
            }
            Spacer()
            if presentation.showsAnswer {
                HStack(spacing: 24) {
                    button("Decline", "phone.down.fill", .red, onEnd)
                    button("Answer", "phone.fill", .green, onAnswer)
                }
            } else {
                button("End", "phone.down.fill", .red, onEnd)
            }
        }
        .foregroundStyle(.white)
        .padding(.bottom, 48)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .onChange(of: state, initial: true) { _, state in timer.update(state) }
    }

    private func button(_ title: String, _ icon: String, _ color: Color, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.largeTitle)
                    .frame(width: 80, height: 80)
                    .background(color, in: Circle())
                Text(title).font(.callout)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityIdentifier("call.\(title.lowercased())")
    }
}

#Preview("Ringing") {
    CallView(
        presentation: .of(.ringing(from: "Claude"))!, state: .ringing(from: "Claude"), onAnswer: {}, onEnd: {})
}

#Preview("Active") {
    CallView(
        presentation: .of(.active(with: "Claude"))!, state: .active(with: "Claude"), onAnswer: {}, onEnd: {})
}
