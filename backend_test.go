package solana_se

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"testing"

	"github.com/fxamacker/cbor/v2"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/hashicorp/vault/sdk/logical"
)

type mockWebAuthn struct{}

func (*mockWebAuthn) BeginRegistration(webauthn.User, ...webauthn.RegistrationOption) (*protocol.CredentialCreation, *webauthn.SessionData, error) {
	return &protocol.CredentialCreation{}, &webauthn.SessionData{}, nil
}

func (*mockWebAuthn) CreateCredential(webauthn.User, webauthn.SessionData, *protocol.ParsedCredentialCreationData) (*webauthn.Credential, error) {
	return &webauthn.Credential{ID: []byte("credential")}, nil
}

func (*mockWebAuthn) BeginLogin(webauthn.User, ...webauthn.LoginOption) (*protocol.CredentialAssertion, *webauthn.SessionData, error) {
	return &protocol.CredentialAssertion{}, &webauthn.SessionData{}, nil
}

func (*mockWebAuthn) ValidateLogin(webauthn.User, webauthn.SessionData, *protocol.ParsedCredentialAssertionData) (*webauthn.Credential, error) {
	return &webauthn.Credential{ID: []byte("credential")}, nil
}

func TestTenantAndChainStorageIsolation(t *testing.T) {
	b, err := newBackend(true)
	if err != nil {
		t.Fatal(err)
	}
	b.webauthn = &mockWebAuthn{}
	storage := &logical.InmemStorage{}
	ctx := context.Background()

	for _, identity := range []requestIdentity{
		{Tenant: "tenant-a", Username: "alice", Chain: ChainSolana},
		{Tenant: "tenant-b", Username: "alice", Chain: ChainSolana},
		{Tenant: "tenant-a", Username: "alice", Chain: ChainEthereum},
	} {
		response, err := b.handleWriteUser(ctx, request(storage, identity, nil), nil)
		if err != nil {
			t.Fatalf("initialize %+v: %v", identity, err)
		}
		if response.Data["chain"] != identity.Chain {
			t.Fatalf("wrong chain for %+v: %v", identity, response.Data)
		}
	}

	entries, err := storage.List(ctx, "tenants/")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected two tenant prefixes, got %v", entries)
	}
}

func TestWebAuthnUserIDIsStableScopedAndBounded(t *testing.T) {
	identities := []requestIdentity{
		{Tenant: "tenant-a", Username: "alice", Chain: ChainSolana},
		{Tenant: "tenant-b", Username: "alice", Chain: ChainSolana},
		{Tenant: "tenant-a", Username: "alice", Chain: ChainEthereum},
		{
			Tenant:   "t123456789012345678901234567890123456789012345678901234567890123",
			Username: "u123456789012345678901234567890123456789012345678901234567890123",
			Chain:    ChainEthereum,
		},
	}
	seen := make(map[string]bool)
	for _, identity := range identities {
		id := webAuthnUserID(identity)
		if len(id) == 0 || len(id) > 64 {
			t.Fatalf("WebAuthn user ID length %d is outside 1-64 bytes", len(id))
		}
		if id != webAuthnUserID(identity) {
			t.Fatal("WebAuthn user ID is not deterministic")
		}
		if seen[id] {
			t.Fatalf("identity %+v collided with another test identity", identity)
		}
		seen[id] = true
	}
}

func TestFrameworkCreateRouteRunsExistenceCheck(t *testing.T) {
	b, err := newBackend(true)
	if err != nil {
		t.Fatal(err)
	}
	b.webauthn = &mockWebAuthn{}
	config := logical.TestBackendConfig()
	config.StorageView = &logical.InmemStorage{}
	if err := b.Setup(context.Background(), config); err != nil {
		t.Fatal(err)
	}
	response, err := b.HandleRequest(context.Background(), &logical.Request{
		Operation: logical.CreateOperation,
		Path:      "users",
		Storage:   config.StorageView,
		Data: map[string]interface{}{
			"tenant":   "tenant-a",
			"username": "framework-user",
			"chain":    ChainSolana,
		},
	})
	if err != nil {
		t.Fatalf("framework route: %v", err)
	}
	if response == nil || response.Data["ceremonyId"] == nil {
		t.Fatalf("unexpected framework response: %#v", response)
	}
}

