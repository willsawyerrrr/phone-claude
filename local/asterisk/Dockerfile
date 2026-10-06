FROM andrius/asterisk:22.10.1_debian-trixie@sha256:212326bd3f973a597be9e4747be5d6653802e4950159e95aa7d728e394de2012

COPY templates /opt/asterisk-templates
COPY render-config.sh /usr/local/bin/render-config.sh

ENTRYPOINT ["/usr/local/bin/render-config.sh"]
CMD ["/usr/sbin/asterisk", "-vvvf", "-T", "-W", "-U", "asterisk"]
