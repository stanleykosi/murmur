# Railway build image for the Murmur Centrifugo service.
# Railway-managed Redis is provisioned separately; this image only packages the
# Centrifugo binary and the repository's canonical server config.

FROM centrifugo/centrifugo:v6.6.2

COPY infra/centrifugo.json /centrifugo/config.json

EXPOSE 8080

# Railway private networking still connects to the process's real listening
# port, so Murmur standardizes Centrifugo on 8080 for both local and Railway
# deployments. Set the service-level PORT variable to 8080 in Railway so
# private-domain callers can use a stable internal URL with :8080.
CMD ["sh", "-lc", "centrifugo -c /centrifugo/config.json -p ${PORT:-8080}"]
