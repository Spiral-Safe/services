package solana_se

import (
	"bytes"
	"context"
	"encoding/gob"
	"encoding/json"
	"testing"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/hashicorp/vault/sdk/logical"
	"github.com/portto/solana-go-sdk/types"
)

// MockWebAuthn is a mock implementation of the WebAuthnInterface.
type MockWebAuthn struct{}

func (m *MockWebAuthn) BeginRegistration(user webauthn.User, options ...webauthn.RegistrationOption) (*protocol.CredentialCreation, *webauthn.SessionData, error) {
	// Return mock data
	return &protocol.CredentialCreation{}, &webauthn.SessionData{}, nil
}

func (m *MockWebAuthn) CreateCredential(user webauthn.User, sessionData webauthn.SessionData, response *protocol.ParsedCredentialCreationData) (*webauthn.Credential, error) {
	// Return mock data
	return &webauthn.Credential{}, nil
}

func (m *MockWebAuthn) BeginLogin(user webauthn.User, options ...webauthn.LoginOption) (*protocol.CredentialAssertion, *webauthn.SessionData, error) {
	// Return mock data
	return &protocol.CredentialAssertion{}, &webauthn.SessionData{}, nil
}

func (m *MockWebAuthn) ValidateLogin(user webauthn.User, sessionData webauthn.SessionData, response *protocol.ParsedCredentialAssertionData) (*webauthn.Credential, error) {
	// Return mock data
	return &webauthn.Credential{}, nil
}

func TestHandleReadUser(t *testing.T) {
	b, err := newBackend(true)
	if err != nil {
		t.Fatalf("failed to create backend: %v", err)
	}

	ctx := context.Background()
	storage := &logical.InmemStorage{}

	// Setup a user in storage
	user := User{Username: "testuser", PubKey: "testpubkey", Credentials: []webauthn.Credential{{ID: []byte("test-credential-id")}}}
	payload := Payload{User: user}
	var buf bytes.Buffer
	enc := gob.NewEncoder(&buf)
	if err := enc.Encode(payload); err != nil {
		t.Fatalf("failed to encode payload: %v", err)
	}
	entry := &logical.StorageEntry{
		Key:   "test-client-token/testuser",
		Value: buf.Bytes(),
	}
	if err := storage.Put(ctx, entry); err != nil {
		t.Fatalf("failed to put entry in storage: %v", err)
	}

	req := &logical.Request{
		Operation: logical.ReadOperation,
		Path:      "users",
		Storage:   storage,
		Data: map[string]interface{}{
			"username": "testuser",
		},
		ClientToken: "test-client-token",
	}

	resp, err := b.handleReadUser(ctx, req, nil)
	if err != nil {
		t.Fatalf("failed to read user: %v", err)
	}

	if resp.Data["pubKey"] != "testpubkey" {
		t.Errorf("expected pubKey to be 'testpubkey', got %v", resp.Data["pubKey"])
	}
}

func TestHandleWriteUser(t *testing.T) {
	b, err := newBackend(true)
	if err != nil {
		t.Fatalf("failed to create backend: %v", err)
	}

	ctx := context.Background()
	storage := &logical.InmemStorage{}

	req := &logical.Request{
		Operation: logical.CreateOperation,
		Path:      "users",
		Storage:   storage,
		Data: map[string]interface{}{
			"username":   "testuser",
			"credential": map[string]interface{}{},
		},
		ClientToken: "test-client-token",
	}

	resp, err := b.handleWriteUser(ctx, req, nil)
	if err != nil {
		t.Fatalf("failed to write user: %v", err)
	}

	if resp.Data["pubKey"] == "" {
		t.Errorf("expected pubKey to be set, got empty string")
	}
}

func TestHandleWriteAuth(t *testing.T) {
	b, err := newBackend(true)
	if err != nil {
		t.Fatalf("failed to create backend: %v", err)
	}

	b.webauthn = &MockWebAuthn{}

	ctx := context.Background()
	storage := &logical.InmemStorage{}

	// Setup a user in storage
	user := User{Username: "testuser", PubKey: "testpubkey", Credentials: []webauthn.Credential{{ID: []byte("test-credential-id")}}}
	acct := types.NewAccount()
	payload := Payload{User: user, PrivateKey: acct.PrivateKey}
	var buf bytes.Buffer
	enc := gob.NewEncoder(&buf)
	if err := enc.Encode(payload); err != nil {
		t.Fatalf("failed to encode payload: %v", err)
	}
	entry := &logical.StorageEntry{
		Key:   "test-client-token/testuser",
		Value: buf.Bytes(),
	}
	if err := storage.Put(ctx, entry); err != nil {
		t.Fatalf("failed to put entry in storage: %v", err)
	}

	req := &logical.Request{
		Operation: logical.CreateOperation,
		Path:      "auth",
		Storage:   storage,
		Data: map[string]interface{}{
			"username": "testuser",
			"tx":       "dGVzdHR4", // base64 for "testtx"
		},
		ClientToken: "test-client-token",
	}

	resp, err := b.handleWriteAuth(ctx, req, nil)
	if err != nil {
		t.Fatalf("failed to write auth: %v", err)
	}

	if resp.Data["pubKey"] != "testpubkey" {
		t.Errorf("expected pubKey to be 'testpubkey', got %v", resp.Data["pubKey"])
	}

	if resp.Data["options"] == nil {
		t.Errorf("expected options to be set, got nil")
	}

	car := protocol.CredentialAssertionResponse{
		PublicKeyCredential: protocol.PublicKeyCredential{
			Credential: protocol.Credential{
				ID:   "test-credential-id",
				Type: "public-key",
			},
			RawID: protocol.URLEncodedBase64("test-credential-id"),
		},
		AssertionResponse: protocol.AuthenticatorAssertionResponse{
			AuthenticatorData: protocol.URLEncodedBase64(`{}`),
			AuthenticatorResponse: protocol.AuthenticatorResponse{
				ClientDataJSON: protocol.URLEncodedBase64(`{}`),
			},
		},
	}
	req = &logical.Request{
		Operation: logical.CreateOperation,
		Path:      "auth",
		Storage:   storage,
		Data: map[string]interface{}{
			"username": "testuser",
			"credential": func() map[string]interface{} {
				var credentialMap map[string]interface{}
				data, err := json.Marshal(car)
				if err != nil {
					t.Fatalf("failed to marshal car: %v", err)
				}
				err = json.Unmarshal(data, &credentialMap)
				if err != nil {
					t.Fatalf("failed to unmarshal car: %v", err)
				}
				return credentialMap
			}(),
		},
		ClientToken: "test-client-token",
	}

	resp, err = b.handleWriteAuth(ctx, req, nil)
	if err != nil {
		t.Fatalf("failed to write auth: %v", err)
	}

	if resp.Data["pubKey"] != "testpubkey" {
		t.Errorf("expected pubKey to be 'testpubkey', got %v", resp.Data["pubKey"])
	}

	if resp.Data["encodedTX"] != "testtx" {
		t.Errorf("expected encodedTX to be 'testtx', got %v", resp.Data["encodedTX"])
	}
}
