FROM alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412
RUN apk add --no-cache bind-tools curl python3
COPY deploy/update-dns.sh /usr/local/bin/update-dns
COPY docker/ddns-loop.sh /usr/local/bin/ddns-loop
CMD ["/usr/local/bin/ddns-loop"]
