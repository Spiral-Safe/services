package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testManifest(t *testing.T, mode string) *manifest {
	t.Helper()
	root := t.TempDir()
	raftPath := filepath.Join(root, "raft")
	pluginPath := filepath.Join(root, "plugins")
	if err := os.MkdirAll(raftPath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(pluginPath, 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(name string, mode os.FileMode) string {
		t.Helper()
		filename := filepath.Join(root, name)
		if err := os.WriteFile(filename, []byte("test\n"), mode); err != nil {
			t.Fatal(err)
		}
		return filename
	}

	now := time.Now().UTC().Truncate(time.Second)
	m := &manifest{
		SchemaVersion: manifestSchemaVersion,
		Image: image{
			Digest:         "sha256:" + strings.Repeat("a", 64),
			EIFSHA384:      strings.Repeat("b", 96),
			SourceRevision: strings.Repeat("c", 40),
			VeilRevision:   pinnedVeilRevision,
		},
		Node: node{
			Mode:                 mode,
			ID:                   "vault-nitro-a",
			RaftPath:             raftPath,
			PluginDirectory:      pluginPath,
			VeilAddress:          "https://vault-a.example:8443",
			APIAddress:           "https://vault-a.internal:18200",
			ClusterAddress:       "https://vault-a.internal:18201",
			LoopbackAPIBind:      "127.0.0.1:8200",
			TunnelAPIBind:        "10.0.0.2:18200",
			TunnelClusterBind:    "10.0.0.2:18201",
			DurableStorageBridge: "attested-volume-provider/v1",
			ExternalL4Route:      "private-overlay/v1",
		},
		Application: application{
			WebAuthnRPID:      "wallet.example.com",
			WebAuthnRPOrigins: []string{"https://wallet.example.com"},
		},
		TLS: tlsFiles{
			CertificateFile: write("node.crt", 0o644),
			PrivateKeyFile:  write("node.key", 0o640),
			ClientCAFile:    write("client-ca.crt", 0o644),
		},
		Seal: seal{
			Type:   "awskms",
			Region: "us-east-1",
			KeyID:  "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000000",
		},
		Admission: admission{
			IssuedAt:                now.Add(-time.Minute),
			ExpiresAt:               now.Add(10 * time.Minute),
			MinimumVoters:           3,
			RequireVeilVerification: true,
			RequireMTLS:             true,
			RequireSharedAutoUnseal: true,
		},
	}
	if mode == "join" {
		m.Leaders.APIAddresses = []string{
			"https://vault-a.internal:18200",
			"https://vault-c.internal:18200",
		}
		m.TLS.JoinCAFile = write("join-ca.crt", 0o644)
		m.TLS.JoinClientCertFile = write("join-client.crt", 0o644)
		m.TLS.JoinClientKeyFile = write("join-client.key", 0o640)
		m.TLS.LeaderServerName = "vault.internal"
	}
	return m
}

func TestBootstrapManifestAndRender(t *testing.T) {
	m := testManifest(t, "bootstrap")
	if err := m.validate(time.Now().UTC(), true, false); err != nil {
		t.Fatalf("validate: %v", err)
	}
	hcl := m.renderVaultHCL()
	for _, want := range []string{
		`node_id = "vault-nitro-a"`,
		`address = "127.0.0.1:8200"`,
		`address = "10.0.0.2:18200"`,
		`cluster_address = "10.0.0.2:18201"`,
		`tls_require_and_verify_client_cert = true`,
		`seal "awskms"`,
	} {
		if !strings.Contains(hcl, want) {
			t.Errorf("rendered HCL does not contain %q", want)
		}
	}
	if strings.Contains(hcl, "retry_join") {
		t.Fatal("bootstrap config unexpectedly contains retry_join")
	}
	if strings.Contains(hcl, m.Seal.KeyID) == false {
		t.Fatal("rendered HCL must identify the shared KMS key")
	}
	environment := m.renderEnvironment()
	if environment != "WEBAUTHN_RP_ID='wallet.example.com'\nWEBAUTHN_RP_ORIGINS='https://wallet.example.com'\n" {
		t.Fatalf("unexpected environment: %q", environment)
	}
}

func TestJoinManifestAndRender(t *testing.T) {
	m := testManifest(t, "join")
	if err := m.validate(time.Now().UTC(), true, false); err != nil {
		t.Fatalf("validate: %v", err)
	}
	hcl := m.renderVaultHCL()
	if got := strings.Count(hcl, "retry_join {"); got != 2 {
		t.Fatalf("retry_join count = %d, want 2", got)
	}
	for _, want := range []string{
		`leader_tls_servername = "vault.internal"`,
		`leader_ca_cert_file = `,
		`leader_client_cert_file = `,
		`leader_client_key_file = `,
	} {
		if !strings.Contains(hcl, want) {
			t.Errorf("rendered HCL does not contain %q", want)
		}
	}
}

func TestManifestRejectsUnsafeInputs(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*manifest)
		want   string
	}{
		{"bad node id", func(m *manifest) { m.Node.ID = `node"\npath "owned"` }, "node.id"},
		{"same ports", func(m *manifest) { m.Node.TunnelClusterBind = m.Node.TunnelAPIBind }, "separate ports"},
		{"wrong tunnel IP", func(m *manifest) { m.Node.TunnelAPIBind = "0.0.0.0:18200" }, "10.0.0.2"},
		{"expired", func(m *manifest) { m.Admission.ExpiresAt = time.Now().Add(-time.Minute) }, "expired"},
		{"long lived", func(m *manifest) { m.Admission.ExpiresAt = m.Admission.IssuedAt.Add(time.Hour) }, "30 minutes"},
		{"no persistence boundary", func(m *manifest) { m.Node.DurableStorageBridge = "" }, "durable bridge"},
		{"join without leaders", func(m *manifest) { m.Leaders.APIAddresses = nil }, "retry_join"},
		{"wrong veil pin", func(m *manifest) { m.Image.VeilRevision = strings.Repeat("d", 40) }, "pinned Veil"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := testManifest(t, "join")
			tc.mutate(m)
			err := m.validate(time.Now().UTC(), true, false)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want substring %q", err, tc.want)
			}
		})
	}
}

