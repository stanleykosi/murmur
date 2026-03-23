# Railway build image for the Murmur Centrifugo service.
# Railway-managed Redis is provisioned separately; this image only packages the
# Centrifugo binary and the repository's canonical server config.

FROM centrifugo/centrifugo:v6.6.2

COPY infra/centrifugo.json /centrifugo/config.json

EXPOSE 8000

# Railway injects PORT dynamically for public networking and health checks.
# Centrifugo's supported HTTP port flag is `-p` / `--http_server.port`, not
# `--port`, so we bind with the documented flag and default to 8000 locally.
CMD ["sh", "-lc", "centrifugo -c /centrifugo/config.json -p ${PORT:-8000}"]
