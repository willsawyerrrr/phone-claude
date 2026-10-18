import os

/// Loggers for the push and CallKit path. Read them with the steps in `README.md`.
enum Log {
    private static let subsystem = "dev.willsawyerrrr.phone-claude"

    static let push = Logger(subsystem: subsystem, category: "push")
    static let callKit = Logger(subsystem: subsystem, category: "callkit")
}