func TestPrivateKeyPermissions(t *testing.T) {
	m := testManifest(t, "bootstrap")
	if err := os.Chmod(m.TLS.PrivateKeyFile, 0o644); err != nil {
		t.Fatal(err)
	}
	err := m.validate(time.Now().UTC(), true, false)
	if err == nil || !strings.Contains(err.Error(), "private key") {
		t.Fatalf("error = %v, want private key permission failure", err)
	}
}

func TestTLSCertificateAndCAFilesRejectGroupOrOtherWrite(t *testing.T) {
	for _, field := range []struct {
		name string
		path func(*manifest) string
	}{
		{"node certificate", func(m *manifest) string { return m.TLS.CertificateFile }},
		{"operator CA", func(m *manifest) string { return m.TLS.ClientCAFile }},
		{"join CA", func(m *manifest) string { return m.TLS.JoinCAFile }},
		{"join client certificate", func(m *manifest) string { return m.TLS.JoinClientCertFile }},
	} {
		t.Run(field.name, func(t *testing.T) {
			m := testManifest(t, "join")
			if err := os.Chmod(field.path(m), 0o666); err != nil {
				t.Fatal(err)
			}
			err := m.validate(time.Now().UTC(), true, false)
			if err == nil || !strings.Contains(err.Error(), "writable by group or other") {
				t.Fatalf("error = %v, want TLS write-permission failure", err)
			}
		})
	}
}

func TestStrictJSONDecoderRejectsUnknownFields(t *testing.T) {
	m := testManifest(t, "bootstrap")
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	b = []byte(strings.Replace(string(b), `"schemaVersion":1`, `"schemaVersion":1,"unknown":true`, 1))
	filename := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(filename, b, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = readManifest(filename)
	if err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("error = %v, want unknown field failure", err)
	}
}

func TestReadManifestRejectsSymlinkAndWritableInput(t *testing.T) {
	m := testManifest(t, "bootstrap")
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	manifestPath := filepath.Join(root, "manifest.json")
	if err := os.WriteFile(manifestPath, b, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(manifestPath, 0o622); err != nil {
		t.Fatal(err)
	}
	if _, err := readManifest(manifestPath); err == nil || !strings.Contains(err.Error(), "writable") {
		t.Fatalf("writable manifest error = %v", err)
	}
	if err := os.Chmod(manifestPath, 0o600); err != nil {
		t.Fatal(err)
	}
	linkPath := filepath.Join(root, "manifest-link.json")
	if err := os.Symlink(manifestPath, linkPath); err != nil {
		t.Fatal(err)
	}
	if _, err := readManifest(linkPath); err == nil || !strings.Contains(err.Error(), "non-symlink") {
		t.Fatalf("symlink manifest error = %v", err)
	}
}

func TestSameImageIdentityCanDescribeDistinctRoles(t *testing.T) {
	bootstrap := testManifest(t, "bootstrap")
	joiner := testManifest(t, "join")
	joiner.Node.ID = "vault-nitro-b"
	joiner.Image = bootstrap.Image
	joiner.Seal = bootstrap.Seal
	if bootstrap.Image != joiner.Image {
		t.Fatal("same-image identity changed between roles")
	}
	if bootstrap.Seal.KeyID != joiner.Seal.KeyID {
		t.Fatal("nodes do not share the same auto-unseal key identity")
	}
	if bootstrap.Node.ID == joiner.Node.ID {
		t.Fatal("node IDs must be unique")
	}
}
