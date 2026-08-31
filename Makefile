GOOS ?= $(shell go env GOOS)
GOARCH ?= $(shell go env GOARCH)

.DEFAULT_GOAL := all

all: fmt build start

build:
	CGO_ENABLED=0 GOOS="$(GOOS)" GOARCH="$(GOARCH)" go build -trimpath -o vault/plugins/spiral-safe ./cmd/spiral-safe

start:
	vault server -dev -dev-root-token-id=root -dev-plugin-dir=./vault/plugins

enable:
	vault secrets enable -path=spiral-safe spiral-safe

clean:
	rm -rf ./vault

fmt:
	go fmt $$(go list ./...)

test tests:
	go test ./...

devnet-test:
	npm run script:create

.PHONY: build clean fmt start enable test tests devnet-test
