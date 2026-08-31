package solana_se

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"

	secp256k1 "github.com/decred/dcrd/dcrec/secp256k1/v4"
	secpECDSA "github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/portto/solana-go-sdk/types"
	"golang.org/x/crypto/sha3"
)

const (
	ChainSolana   = "solana"
	ChainEthereum = "ethereum"

	OperationTransaction = "transaction"
	OperationMessage     = "message"
)

// ChainSigner isolates chain-specific key creation, address derivation, and
// signing. Adding a chain should not require changing the WebAuthn ceremony or
// the HTTP adapter.
type ChainSigner interface {
	Generate() (privateKey []byte, address string, err error)
	Address(privateKey []byte) (string, error)
	Sign(privateKey, payload []byte, operation string) (SignResult, error)
}

type SignResult struct {
	EncodedTransaction string
	Signature          string
}

func signerFor(chain string) (ChainSigner, error) {
	switch normalizeChain(chain) {
	case ChainSolana:
		return solanaSigner{}, nil
	case ChainEthereum:
		return ethereumSigner{}, nil
	default:
		return nil, fmt.Errorf("unsupported chain %q", chain)
	}
}

func normalizeChain(chain string) string {
	chain = strings.ToLower(strings.TrimSpace(chain))
	if chain == "" {
		return ChainSolana
	}
	return chain
}

func normalizeOperation(operation string) string {
	operation = strings.ToLower(strings.TrimSpace(operation))
	if operation == "" {
		return OperationTransaction
	}
	return operation
}

type solanaSigner struct{}

func (solanaSigner) Generate() ([]byte, string, error) {
	account := types.NewAccount()
	return account.PrivateKey, account.PublicKey.ToBase58(), nil
}

func (solanaSigner) Address(privateKey []byte) (string, error) {
	account, err := types.AccountFromBytes(privateKey)
	if err != nil {
		return "", fmt.Errorf("invalid Solana private key: %w", err)
	}
	return account.PublicKey.ToBase58(), nil
}

func (solanaSigner) Sign(privateKey, payload []byte, operation string) (SignResult, error) {
	account, err := types.AccountFromBytes(privateKey)
	if err != nil {
		return SignResult{}, fmt.Errorf("invalid Solana private key: %w", err)
	}

	switch normalizeOperation(operation) {
	case OperationMessage:
		signature := account.Sign(payload)
		return SignResult{Signature: base64.StdEncoding.EncodeToString(signature)}, nil
	case OperationTransaction:
		tx, err := deserializeSolanaTransaction(payload)
		if err != nil {
			return SignResult{}, fmt.Errorf("invalid Solana transaction: %w", err)
		}
		if tx.Message.Version != types.MessageVersionLegacy {
			return SignResult{}, fmt.Errorf("only legacy Solana transactions are supported")
		}
		message, err := tx.Message.Serialize()
		if err != nil {
			return SignResult{}, fmt.Errorf("serialize Solana message: %w", err)
		}
		if err := tx.AddSignature(account.Sign(message)); err != nil {
			return SignResult{}, fmt.Errorf("add Solana signature: %w", err)
		}
		encoded, err := tx.Serialize()
		if err != nil {
			return SignResult{}, fmt.Errorf("serialize signed Solana transaction: %w", err)
		}
		return SignResult{EncodedTransaction: base64.StdEncoding.EncodeToString(encoded)}, nil
	default:
		return SignResult{}, fmt.Errorf("unsupported Solana operation %q", operation)
	}
}

func deserializeSolanaTransaction(payload []byte) (transaction types.Transaction, err error) {
	// The upstream parser assumes several internal slices are long enough and
	// can panic on malformed caller-controlled bytes. Keep that failure inside
	// the signer boundary so the Vault plugin returns a validation error rather
	// than losing its plugin process.
	defer func() {
		if recover() != nil {
			transaction = types.Transaction{}
			err = fmt.Errorf("malformed transaction encoding")
		}
	}()
	return types.TransactionDeserialize(payload)
}

type ethereumSigner struct{}

func (ethereumSigner) Generate() ([]byte, string, error) {
	privateKey, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		return nil, "", fmt.Errorf("generate Ethereum key: %w", err)
	}
	serialized := privateKey.Serialize()
	address, err := ethereumAddress(privateKey)
	if err != nil {
		return nil, "", err
	}
	return serialized, address, nil
}

func (ethereumSigner) Address(privateKey []byte) (string, error) {
	if len(privateKey) != secp256k1.PrivKeyBytesLen {
		return "", fmt.Errorf("invalid Ethereum private key length")
	}
	return ethereumAddress(secp256k1.PrivKeyFromBytes(privateKey))
}

func (ethereumSigner) Sign(privateKey, payload []byte, operation string) (SignResult, error) {
	if len(privateKey) != secp256k1.PrivKeyBytesLen {
		return SignResult{}, fmt.Errorf("invalid Ethereum private key length")
	}
	if normalizeOperation(operation) != OperationMessage {
		return SignResult{}, fmt.Errorf("Ethereum currently supports EIP-191 message signing only")
	}

	prefix := []byte(fmt.Sprintf("\x19Ethereum Signed Message:\n%d", len(payload)))
	hasher := sha3.NewLegacyKeccak256()
	_, _ = hasher.Write(prefix)
	_, _ = hasher.Write(payload)
	digest := hasher.Sum(nil)

	// SignCompact returns header || R || S. Ethereum uses R || S || recovery-id.
	compact := secpECDSA.SignCompact(secp256k1.PrivKeyFromBytes(privateKey), digest, false)
	recoveryID := compact[0] - 27
	if recoveryID > 1 {
		return SignResult{}, fmt.Errorf("Ethereum signature has unsupported recovery ID")
	}
	signature := append(append([]byte{}, compact[1:]...), recoveryID)
	return SignResult{Signature: base64.StdEncoding.EncodeToString(signature)}, nil
}

func ethereumAddress(privateKey *secp256k1.PrivateKey) (string, error) {
	publicKey := privateKey.PubKey().SerializeUncompressed()
	if len(publicKey) != 65 {
		return "", fmt.Errorf("invalid Ethereum public key")
	}
	hasher := sha3.NewLegacyKeccak256()
	_, _ = hasher.Write(publicKey[1:])
	rawAddress := hasher.Sum(nil)[12:]
	return checksumEthereumAddress(rawAddress), nil
}

// checksumEthereumAddress implements EIP-55 so examples return the familiar
// mixed-case address while comparisons can still be made case-insensitively.
func checksumEthereumAddress(address []byte) string {
	lower := hex.EncodeToString(address)
	hasher := sha3.NewLegacyKeccak256()
	_, _ = hasher.Write([]byte(lower))
	hash := hasher.Sum(nil)
	result := []byte(lower)
	for i := range result {
		if result[i] >= 'a' && result[i] <= 'f' {
			nibble := hash[i/2]
			if i%2 == 0 {
				nibble >>= 4
			} else {
				nibble &= 0x0f
			}
			if nibble >= 8 {
				result[i] -= 'a' - 'A'
			}
		}
	}
	return "0x" + string(result)
}
