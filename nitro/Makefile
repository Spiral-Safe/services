prog := python-spiralsafe
version := $(shell git describe --tag --dirty --always)
image_tag := $(prog):$(version)
image_tar := $(prog)-$(version)-kaniko.tar
image_eif := $(image_tar:%.tar=%.eif)

ARCH ?= $(shell uname -m)
ifeq ($(ARCH),aarch64)
	override ARCH=arm64
endif
ifeq ($(ARCH),x86_64)
	override ARCH=amd64
endif

.PHONY: all
all: run

.PHONY: image
image: $(image_tar)

$(image_tar): Dockerfile start.sh vault.hcl
	docker run \
		-v $(PWD):/workspace \
		gcr.io/kaniko-project/executor:v1.9.2 \
		--reproducible \
		--no-push \
		--tarPath $(image_tar) \
		--destination $(image_tag) \
		--build-arg TARGETPLATFORM=linux/$(ARCH) \
		--build-arg TARGETOS=linux \
		--build-arg TARGETARCH=$(ARCH) \
		--custom-platform linux/$(ARCH)

$(image_eif): $(image_tar)
	docker load -i $<
	nitro-cli build-enclave \
		--docker-uri $(image_tag) \
		--output-file $(image_eif)

.PHONY: run
run: $(image_eif)
	# Terminate already-running enclave.
	nitro-cli terminate-enclave --all
	# Start our proxy and the enclave.
	./run-enclave.sh $(image_eif)

.PHONY: clean
clean:
	rm -f $(image_tar) $(image_eif)

.PHONY: register
register:
	vault plugin register --header=X-VAULT-TOKEN=xxxx -sha256=bfed59074e64cc71fc407ed53bb5fbfa18c8735541ebbd48578f121de2a984ff -version=v1.0.0 secret spiral-safe

.PHONY: enable
enable:
	vault secrets enable --header=X-VAULT-TOKEN=XXXX -path=spiral-safe spiral-safe