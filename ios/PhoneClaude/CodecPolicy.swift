import linphonesw

/// Which audio codecs the app answers with, and in what order.
enum CodecPolicy {
    /// Mime types answered with, most preferred first: 16 kHz wideband, then narrowband fallbacks.
    static let preferred = ["G722", "PCMU", "PCMA"]

    /// Whether the codec is one the app answers with.
    static func isPreferred(_ mime: String) -> Bool {
        rank(mime) != nil
    }

    /// `mimes` with preferred codecs first in preference order; the rest keep their order.
    static func ordered(_ mimes: [String]) -> [String] {
        let ranked = mimes.enumerated().sorted { a, b in
            (rank(a.element) ?? preferred.count, a.offset) < (rank(b.element) ?? preferred.count, b.offset)
        }
        return ranked.map(\.element)
    }

    private static func rank(_ mime: String) -> Int? {
        preferred.firstIndex { $0.caseInsensitiveCompare(mime) == .orderedSame }
    }

    /// Enables the preferred codecs and puts them first in `core`'s order.
    static func apply(to core: Core) {
        let types = core.audioPayloadTypes
        for type in types where isPreferred(type.mimeType) { _ = type.enable(enabled: true) }
        let order = ordered(types.map(\.mimeType))
        var remaining = types
        core.audioPayloadTypes = order.compactMap { mime in
            remaining.firstIndex { $0.mimeType == mime }.map { remaining.remove(at: $0) }
        }
    }
}
