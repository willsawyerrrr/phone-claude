/// Runs one action on the main actor after a delay, unless cancelled or restarted first.
@MainActor
final class InviteTimer {
    private var task: Task<Void, Never>?

    /// Cancels any pending action and schedules `action` to run after `delay`.
    func start(after delay: Duration, perform action: @escaping @MainActor () -> Void) {
        task?.cancel()
        task = Task { @MainActor in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            action()
        }
    }

    func cancel() {
        task?.cancel()
        task = nil
    }
}
