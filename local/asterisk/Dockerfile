FROM andrius/asterisk:22

COPY templates /opt/asterisk-templates
COPY render-config.sh /usr/local/bin/render-config.sh

ENTRYPOINT ["/usr/local/bin/render-config.sh"]
CMD ["/usr/sbin/asterisk", "-vvvdddf", "-T", "-W", "-U", "asterisk", "-p"]
