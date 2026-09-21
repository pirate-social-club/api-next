# Controlled HSD node for the T03 chain-progression harness.
# hsd 8.0.0 is the version the production observer is verified against.
FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/hsd-regtest
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --unsafe-perm
EXPOSE 14037 14039
CMD ["node", "node_modules/hsd/bin/hsd", "--network=regtest", "--http-host=0.0.0.0", "--api-key=controlled-progression", "--index-tx", "--index-address"]
