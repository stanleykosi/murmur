# Railway build image for the Murmur Centrifugo service.
# Railway-managed Redis is provisioned separately; this image only packages the
# Centrifugo binary and the repository's canonical server config.

FROM centrifugo/centrifugo:v6.6.2

COPY infra/centrifugo.json /centrifugo/config.json

EXPOSE 8000

# Railway injects PORT dynamically for public networking and health checks.
# We default to 8000 for local or non-Railway runs, while ensuring the runtime
# always binds to the platform-provided port in Railway.
CMD ["sh", "-lc", "centrifugo -c /centrifugo/config.json --port=${PORT:-8000}"]
