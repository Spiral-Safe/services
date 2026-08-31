package solana_se

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/gob"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/hashicorp/vault/sdk/framework"
	"github.com/hashicorp/vault/sdk/logical"
)

type WebAuthnInterface interface {
	BeginRegistration(user webauthn.User, options ...webauthn.RegistrationOption) (*protocol.CredentialCreation, *webauthn.SessionData, error)
	CreateCredential(user webauthn.User, sessionData webauthn.SessionData, response *protocol.ParsedCredentialCreationData) (*webauthn.Credential, error)
	BeginLogin(user webauthn.User, options ...webauthn.LoginOption) (*protocol.CredentialAssertion, *webauthn.SessionData, error)
	ValidateLogin(user webauthn.User, sessionData webauthn.SessionData, response *protocol.ParsedCredentialAssertionData) (*webauthn.Credential, error)
}

type backend struct {
	*framework.Backend
	webauthn   WebAuthnInterface
	mocked     bool
	ceremonyMu sync.Mutex
}

type SigningRequest struct {
	Chain     string
	Operation string
	Payload   []byte
}

type Ceremony struct {
	Kind           string
	WebAuthSession webauthn.SessionData
	Pending        *SigningRequest
	ExpiresAt      time.Time
}

// Payload is gob encoded in Vault logical storage. The legacy PrivateKey and
// Transaction fields remain to decode records created by the original plugin.
type Payload struct {
	PrivateKey     []byte
	WebAuthSession *webauthn.SessionData
	User           User
	Transaction    []byte
	Chain          string
	Address        string
	Pending        *SigningRequest
	Ceremonies     map[string]Ceremony
}

