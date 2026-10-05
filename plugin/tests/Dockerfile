# trmnlp's image plus zbar, which the tests use to scan the QR code in each device picture.
ARG TRMNLP_IMAGE=trmnl/trmnlp:latest
FROM ${TRMNLP_IMAGE}
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends zbar-tools && rm -rf /var/lib/apt/lists/*