func TestEmptyCredentialCannotRestartRegistrationCeremony(t *testing.T) {
	b, err := newBackend(true)
	if err != nil {
		t.Fatal(err)
	}
	b.webauthn = &mockWebAuthn{}
	storage := &logical.InmemStorage{}
	ctx := context.Background()
	identity := requestIdentity{Tenant: "tenant-a", Username: "alice", Chain: ChainEthereum}

	initialized, err := b.handleWriteUser(ctx, request(storage, identity, nil), nil)
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	_, err = b.handleWriteUser(ctx, request(storage, identity, map[string]interface{}{
		"ceremonyId": initialized.Data["ceremonyId"],
		"credential": map[string]interface{}{},
	}), nil)
	if err == nil {
		t.Fatal("expected an empty completion credential to be rejected")
	}
}

func TestFullWebAuthnRegistrationAuthenticationAndEthereumSigning(t *testing.T) {
	t.Setenv("WEBAUTHN_RP_ID", "localhost")
	t.Setenv("WEBAUTHN_RP_ORIGINS", "http://localhost:9080")
	b, err := newBackend(false)
	if err != nil {
		t.Fatal(err)
	}
	storage := &logical.InmemStorage{}
	ctx := context.Background()
	config := logical.TestBackendConfig()
	config.StorageView = storage
	if err := b.Setup(ctx, config); err != nil {
		t.Fatal(err)
	}
	identity := requestIdentity{Tenant: "tenant-a", Username: "alice", Chain: ChainEthereum}

	initialized, err := b.HandleRequest(ctx, frameworkRequest(
		storage,
		identity,
		"users",
		logical.CreateOperation,
		nil,
	))
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	authenticatorKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	credentialID := make([]byte, 32)
	if _, err := rand.Read(credentialID); err != nil {
		t.Fatal(err)
	}
	registrationCredential := virtualRegistrationCredential(
		t,
		initialized.Data["options"],
		authenticatorKey,
		credentialID,
	)
	created, err := b.HandleRequest(ctx, frameworkRequest(storage, identity, "users", logical.UpdateOperation, map[string]interface{}{
		"ceremonyId": initialized.Data["ceremonyId"],
		"credential": registrationCredential,
	}))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	address, ok := created.Data["address"].(string)
	if !ok || len(address) != 42 || address[:2] != "0x" {
		t.Fatalf("unexpected Ethereum address: %v", created.Data)
	}
	checked, err := b.HandleRequest(ctx, frameworkRequest(storage, identity, "check", logical.UpdateOperation, nil))
	if err != nil || checked.Data["address"] != address {
		t.Fatalf("framework check route: %#v, %v", checked, err)
	}

	message := []byte("Spiral Safe virtual authenticator lifecycle")
	mismatchStarted, err := b.HandleRequest(ctx, frameworkRequest(storage, identity, "auth", logical.UpdateOperation, map[string]interface{}{
		"operation": OperationMessage,
		"payload":   base64.StdEncoding.EncodeToString(message),
	}))
	if err != nil {
		t.Fatalf("start operation-mismatch regression: %v", err)
	}
	mismatchCredential := virtualAssertionCredential(
		t,
		mismatchStarted.Data["options"],
		authenticatorKey,
		credentialID,
		1,
		0x05,
	)
	mismatched, err := b.HandleRequest(ctx, frameworkRequest(storage, identity, "auth", logical.UpdateOperation, map[string]interface{}{
		"ceremonyId": mismatchStarted.Data["ceremonyId"],
		"operation":  OperationTransaction,
		"credential": mismatchCredential,
	}))
	if err == nil || mismatched != nil {
		t.Fatalf("operation mismatch released a signing response: %#v, %v", mismatched, err)
	}
	if _, err := b.HandleRequest(ctx, frameworkRequest(storage, identity, "auth", logical.UpdateOperation, map[string]interface{}{
		"ceremonyId": mismatchStarted.Data["ceremonyId"],
		"operation":  OperationMessage,
		"credential": mismatchCredential,
	})); err == nil {
		t.Fatal("operation-mismatched ceremony was not consumed")
	}

	started, err := b.HandleRequest(ctx, frameworkRequest(storage, identity, "auth", logical.UpdateOperation, map[string]interface{}{
		"operation": OperationMessage,
		"payload":   base64.StdEncoding.EncodeToString(message),
	}))
	if err != nil {
		t.Fatalf("signin: %v", err)
	}
	assertionCredential := virtualAssertionCredential(
		t,
		started.Data["options"],
		authenticatorKey,
		credentialID,
		1,
		0x05,
	)
	completed, err := b.HandleRequest(ctx, frameworkRequest(storage, identity, "auth", logical.UpdateOperation, map[string]interface{}{
		"ceremonyId": started.Data["ceremonyId"],
		"operation":  OperationMessage,
		"credential": assertionCredential,
	}))
	if err != nil {
		t.Fatalf("complete: %v", err)
	}
	if completed.Data["operation"] != OperationMessage {
		t.Fatalf("completion did not return trusted ceremony operation: %#v", completed.Data)
	}
	signature, err := base64.StdEncoding.DecodeString(completed.Data["signature"].(string))
	if err != nil || len(signature) != 65 {
		t.Fatalf("invalid Ethereum signature: %v, %v", completed.Data["signature"], err)
	}
	if recovered := recoverEthereumAddress(t, message, signature); recovered != address {
		t.Fatalf("recovered address %s does not match wallet %s", recovered, address)
	}

	// A completed assertion cannot be replayed to release another signature.
	if _, err := b.HandleRequest(ctx, frameworkRequest(storage, identity, "auth", logical.UpdateOperation, map[string]interface{}{
		"ceremonyId": started.Data["ceremonyId"],
		"operation":  OperationMessage,
		"credential": assertionCredential,
	})); err == nil {
		t.Fatal("expected replayed assertion to be rejected")
	}

	// A present-but-unverified assertion must never release a signature.
	uvStarted, err := b.HandleRequest(ctx, frameworkRequest(storage, identity, "auth", logical.UpdateOperation, map[string]interface{}{
		"operation": OperationMessage,
		"payload":   base64.StdEncoding.EncodeToString(message),
	}))
	if err != nil {
		t.Fatalf("start user-verification regression: %v", err)
	}
	withoutUserVerification := virtualAssertionCredential(
		t,
		uvStarted.Data["options"],
		authenticatorKey,
		credentialID,
		2,
		0x01,
	)
	if _, err := b.HandleRequest(ctx, frameworkRequest(storage, identity, "auth", logical.UpdateOperation, map[string]interface{}{
		"ceremonyId": uvStarted.Data["ceremonyId"],
		"operation":  OperationMessage,
		"credential": withoutUserVerification,
	})); err == nil {
		t.Fatal("expected assertion without user verification to be rejected")
	}

	// A nonzero signature-counter regression disables the credential before
	// signing and prevents another ceremony from starting.
	cloneStarted, err := b.HandleRequest(ctx, frameworkRequest(storage, identity, "auth", logical.UpdateOperation, map[string]interface{}{
		"operation": OperationMessage,
		"payload":   base64.StdEncoding.EncodeToString(message),
	}))
	if err != nil {
		t.Fatalf("start clone-warning regression: %v", err)
	}
	regressedCounter := virtualAssertionCredential(
		t,
		cloneStarted.Data["options"],
		authenticatorKey,
		credentialID,
		1,
		0x05,
	)
	if _, err := b.HandleRequest(ctx, frameworkRequest(storage, identity, "auth", logical.UpdateOperation, map[string]interface{}{
		"ceremonyId": cloneStarted.Data["ceremonyId"],
		"operation":  OperationMessage,
		"credential": regressedCounter,
	})); err == nil {
		t.Fatal("expected signature-counter regression to be rejected")
	}
	if _, err := b.HandleRequest(ctx, frameworkRequest(storage, identity, "auth", logical.UpdateOperation, map[string]interface{}{
		"operation": OperationMessage,
		"payload":   base64.StdEncoding.EncodeToString(message),
	})); err == nil {
		t.Fatal("expected clone-warned credential to remain disabled")
	}
}

