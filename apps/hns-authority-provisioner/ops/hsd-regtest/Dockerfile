# Controlled HSD node for the T03 chain-progression harness.
# hsd 8.0.0 is the version the production observer is verified against.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g hsd@8.0.0 --unsafe-perm
EXPOSE 14037 14039
CMD ["hsd", "--network=regtest", "--http-host=0.0.0.0", "--api-key=controlled-progression", "--index-tx", "--index-address"]
