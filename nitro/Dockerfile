FROM golang:1.26@sha256:e30143be198ab04cf7ba25fba83ab3a692ca584c994aad0bf131fa0eb32dd8c1 AS veil-builder

ARG VEIL_COMMIT=2b8c06ca651e09b21832f6fc4ae2605371386f76
RUN git init /src/veil \
    && git -C /src/veil remote add origin https://github.com/Amnesic-Systems/veil.git \
    && git -C /src/veil fetch --depth=1 origin "${VEIL_COMMIT}" \
    && git -C /src/veil checkout --detach FETCH_HEAD \
    && test "$(git -C /src/veil rev-parse HEAD)" = "${VEIL_COMMIT}"

RUN CGO_ENABLED=0 go build -C /src/veil/cmd/veil-daemon -trimpath -ldflags="-s -w" -buildvcs=false \
    && CGO_ENABLED=0 go build -C /src/veil/cmd/veil-proxy -trimpath -ldflags="-s -w" -buildvcs=false \
    && CGO_ENABLED=0 go build -C /src/veil/cmd/veil-verify -trimpath -ldflags="-s -w" -buildvcs=false \
    && mkdir -p /out/licenses \
    && cp /src/veil/cmd/veil-daemon/veil-daemon /out/ \
    && cp /src/veil/cmd/veil-proxy/veil-proxy /out/ \
    && cp /src/veil/cmd/veil-verify/veil-verify /out/ \
    && cp /src/veil/LICENSE /out/licenses/veil-GPL-3.0.txt

FROM scratch AS veil-tools
COPY --from=veil-builder /out/veil-proxy /veil-proxy
COPY --from=veil-builder /out/veil-verify /veil-verify
COPY --from=veil-builder /out/licenses /licenses

FROM golang:1.26@sha256:e30143be198ab04cf7ba25fba83ab3a692ca584c994aad0bf131fa0eb32dd8c1 AS plugin-builder

ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY cmd ./cmd
RUN mkdir -p /out \
    && target_arch="${TARGETARCH:-$(go env GOARCH)}" \
    && CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${target_arch}" \
       go build -mod=readonly -trimpath -o /out/spiral-safe ./cmd/spiral-safe

FROM hashicorp/vault:1.21.4@sha256:4e33b126a59c0c333b76fb4e894722462659a6bec7c48c9ee8cea56fccfd2569

ARG VEIL_COMMIT=2b8c06ca651e09b21832f6fc4ae2605371386f76
ARG SPIRAL_SAFE_REVISION=workspace
ARG VEIL_FQDN=spiral-safe.invalid
ARG WEBAUTHN_RP_ID=localhost
ARG WEBAUTHN_RP_ORIGINS=http://localhost:9080

LABEL org.opencontainers.image.source="https://github.com/Spiral-Safe/services" \
      org.opencontainers.image.revision="${SPIRAL_SAFE_REVISION}" \
      org.opencontainers.image.licenses="BUSL-1.1 AND Apache-2.0 AND GPL-3.0-only" \
      org.opencontainers.image.vendor="Spiral Safe" \
      org.opencontainers.image.description="Spiral Safe Vault plugin wrapped by Veil for AWS Nitro Enclaves" \
      org.spiral-safe.veil.source="https://github.com/Amnesic-Systems/veil" \
      org.spiral-safe.veil.revision="${VEIL_COMMIT}"

ENV VEIL_FQDN="${VEIL_FQDN}" \
    VEIL_SOURCE_URI="https://github.com/Spiral-Safe/services" \
    VAULT_ADDR="http://127.0.0.1:8200" \
    WEBAUTHN_RP_ID="${WEBAUTHN_RP_ID}" \
    WEBAUTHN_RP_ORIGINS="${WEBAUTHN_RP_ORIGINS}"

USER root
COPY --from=veil-builder /out/veil-daemon /usr/local/bin/veil-daemon
COPY --from=veil-builder /out/licenses /licenses
COPY LICENSE /licenses/spiral-safe-Apache-2.0.txt
COPY --from=plugin-builder --chown=vault:vault /out/spiral-safe /vault/plugins/spiral-safe
COPY nitro/start.sh /usr/local/bin/start-spiral-veil
COPY nitro/start-vault.sh /usr/local/bin/start-vault
COPY nitro/vault.hcl /vault/config/vault.hcl
RUN mkdir -p /vault/data \
    && chmod 0755 \
      /usr/local/bin/veil-daemon \
      /usr/local/bin/start-spiral-veil \
      /usr/local/bin/start-vault \
      /vault/plugins/spiral-safe \
    && chown -R vault:vault /vault/config/vault.hcl /vault/data

EXPOSE 8443
ENTRYPOINT ["/usr/local/bin/start-spiral-veil"]