func request(storage logical.Storage, identity requestIdentity, extra map[string]interface{}) *logical.Request {
	data := map[string]interface{}{
		"tenant":   identity.Tenant,
		"username": identity.Username,
		"chain":    identity.Chain,
	}
	for key, value := range extra {
		data[key] = value
	}
	return &logical.Request{
		Operation: logical.CreateOperation,
		Storage:   storage,
		Data:      data,
	}
}

func frameworkRequest(
	storage logical.Storage,
	identity requestIdentity,
	path string,
	operation logical.Operation,
	extra map[string]interface{},
) *logical.Request {
	req := request(storage, identity, extra)
	req.Path = path
	req.Operation = operation
	return req
}

func virtualRegistrationCredential(t *testing.T, options interface{}, key *ecdsa.PrivateKey, credentialID []byte) map[string]interface{} {
	t.Helper()
	challenge := optionChallenge(t, options)
	clientData := mustJSON(t, map[string]interface{}{
		"type":        "webauthn.create",
		"challenge":   challenge,
		"origin":      "http://localhost:9080",
		"crossOrigin": false,
	})
	rpIDHash := sha256.Sum256([]byte("localhost"))
	coseKey, err := cbor.Marshal(map[int]interface{}{
		1:  2,
		3:  -7,
		-1: 1,
		-2: paddedCoordinate(key.PublicKey.X.Bytes()),
		-3: paddedCoordinate(key.PublicKey.Y.Bytes()),
	})
	if err != nil {
		t.Fatal(err)
	}
	var authData bytes.Buffer
	authData.Write(rpIDHash[:])
	authData.WriteByte(0x45) // user present, user verified, attested credential data
	_ = binary.Write(&authData, binary.BigEndian, uint32(0))
	authData.Write(make([]byte, 16)) // AAGUID for the software authenticator
	_ = binary.Write(&authData, binary.BigEndian, uint16(len(credentialID)))
	authData.Write(credentialID)
	authData.Write(coseKey)
	attestation, err := cbor.Marshal(map[string]interface{}{
		"fmt":      "none",
		"authData": authData.Bytes(),
		"attStmt":  map[string]interface{}{},
	})
	if err != nil {
		t.Fatal(err)
	}
	id := base64.RawURLEncoding.EncodeToString(credentialID)
	return map[string]interface{}{
		"id":    id,
		"rawId": id,
		"type":  "public-key",
		"response": map[string]interface{}{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(clientData),
			"attestationObject": base64.RawURLEncoding.EncodeToString(attestation),
		},
	}
}