var (
	_              logical.Factory = Factory
	identityRegexp                 = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9._@-]{0,63})$`)
)

func Factory(ctx context.Context, conf *logical.BackendConfig) (logical.Backend, error) {
	b, err := newBackend(false)
	if err != nil {
		return nil, err
	}
	if conf == nil {
		return nil, fmt.Errorf("configuration passed into backend is nil")
	}
	if err := b.Setup(ctx, conf); err != nil {
		return nil, err
	}
	return b, nil
}

func newBackend(mocked bool) (*backend, error) {
	rpID := strings.TrimSpace(os.Getenv("WEBAUTHN_RP_ID"))
	if rpID == "" {
		rpID = "localhost"
	}
	origins := splitNonEmpty(os.Getenv("WEBAUTHN_RP_ORIGINS"))
	if len(origins) == 0 {
		origins = []string{"http://localhost:9080"}
	}

	w, err := webauthn.New(&webauthn.Config{
		RPDisplayName: "Spiral Safe",
		RPID:          rpID,
		RPOrigins:     origins,
		AuthenticatorSelection: protocol.AuthenticatorSelection{
			UserVerification: protocol.VerificationRequired,
		},
	})
	if err != nil {
		return nil, err
	}

	b := &backend{webauthn: w, mocked: mocked}
	b.Backend = &framework.Backend{
		Help:        strings.TrimSpace(secretEngineHelp),
		BackendType: logical.TypeLogical,
		Paths:       b.paths(),
	}
	return b, nil
}

func splitNonEmpty(value string) []string {
	var values []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			values = append(values, item)
		}
	}
	return values
}

func identityFields() map[string]*framework.FieldSchema {
	return map[string]*framework.FieldSchema{
		"tenant": {
			Type:        framework.TypeString,
			Description: "Server-authenticated tenant identifier.",
		},
		"username": {
			Type:        framework.TypeString,
			Description: "Tenant-local user identifier.",
		},
		"chain": {
			Type:        framework.TypeString,
			Default:     ChainSolana,
			Description: "Wallet chain (solana or ethereum).",
		},
	}
}

func (b *backend) paths() []*framework.Path {
	userFields := identityFields()
	userFields["credential"] = &framework.FieldSchema{
		Type:        framework.TypeMap,
		Description: "WebAuthn credential creation response.",
	}
	userFields["ceremonyId"] = &framework.FieldSchema{
		Type:        framework.TypeString,
		Description: "Opaque registration ceremony identifier.",
	}
	authFields := identityFields()
	authFields["credential"] = &framework.FieldSchema{
		Type:        framework.TypeMap,
		Description: "WebAuthn credential assertion response.",
	}
	authFields["ceremonyId"] = &framework.FieldSchema{
		Type:        framework.TypeString,
		Description: "Opaque authentication ceremony identifier.",
	}
	authFields["operation"] = &framework.FieldSchema{
		Type:        framework.TypeString,
		Default:     OperationTransaction,
		Description: "Signing operation (transaction or message).",
	}
	authFields["payload"] = &framework.FieldSchema{
		Type:        framework.TypeString,
		Description: "Standard-base64 payload to sign.",
	}
	authFields["tx"] = &framework.FieldSchema{
		Type:        framework.TypeString,
		Description: "Legacy alias for payload.",
	}

	return []*framework.Path{
		{
			Pattern: "users",
			Fields:  userFields,
			Operations: map[logical.Operation]framework.OperationHandler{
				logical.CreateOperation: &framework.PathOperation{Callback: b.handleWriteUser},
				logical.UpdateOperation: &framework.PathOperation{Callback: b.handleWriteUser},
				logical.ReadOperation:   &framework.PathOperation{Callback: b.handleReadUser},
			},
			ExistenceCheck: b.handleExistenceCheck,
		},
		{
			Pattern: "check",
			Fields:  identityFields(),
			Operations: map[logical.Operation]framework.OperationHandler{
				logical.CreateOperation: &framework.PathOperation{Callback: b.handleReadUser},
				logical.UpdateOperation: &framework.PathOperation{Callback: b.handleReadUser},
			},
			ExistenceCheck: b.handleExistenceCheck,
		},
		{
			Pattern: "auth",
			Fields:  authFields,
			Operations: map[logical.Operation]framework.OperationHandler{
				logical.CreateOperation: &framework.PathOperation{Callback: b.handleWriteAuth},
				logical.UpdateOperation: &framework.PathOperation{Callback: b.handleWriteAuth},
			},
			ExistenceCheck: b.handleExistenceCheck,
		},
	}
}

func (b *backend) handleExistenceCheck(ctx context.Context, req *logical.Request, _ *framework.FieldData) (bool, error) {
	identity, err := parseIdentity(req)
	if err != nil {
		return false, err
	}
	_, found, err := loadPayload(ctx, req.Storage, identity)
	return found, err
}

type requestIdentity struct {
	Tenant   string
	Username string
	Chain    string
}

func parseIdentity(req *logical.Request) (requestIdentity, error) {
	identity := requestIdentity{
		Tenant:   stringValue(req.Data, "tenant"),
		Username: stringValue(req.Data, "username"),
		Chain:    normalizeChain(stringValue(req.Data, "chain")),
	}
	if !identityRegexp.MatchString(identity.Tenant) {
		return requestIdentity{}, fmt.Errorf("tenant must be 1-64 safe identifier characters")
	}
	if !identityRegexp.MatchString(identity.Username) {
		return requestIdentity{}, fmt.Errorf("username must be 1-64 safe identifier characters")
	}
	if _, err := signerFor(identity.Chain); err != nil {
		return requestIdentity{}, err
	}
	return identity, nil
}

func stringValue(data map[string]interface{}, key string) string {
	value, _ := data[key].(string)
	return strings.TrimSpace(value)
}

func mapValue(data map[string]interface{}, key string) map[string]interface{} {
	value, _ := data[key].(map[string]interface{})
	return value
}

func storageKey(identity requestIdentity) string {
	encode := base64.RawURLEncoding.EncodeToString
	return "tenants/" + encode([]byte(identity.Tenant)) + "/users/" +
		encode([]byte(identity.Username)) + "/chains/" + encode([]byte(identity.Chain))
}

func webAuthnUserID(identity requestIdentity) string {
	digest := sha256.Sum256([]byte(identity.Tenant + "\x00" + identity.Username + "\x00" + identity.Chain))
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func loadPayload(ctx context.Context, storage logical.Storage, identity requestIdentity) (Payload, bool, error) {
	entry, err := storage.Get(ctx, storageKey(identity))
	if err != nil {
		return Payload{}, false, err
	}
	if entry == nil {
		return Payload{}, false, nil
	}
	var payload Payload
	if err := gob.NewDecoder(bytes.NewReader(entry.Value)).Decode(&payload); err != nil {
		return Payload{}, false, fmt.Errorf("decode wallet: %w", err)
	}
	return payload, true, nil
}

func savePayload(ctx context.Context, storage logical.Storage, identity requestIdentity, payload Payload) error {
	var buffer bytes.Buffer
	if err := gob.NewEncoder(&buffer).Encode(payload); err != nil {
		return fmt.Errorf("encode wallet: %w", err)
	}
	return storage.Put(ctx, &logical.StorageEntry{
		Key:      storageKey(identity),
		Value:    buffer.Bytes(),
		SealWrap: true,
	})
}

const (
	ceremonyRegistration   = "registration"
	ceremonyAuthentication = "authentication"
	ceremonyLifetime       = 2 * time.Minute
	maxPendingCeremonies   = 8
)

func addCeremony(payload *Payload, kind string, session *webauthn.SessionData, pending *SigningRequest) (string, error) {
	if session == nil {
		return "", fmt.Errorf("WebAuthn session is missing")
	}
	if payload.Ceremonies == nil {
		payload.Ceremonies = make(map[string]Ceremony)
	}
	now := time.Now().UTC()
	for id, ceremony := range payload.Ceremonies {
		if !ceremony.ExpiresAt.After(now) {
			delete(payload.Ceremonies, id)
		}
	}
	if len(payload.Ceremonies) >= maxPendingCeremonies {
		return "", fmt.Errorf("too many pending WebAuthn ceremonies")
	}
	randomID := make([]byte, 32)
	if _, err := rand.Read(randomID); err != nil {
		return "", fmt.Errorf("generate ceremony identifier: %w", err)
	}
	id := base64.RawURLEncoding.EncodeToString(randomID)
	payload.Ceremonies[id] = Ceremony{
		Kind:           kind,
		WebAuthSession: *session,
		Pending:        pending,
		ExpiresAt:      now.Add(ceremonyLifetime),
	}
	return id, nil
}

func consumeCeremony(payload *Payload, id, kind string) (Ceremony, error) {
	if id == "" {
		return Ceremony{}, fmt.Errorf("ceremonyId is required")
	}
	ceremony, ok := payload.Ceremonies[id]
	if !ok {
		return Ceremony{}, fmt.Errorf("WebAuthn ceremony was not found or was already consumed")
	}
	delete(payload.Ceremonies, id)
	if ceremony.Kind != kind {
		return Ceremony{}, fmt.Errorf("WebAuthn ceremony type does not match request")
	}
	if !ceremony.ExpiresAt.After(time.Now().UTC()) {
		return Ceremony{}, fmt.Errorf("WebAuthn ceremony expired")
	}
	return ceremony, nil
}

func walletResponse(payload Payload) map[string]interface{} {
	response := map[string]interface{}{
		"chain":   payload.Chain,
		"address": payload.Address,
	}
	if payload.Chain == ChainSolana {
		response["pubKey"] = payload.Address
	}
	return response
}

func (b *backend) handleReadUser(ctx context.Context, req *logical.Request, _ *framework.FieldData) (*logical.Response, error) {
	identity, err := parseIdentity(req)
	if err != nil {
		return nil, err
	}
	payload, found, err := loadPayload(ctx, req.Storage, identity)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, fmt.Errorf("404 wallet not registered")
	}
	if len(payload.User.Credentials) == 0 {
		return nil, fmt.Errorf("409 registration incomplete")
	}
	b.Backend.Logger().Info("wallet lookup", "tenant", identity.Tenant, "chain", identity.Chain)
	return &logical.Response{Data: walletResponse(payload)}, nil
}

func (b *backend) handleWriteUser(ctx context.Context, req *logical.Request, _ *framework.FieldData) (*logical.Response, error) {
	identity, err := parseIdentity(req)
	if err != nil {
		return nil, err
	}
	b.ceremonyMu.Lock()
	defer b.ceremonyMu.Unlock()
	payload, found, err := loadPayload(ctx, req.Storage, identity)
	if err != nil {
		return nil, err
	}
	credential := mapValue(req.Data, "credential")
	ceremonyID := stringValue(req.Data, "ceremonyId")

	if len(credential) == 0 {
		if ceremonyID != "" {
			return nil, fmt.Errorf("credential is required to complete registration ceremony")
		}
		if found && len(payload.User.Credentials) > 0 {
			return nil, fmt.Errorf("409 wallet already registered")
		}
		if !found {
			signer, _ := signerFor(identity.Chain)
			privateKey, address, err := signer.Generate()
			if err != nil {
				return nil, err
			}
			payload = Payload{
				PrivateKey: privateKey,
				Chain:      identity.Chain,
				Address:    address,
				User: User{
					// WebAuthn user handles must be at most 64 bytes. Keep a
					// deterministic, tenant-scoped identity without exposing the
					// concatenated identifiers to the authenticator.
					ID:       webAuthnUserID(identity),
					Username: identity.Username,
					PubKey:   address,
				},
			}
		}
		options, session, err := b.webauthn.BeginRegistration(payload.User)
		if err != nil {
			return nil, fmt.Errorf("begin WebAuthn registration: %w", err)
		}
		ceremonyID, err := addCeremony(&payload, ceremonyRegistration, session, nil)
		if err != nil {
			return nil, err
		}
		response := walletResponse(payload)
		response["options"] = options
		response["ceremonyId"] = ceremonyID
		if err := savePayload(ctx, req.Storage, identity, payload); err != nil {
			return nil, err
		}
		b.Backend.Logger().Info("registration started", "tenant", identity.Tenant, "chain", identity.Chain)
		return &logical.Response{Data: response}, nil
	}

	if !found {
		return nil, fmt.Errorf("404 registration was not initialized")
	}
	if len(payload.User.Credentials) > 0 {
		return nil, fmt.Errorf("409 wallet already registered")
	}
	ceremony, err := consumeCeremony(&payload, ceremonyID, ceremonyRegistration)
	if err != nil {
		return nil, err
	}
	// Persist one-time consumption before validating attacker-controlled data.
	if err := savePayload(ctx, req.Storage, identity, payload); err != nil {
		return nil, err
	}
	parsed, err := parseCreationCredential(credential)
	if err != nil {
		return nil, err
	}
	created, err := b.webauthn.CreateCredential(payload.User, ceremony.WebAuthSession, parsed)
	if err != nil {
		return nil, fmt.Errorf("validate WebAuthn registration: %w", err)
	}
	payload.User.AddCredential(*created)
	if err := savePayload(ctx, req.Storage, identity, payload); err != nil {
		return nil, err
	}
	b.Backend.Logger().Info("registration completed", "tenant", identity.Tenant, "chain", identity.Chain)
	return &logical.Response{Data: walletResponse(payload)}, nil
}

func parseCreationCredential(credential map[string]interface{}) (*protocol.ParsedCredentialCreationData, error) {
	data, err := json.Marshal(credential)
	if err != nil {
		return nil, fmt.Errorf("marshal credential: %w", err)
	}
	var response protocol.CredentialCreationResponse
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, fmt.Errorf("decode credential: %w", err)
	}
	parsed, err := response.Parse()
	if err != nil {
		return nil, fmt.Errorf("parse credential: %w", err)
	}
	return parsed, nil
}

func (b *backend) parseAssertionCredential(credential map[string]interface{}) (*protocol.ParsedCredentialAssertionData, error) {
	if b.mocked {
		return nil, nil
	}
	data, err := json.Marshal(credential)
	if err != nil {
		return nil, fmt.Errorf("marshal credential: %w", err)
	}
	var response protocol.CredentialAssertionResponse
	if err := json.Unmarshal(data, &response); err != nil {
		return nil, fmt.Errorf("decode credential: %w", err)
	}
	parsed, err := response.Parse()
	if err != nil {
		return nil, fmt.Errorf("parse credential: %w", err)
	}
	return parsed, nil
}

func (b *backend) handleWriteAuth(ctx context.Context, req *logical.Request, _ *framework.FieldData) (*logical.Response, error) {
	identity, err := parseIdentity(req)
	if err != nil {
		return nil, err
	}
	b.ceremonyMu.Lock()
	defer b.ceremonyMu.Unlock()
	payload, found, err := loadPayload(ctx, req.Storage, identity)
	if err != nil {
		return nil, err
	}
	if !found || len(payload.User.Credentials) == 0 {
		return nil, fmt.Errorf("404 wallet not registered")
	}
	credential := mapValue(req.Data, "credential")
	ceremonyID := stringValue(req.Data, "ceremonyId")

	if len(credential) == 0 {
		if ceremonyID != "" {
			return nil, fmt.Errorf("credential is required to complete authentication ceremony")
		}
		operation := normalizeOperation(stringValue(req.Data, "operation"))
		encodedPayload := stringValue(req.Data, "payload")
		if encodedPayload == "" {
			encodedPayload = stringValue(req.Data, "tx")
		}
		if encodedPayload == "" {
			return nil, fmt.Errorf("payload must be standard base64")
		}
		rawPayload, err := base64.StdEncoding.DecodeString(encodedPayload)
		if err != nil || len(rawPayload) == 0 {
			return nil, fmt.Errorf("payload must be non-empty standard base64")
		}
		if operation != OperationMessage && operation != OperationTransaction {
			return nil, fmt.Errorf("operation must be transaction or message")
		}
		if identity.Chain == ChainEthereum && operation != OperationMessage {
			return nil, fmt.Errorf("Ethereum currently supports EIP-191 message signing only")
		}
		for _, registered := range payload.User.Credentials {
			if registered.Authenticator.CloneWarning {
				return nil, fmt.Errorf("WebAuthn credential is disabled after a signature-counter regression")
			}
		}

		options, session, err := b.webauthn.BeginLogin(payload.User)
		if err != nil {
			return nil, fmt.Errorf("begin WebAuthn authentication: %w", err)
		}
		pending := &SigningRequest{Chain: identity.Chain, Operation: operation, Payload: rawPayload}
		ceremonyID, err := addCeremony(&payload, ceremonyAuthentication, session, pending)
		if err != nil {
			return nil, err
		}
		if err := savePayload(ctx, req.Storage, identity, payload); err != nil {
			return nil, err
		}
		response := walletResponse(payload)
		response["options"] = options
		response["ceremonyId"] = ceremonyID
		b.Backend.Logger().Info("authentication started", "tenant", identity.Tenant, "chain", identity.Chain, "operation", operation)
		return &logical.Response{Data: response}, nil
	}

	ceremony, err := consumeCeremony(&payload, ceremonyID, ceremonyAuthentication)
	if err != nil {
		return nil, err
	}
	if ceremony.Pending == nil {
		return nil, fmt.Errorf("authentication ceremony has no signing request")
	}
	// Persist one-time consumption before validating attacker-controlled data.
	if err := savePayload(ctx, req.Storage, identity, payload); err != nil {
		return nil, err
	}
	requestedOperation := normalizeOperation(stringValue(req.Data, "operation"))
	if requestedOperation != ceremony.Pending.Operation {
		return nil, fmt.Errorf("authentication ceremony operation mismatch")
	}
	parsed, err := b.parseAssertionCredential(credential)
	if err != nil {
		return nil, err
	}
	validated, err := b.webauthn.ValidateLogin(payload.User, ceremony.WebAuthSession, parsed)
	if err != nil {
		return nil, fmt.Errorf("validate WebAuthn authentication: %w", err)
	}
	payload.User.UpdateCredential(*validated)
	if validated.Authenticator.CloneWarning {
		if err := savePayload(ctx, req.Storage, identity, payload); err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("WebAuthn signature counter regressed; credential disabled")
	}
	signer, err := signerFor(ceremony.Pending.Chain)
	if err != nil {
		return nil, err
	}
	result, err := signer.Sign(payload.PrivateKey, ceremony.Pending.Payload, ceremony.Pending.Operation)
	if err != nil {
		return nil, fmt.Errorf("sign payload: %w", err)
	}
	response := walletResponse(payload)
	// Return the operation stored with the one-time ceremony. Callers must not
	// infer billing semantics from an untrusted completion request.
	response["operation"] = ceremony.Pending.Operation
	if result.EncodedTransaction != "" {
		response["encodedTX"] = result.EncodedTransaction
	}
	if result.Signature != "" {
		response["signature"] = result.Signature
	}
	payload.Transaction = nil
	if err := savePayload(ctx, req.Storage, identity, payload); err != nil {
		return nil, err
	}
	b.Backend.Logger().Info("payload signed", "tenant", identity.Tenant, "chain", identity.Chain)
	return &logical.Response{Data: response}, nil
}

const secretEngineHelp = `
The Spiral Safe secrets engine creates chain-specific keys and releases
signatures only after a successful WebAuthn assertion.
`
