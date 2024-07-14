FROM golang:1.22 as nitriding-builder
WORKDIR /
RUN git clone https://github.com/brave/nitriding-daemon.git
ARG TARGETARCH
RUN ARCH=${TARGETARCH} make -C nitriding-daemon/ nitriding

COPY start.sh vault.hcl /bin/
RUN chown root:root /bin/start.sh
RUN chmod 0755      /bin/start.sh /bin/vault.hcl

FROM golang:latest as spiral-safe-builder
WORKDIR /root
RUN git clone --branch deployment https://github.com/Spiral-Safe/services.git
ARG TARGETARCH
WORKDIR /root/services/
RUN make build

FROM vault:1.13.3
COPY --from=spiral-safe-builder /root/services/vault/plugins/spiral-safe /vault/plugins/spiral-safe
COPY --from=nitriding-builder /bin/vault.hcl /vault/
COPY --from=nitriding-builder /nitriding-daemon/nitriding /bin/start.sh /bin/
CMD ["start.sh"]