func virtualAssertionCredential(t *testing.T, options interface{}, key *ecdsa.PrivateKey, credentialID []byte, counter uint32, flags byte) map[string]interface{} {
	t.Helper()
	challenge := optionChallenge(t, options)
	clientData := mustJSON(t, map[string]interface{}{
		"type":        "webauthn.get",
		"challenge":   challenge,
		"origin":      "http://localhost:9080",
		"crossOrigin": false,
	})
	rpIDHash := sha256.Sum256([]byte("localhost"))
	var authData bytes.Buffer
	authData.Write(rpIDHash[:])
	authData.WriteByte(flags)
	_ = binary.Write(&authData, binary.BigEndian, counter)
	clientHash := sha256.Sum256(clientData)
	signed := append(append([]byte{}, authData.Bytes()...), clientHash[:]...)
	digest := sha256.Sum256(signed)
	signature, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	id := base64.RawURLEncoding.EncodeToString(credentialID)
	return map[string]interface{}{
		"id":    id,
		"rawId": id,
		"type":  "public-key",
		"response": map[string]interface{}{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(clientData),
			"authenticatorData": base64.RawURLEncoding.EncodeToString(authData.Bytes()),
			"signature":         base64.RawURLEncoding.EncodeToString(signature),
		},
	}
}

func optionChallenge(t *testing.T, options interface{}) string {
	t.Helper()
	encoded, err := json.Marshal(options)
	if err != nil {
		t.Fatal(err)
	}
	var value struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	if err := json.Unmarshal(encoded, &value); err != nil {
		t.Fatal(err)
	}
	if value.PublicKey.Challenge == "" {
		t.Fatalf("missing challenge in %s", encoded)
	}
	return value.PublicKey.Challenge
}

func mustJSON(t *testing.T, value interface{}) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func paddedCoordinate(value []byte) []byte {
	coordinate := make([]byte, 32)
	copy(coordinate[len(coordinate)-len(value):], value)
	return coordinate
}
