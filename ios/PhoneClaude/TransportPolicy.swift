import linphonesw

/// How the core secures signalling and media for each transport.
enum TransportPolicy {
    /// Signalling uses TLS with the server certificate verified, and media must use SRTP (SDES); over UDP the
    /// core keeps its defaults.
    ///
    /// The core only dials out, so UDP and TCP listening is off and TLS is not bound to a local port.
    static func apply(_ transport: SIPTransport, to core: Core) throws {
        guard transport == .tls else { return }
        let transports = try Factory.Instance.createTransports()
        transports.udpPort = 0
        transports.tcpPort = 0
        transports.tlsPort = -2  // LC_SIP_TRANSPORT_DONTBIND
        try core.setTransports(newValue: transports)
        core.verifyServerCertificates(yesno: true)
        core.verifyServerCn(yesno: true)
        try core.setMediaencryption(newValue: .SRTP)
        core.mediaEncryptionMandatory = true
    }
}
