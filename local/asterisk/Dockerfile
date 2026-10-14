FROM andrius/asterisk:22.10.1_debian-trixie@sha256:fa1d49e3826d3e85232e9a63bb1659a20088dabe8e41980ecc7948fb1da6efe6

COPY templates /opt/asterisk-templates
COPY render-config.sh /usr/local/bin/render-config.sh

ENTRYPOINT ["/usr/local/bin/render-config.sh"]
CMD ["/usr/sbin/asterisk", "-vvvf", "-T", "-W", "-U", "asterisk"]
