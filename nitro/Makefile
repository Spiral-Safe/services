prog := spiral-safe-veil
version := $(shell git -C .. describe --tags --dirty --always)
image_tag := $(prog):$(version)
image_tar := $(prog)-$(version).tar
image_eif := $(prog)-$(version).eif
tools_dir := .tools
plugin_sources := $(wildcard ../*.go ../cmd/spiral-safe/*.go) ../go.mod ../go.sum

veil_commit := 2b8c06ca651e09b21832f6fc4ae2605371386f76
spiral_safe_revision := $(shell git -C .. rev-parse HEAD)

ARCH ?= $(shell uname -m)
ifeq ($(ARCH),aarch64)
  override ARCH=arm64
endif
ifeq ($(ARCH),x86_64)
  override ARCH=amd64
endif

VEIL_FQDN ?= spiral-safe.invalid
WEBAUTHN_RP_ID ?= localhost
WEBAUTHN_RP_ORIGINS ?= http://localhost:9080

.DEFAULT_GOAL := image

.PHONY: image
image: $(image_tar)

$(image_tar): Dockerfile start.sh start-vault.sh vault.hcl $(plugin_sources)
	docker buildx build \
		--platform linux/$(ARCH) \
		--file Dockerfile \
		--tag $(image_tag) \
		--build-arg VEIL_COMMIT=$(veil_commit) \
		--build-arg SPIRAL_SAFE_REVISION=$(spiral_safe_revision) \
		--build-arg VEIL_FQDN=$(VEIL_FQDN) \
		--build-arg WEBAUTHN_RP_ID=$(WEBAUTHN_RP_ID) \
		--build-arg WEBAUTHN_RP_ORIGINS=$(WEBAUTHN_RP_ORIGINS) \
		--output type=docker,dest=$(image_tar) \
		..

.PHONY: tools
tools:
	docker buildx build \
		--platform linux/$(ARCH) \
		--file Dockerfile \
		--target veil-tools \
		--build-arg VEIL_COMMIT=$(veil_commit) \
		--output type=local,dest=$(tools_dir) \
		..

.PHONY: eif
eif: $(image_eif)

$(image_eif): $(image_tar)
	docker load --input $<
	nitro-cli build-enclave \
		--docker-uri $(image_tag) \
		--output-file $(image_eif)

.PHONY: run
run: tools $(image_eif)
	./run-enclave.sh $(image_eif) $(tools_dir)/veil-proxy

.PHONY: clean
clean:
	rm -f $(image_tar) $(image_eif)
	rm -rf $(tools_dir)
