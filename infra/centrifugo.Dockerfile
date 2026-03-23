# Railway build image for the Murmur Centrifugo service.
# Railway-managed Redis is provisioned separately; this image only packages the
# Centrifugo binary and the repository's canonical server config.

FROM centrifugo/centrifugo:v6.6.2

COPY infra/centrifugo.json /centrifugo/config.json

EXPOSE 8000

CMD ["centrifugo", "-c", "/centrifugo/config.json"]
