package solana_se

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"testing"

	secpECDSA "github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/portto/solana-go-sdk/common"
	"github.com/portto/solana-go-sdk/types"
	"golang.org/x/crypto/sha3"
)

func TestSolanaMessageSignatureVerifiesForWallet(t *testing.T) {
	signer := solanaSigner{}
	privateKey, address, err := signer.Generate()
	if err != nil {
		t.Fatal(err)
	}
	account, err := types.AccountFromBytes(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	if account.PublicKey.ToBase58() != address {
		t.Fatalf("derived address %s, expected %s", account.PublicKey.ToBase58(), address)
	}
	message := []byte("Spiral Safe Solana custody proof")
	result, err := signer.Sign(privateKey, message, OperationMessage)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := base64.StdEncoding.DecodeString(result.Signature)
	if err != nil {
		t.Fatal(err)
	}
	if !ed25519.Verify(account.PublicKey.Bytes(), message, signature) {
		t.Fatal("Solana message signature did not verify for the wallet public key")
	}
}

func TestSolanaLegacyTransactionRoundTripAndWrongSignerRejection(t *testing.T) {
	signer := solanaSigner{}
	privateKey, _, err := signer.Generate()
	if err != nil {
		t.Fatal(err)
	}
	account, err := types.AccountFromBytes(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	message := types.Message{
		Version: types.MessageVersionLegacy,
		Header: types.MessageHeader{
			NumRequireSignatures: 1,
		},
		Accounts:        []common.PublicKey{account.PublicKey},
		RecentBlockHash: account.PublicKey.ToBase58(),
	}
	unsigned := types.Transaction{
		Signatures: []types.Signature{make([]byte, ed25519.SignatureSize)},
		Message:    message,
	}
	raw, err := unsigned.Serialize()
	if err != nil {
		t.Fatal(err)
	}
	result, err := signer.Sign(privateKey, raw, OperationTransaction)
	if err != nil {
		t.Fatal(err)
	}
	signedBytes, err := base64.StdEncoding.DecodeString(result.EncodedTransaction)
	if err != nil {
		t.Fatal(err)
	}
	signed, err := types.TransactionDeserialize(signedBytes)
	if err != nil {
		t.Fatal(err)
	}
	serializedMessage, err := signed.Message.Serialize()
	if err != nil {
		t.Fatal(err)
	}
	if len(signed.Signatures) != 1 || !ed25519.Verify(account.PublicKey.Bytes(), serializedMessage, signed.Signatures[0]) {
		t.Fatal("signed Solana transaction did not verify after deserialize")
	}

	wrongPrivateKey, _, err := signer.Generate()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := signer.Sign(wrongPrivateKey, raw, OperationTransaction); err == nil {
		t.Fatal("expected a transaction requiring another wallet to be rejected")
	}
}

func TestSolanaRejectsMalformedAndVersionedTransactions(t *testing.T) {
	signer := solanaSigner{}
	privateKey, _, err := signer.Generate()
	if err != nil {
		t.Fatal(err)
	}

	// One declared signature followed by no message reaches an unchecked slice
	// in the upstream parser unless the signer contains the panic boundary.
	truncated := append([]byte{1}, make([]byte, ed25519.SignatureSize)...)
	if _, err := signer.Sign(privateKey, truncated, OperationTransaction); err == nil {
		t.Fatal("expected truncated Solana transaction to be rejected")
	}

	account, err := types.AccountFromBytes(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	versioned := types.Transaction{
		Signatures: []types.Signature{make([]byte, ed25519.SignatureSize)},
		Message: types.Message{
			Version:         types.MessageVersionV0,
			Header:          types.MessageHeader{NumRequireSignatures: 1},
			Accounts:        []common.PublicKey{account.PublicKey},
			RecentBlockHash: account.PublicKey.ToBase58(),
		},
	}
	raw, err := versioned.Serialize()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := signer.Sign(privateKey, raw, OperationTransaction); err == nil {
		t.Fatal("expected versioned Solana transaction to be rejected")
	}
}

func TestEthereumEIP191SignatureRecoversWalletAddress(t *testing.T) {
	signer := ethereumSigner{}
	privateKey, address, err := signer.Generate()
	if err != nil {
		t.Fatal(err)
	}
	message := []byte("hello from Spiral Safe")
	result, err := signer.Sign(privateKey, message, OperationMessage)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := base64.StdEncoding.DecodeString(result.Signature)
	if err != nil {
		t.Fatal(err)
	}
	if len(signature) != 65 || signature[64] > 1 {
		t.Fatalf("expected R || S || V with V 0/1, got %x", signature)
	}
	if recovered := recoverEthereumAddress(t, message, signature); recovered != address {
		t.Fatalf("recovered address %s, expected %s", recovered, address)
	}
}

func TestEthereumRejectsUnsupportedTransactionSigning(t *testing.T) {
	signer := ethereumSigner{}
	privateKey, _, err := signer.Generate()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := signer.Sign(privateKey, []byte("unsigned tx"), OperationTransaction); err == nil {
		t.Fatal("expected unsupported Ethereum transaction operation to fail")
	}
}

func recoverEthereumAddress(t *testing.T, message, signature []byte) string {
	t.Helper()
	prefix := []byte("\x19Ethereum Signed Message:\n" + decimalLength(len(message)))
	hasher := sha3.NewLegacyKeccak256()
	_, _ = hasher.Write(prefix)
	_, _ = hasher.Write(message)
	digest := hasher.Sum(nil)
	compact := append([]byte{27 + signature[64]}, signature[:64]...)
	publicKey, _, err := secpECDSA.RecoverCompact(compact, digest)
	if err != nil {
		t.Fatal(err)
	}
	address, err := ethereumAddressFromPublicKey(publicKey.SerializeUncompressed())
	if err != nil {
		t.Fatal(err)
	}
	return address
}

func ethereumAddressFromPublicKey(publicKey []byte) (string, error) {
	if len(publicKey) != 65 {
		return "", fmt.Errorf("invalid Ethereum public key")
	}
	hasher := sha3.NewLegacyKeccak256()
	_, _ = hasher.Write(publicKey[1:])
	return checksumEthereumAddress(hasher.Sum(nil)[12:]), nil
}

func decimalLength(value int) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	position := len(digits)
	for value > 0 {
		position--
		digits[position] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[position:])
}
