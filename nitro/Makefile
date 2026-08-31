prog := spiral-safe-veil
version := $(shell git -C .. describe --tags --dirty --always)
image_tag := $(prog):$(version)
image_tar := $(prog)-$(version).tar
image_eif := $(prog)-$(version).eif
tools_dir := .tools
runtime_dir := .runtime
plugin_sources := $(wildcard ../*.go ../cmd/spiral-safe/*.go) ../go.mod ../go.sum
node_config_sources := $(wildcard config-renderer/*.go) config-renderer/go.mod

veil_commit := 2b8c06ca651e09b21832f6fc4ae2605371386f76

PLATFORM ?= linux/amd64
NODE_MANIFEST ?= node-manifest.json
SOURCE_DIR ?= ..
CONFIG_OUTPUT ?= $(runtime_dir)/vault.hcl
ENV_OUTPUT ?= $(runtime_dir)/plugin.env
CHECK_FILES ?= true

.DEFAULT_GOAL := image

.PHONY: check-nitro-platform
check-nitro-platform:
	@test "$(PLATFORM)" = "linux/amd64" || { \
		echo "Nitro EIF and pinned veil-verify builds require PLATFORM=linux/amd64" >&2; \
		exit 1; \
	}

.PHONY: image
image: check-nitro-platform $(image_tar)

$(image_tar): Dockerfile start.sh start-vault.sh $(node_config_sources) $(plugin_sources)
	docker buildx build \
		--platform $(PLATFORM) \
		--file Dockerfile \
		--tag $(image_tag) \
		--build-arg VEIL_COMMIT=$(veil_commit) \
		--output type=docker,dest=$(image_tar) \
		..

.PHONY: tools
tools: check-nitro-platform
	docker buildx build \
		--platform $(PLATFORM) \
		--file Dockerfile \
		--target veil-tools \
		--build-arg VEIL_COMMIT=$(veil_commit) \
		--output type=local,dest=$(tools_dir) \
		..

.PHONY: native-config
native-config:
	mkdir -p $(tools_dir)
	go -C config-renderer build -trimpath -o ../$(tools_dir)/spiral-node-config .

.PHONY: validate-config
validate-config: native-config
	$(tools_dir)/spiral-node-config \
		-input $(NODE_MANIFEST) \
		-validate-only \
		-check-files=$(CHECK_FILES)

.PHONY: render-config
render-config: native-config
	mkdir -p $(runtime_dir)
	$(tools_dir)/spiral-node-config \
		-input $(NODE_MANIFEST) \
		-output $(CONFIG_OUTPUT) \
		-env-output $(ENV_OUTPUT) \
		-check-files=$(CHECK_FILES)

.PHONY: eif
eif: check-nitro-platform $(image_eif)

$(image_eif): $(image_tar)
	docker load --input $<
	nitro-cli build-enclave \
		--docker-uri $(image_tag) \
		--output-file $(image_eif)

.PHONY: run
run: tools $(image_eif)
	./run-enclave.sh $(image_eif) $(tools_dir)/veil-proxy $(NODE_MANIFEST)

.PHONY: verify-admission
verify-admission: tools
	SPIRAL_NODE_CONFIG_BIN=$(tools_dir)/spiral-node-config \
	VEIL_VERIFY_BIN=$(tools_dir)/veil-verify \
	./enroll-node.sh verify $(NODE_MANIFEST) $(image_eif) $(SOURCE_DIR)

.PHONY: admit
admit: tools
	SPIRAL_NODE_CONFIG_BIN=$(tools_dir)/spiral-node-config \
	VEIL_VERIFY_BIN=$(tools_dir)/veil-verify \
	./enroll-node.sh admit $(NODE_MANIFEST) $(image_eif) $(SOURCE_DIR)

.PHONY: check-membership
check-membership: tools
	SPIRAL_NODE_CONFIG_BIN=$(tools_dir)/spiral-node-config \
	./enroll-node.sh check $(NODE_MANIFEST)

.PHONY: simulate
simulate:
	./tests/same-image-simulation.sh

.PHONY: test
test:
	go -C config-renderer test ./...
	bash -n enroll-node.sh run-enclave.sh start-vault.sh start.sh tests/*.sh
	shellcheck enroll-node.sh run-enclave.sh start-vault.sh start.sh tests/*.sh
	./tests/same-image-simulation.sh
	./tests/enroll-node-test.sh

.PHONY: clean
clean:
	rm -f $(image_tar) $(image_eif)
	rm -rf $(tools_dir) $(runtime_dir)
