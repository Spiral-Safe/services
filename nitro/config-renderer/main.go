package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	manifestSchemaVersion = 1
	pinnedVeilRevision    = "2b8c06ca651e09b21832f6fc4ae2605371386f76"
	veilEnclaveIP         = "10.0.0.2"
	maximumBundleLifetime = 30 * time.Minute
)

var (
	nodeIDPattern        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`)
	digestPattern        = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	sha384Pattern        = regexp.MustCompile(`^[0-9a-f]{96}$`)
	revisionPattern      = regexp.MustCompile(`^[0-9a-f]{40}$`)
	dnsNamePattern       = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)
	awsRegionPattern     = regexp.MustCompile(`^[a-z]{2}(?:-gov)?-[a-z]+-\d$`)
	kmsKeyIDPattern      = regexp.MustCompile(`^[A-Za-z0-9:/_.+=,@-]{8,512}$`)
	extensionHostPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$`)
	allowedNodeModes     = map[string]bool{"bootstrap": true, "join": true}
)

type manifest struct {
	SchemaVersion int         `json:"schemaVersion"`
	Image         image       `json:"image"`
	Node          node        `json:"node"`
	Application   application `json:"application"`
	TLS           tlsFiles    `json:"tls"`
	Leaders       leaders     `json:"leaders"`
	Seal          seal        `json:"seal"`
	Admission     admission   `json:"admission"`
}

type image struct {
	Digest         string `json:"digest"`
	EIFSHA384      string `json:"eifSha384"`
	SourceRevision string `json:"sourceRevision"`
	VeilRevision   string `json:"veilRevision"`
}

type node struct {
	Mode                 string `json:"mode"`
	ID                   string `json:"id"`
	RaftPath             string `json:"raftPath"`
	PluginDirectory      string `json:"pluginDirectory"`
	VeilAddress          string `json:"veilAddress"`
	APIAddress           string `json:"apiAddress"`
	ClusterAddress       string `json:"clusterAddress"`
	LoopbackAPIBind      string `json:"loopbackApiBind"`
	TunnelAPIBind        string `json:"tunnelApiBind"`
	TunnelClusterBind    string `json:"tunnelClusterBind"`
	DurableStorageBridge string `json:"durableStorageBridge"`
	ExternalL4Route      string `json:"externalL4Route"`
}

type application struct {
	WebAuthnRPID      string   `json:"webAuthnRpId"`
	WebAuthnRPOrigins []string `json:"webAuthnRpOrigins"`
}

type tlsFiles struct {
	CertificateFile    string `json:"certificateFile"`
	PrivateKeyFile     string `json:"privateKeyFile"`
	ClientCAFile       string `json:"clientCAFile"`
	JoinCAFile         string `json:"joinCAFile"`
	JoinClientCertFile string `json:"joinClientCertFile"`
	JoinClientKeyFile  string `json:"joinClientKeyFile"`
	LeaderServerName   string `json:"leaderServerName"`
}

type leaders struct {
	APIAddresses []string `json:"apiAddresses"`
}

type seal struct {
	Type   string `json:"type"`
	Region string `json:"region"`
	KeyID  string `json:"keyId"`
}

type admission struct {
	IssuedAt                time.Time `json:"issuedAt"`
	ExpiresAt               time.Time `json:"expiresAt"`
	MinimumVoters           int       `json:"minimumVoters"`
	RequireVeilVerification bool      `json:"requireVeilVerification"`
	RequireMTLS             bool      `json:"requireMTLS"`
	RequireSharedAutoUnseal bool      `json:"requireSharedAutoUnseal"`
}

func main() {
	var inputPath string
	var outputPath string
	var envOutputPath string
	var validateOnly bool
	var checkFiles bool
	var allowExpired bool

	flag.StringVar(&inputPath, "input", "", "path to the strict node manifest")
	flag.StringVar(&outputPath, "output", "", "path for the rendered Vault HCL")
	flag.StringVar(&envOutputPath, "env-output", "", "path for the validated plugin environment")
	flag.BoolVar(&validateOnly, "validate-only", false, "validate without rendering")
	flag.BoolVar(&checkFiles, "check-files", true, "require referenced TLS and storage paths to exist")
	flag.BoolVar(&allowExpired, "allow-expired", false, "allow an expired manifest for post-start audit only")
	flag.Parse()

	if inputPath == "" {
		fatal(errors.New("-input is required"))
	}
	if !validateOnly && (outputPath == "" || envOutputPath == "") {
		fatal(errors.New("-output and -env-output are required unless -validate-only is used"))
	}
	if allowExpired && !validateOnly {
		fatal(errors.New("-allow-expired is valid only with -validate-only"))
	}

	m, err := readManifest(inputPath)
	if err != nil {
		fatal(err)
	}
	if err := m.validate(time.Now().UTC(), checkFiles, allowExpired); err != nil {
		fatal(err)
	}
	if validateOnly {
		return
	}

	hcl := m.renderVaultHCL()
	environment := m.renderEnvironment()
	if err := atomicWrite(envOutputPath, []byte(environment), 0o600); err != nil {
		fatal(err)
	}
	if err := atomicWrite(outputPath, []byte(hcl), 0o600); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	_, _ = fmt.Fprintf(os.Stderr, "spiral-node-config: %v\n", err)
	os.Exit(2)
}

func readManifest(filename string) (*manifest, error) {
	info, err := os.Lstat(filename)
	if err != nil {
		return nil, fmt.Errorf("inspect manifest: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return nil, errors.New("manifest must be a regular non-symlink file")
	}
	if info.Mode().Perm()&0o022 != 0 {
		return nil, errors.New("manifest must not be writable by group or other users")
	}

	f, err := os.Open(filename)
	if err != nil {
		return nil, fmt.Errorf("open manifest: %w", err)
	}
	defer func() { _ = f.Close() }()

	dec := json.NewDecoder(io.LimitReader(f, 128*1024))
	dec.DisallowUnknownFields()
	var m manifest
	if err := dec.Decode(&m); err != nil {
		return nil, fmt.Errorf("decode manifest: %w", err)
	}
	if err := ensureJSONEOF(dec); err != nil {
		return nil, err
	}
	return &m, nil
}

func ensureJSONEOF(dec *json.Decoder) error {
	var extra any
	err := dec.Decode(&extra)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("manifest contains more than one JSON value")
	}
	return fmt.Errorf("decode trailing manifest data: %w", err)
}

func (m *manifest) validate(now time.Time, checkFiles, allowExpired bool) error {
	var problems []string
	add := func(ok bool, message string) {
		if !ok {
			problems = append(problems, message)
		}
	}

	add(m.SchemaVersion == manifestSchemaVersion, "schemaVersion must be 1")
	add(digestPattern.MatchString(m.Image.Digest), "image.digest must be a lowercase sha256 digest")
	add(sha384Pattern.MatchString(m.Image.EIFSHA384), "image.eifSha384 must be 96 lowercase hex characters")
	add(revisionPattern.MatchString(m.Image.SourceRevision), "image.sourceRevision must be a 40-character lowercase Git revision")
	add(!allZero(strings.TrimPrefix(m.Image.Digest, "sha256:")), "image.digest must not be an all-zero placeholder")
	add(!allZero(m.Image.EIFSHA384), "image.eifSha384 must not be an all-zero placeholder")
	add(!allZero(m.Image.SourceRevision), "image.sourceRevision must not be an all-zero placeholder")
	add(m.Image.VeilRevision == pinnedVeilRevision, "image.veilRevision does not match the pinned Veil revision")

	add(allowedNodeModes[m.Node.Mode], "node.mode must be bootstrap or join")
	add(nodeIDPattern.MatchString(m.Node.ID), "node.id must be 1-63 safe identifier characters")
	add(validAbsoluteCleanPath(m.Node.RaftPath), "node.raftPath must be a clean absolute path")
	add(validAbsoluteCleanPath(m.Node.PluginDirectory), "node.pluginDirectory must be a clean absolute path")
	add(validHTTPSURL(m.Node.VeilAddress), "node.veilAddress must be an HTTPS origin with an explicit port")
	add(validHTTPSURL(m.Node.APIAddress), "node.apiAddress must be an HTTPS origin with an explicit port")
	add(validHTTPSURL(m.Node.ClusterAddress), "node.clusterAddress must be an HTTPS origin with an explicit port")
	add(m.Node.APIAddress != m.Node.ClusterAddress, "node API and cluster addresses must be different")
	add(m.Node.LoopbackAPIBind == "127.0.0.1:8200", "node.loopbackApiBind must be 127.0.0.1:8200")
	add(m.Node.TunnelAPIBind == veilEnclaveIP+":18200", "node.tunnelApiBind must be 10.0.0.2:18200")
	add(m.Node.TunnelClusterBind == veilEnclaveIP+":18201", "node.tunnelClusterBind must be 10.0.0.2:18201")
	add(m.Node.TunnelAPIBind != m.Node.TunnelClusterBind, "tunnel API and cluster binds must use separate ports")
	add(m.Node.DurableStorageBridge != "", "node.durableStorageBridge must name an externally reviewed durable bridge")
	add(m.Node.ExternalL4Route != "", "node.externalL4Route must name the operator-managed cross-host L4 route")
	add(!isPlaceholder(m.Node.DurableStorageBridge), "node.durableStorageBridge still contains a placeholder")
	add(!isPlaceholder(m.Node.ExternalL4Route), "node.externalL4Route still contains a placeholder")
	add(m.Application.WebAuthnRPID == "localhost" || dnsNamePattern.MatchString(m.Application.WebAuthnRPID), "application.webAuthnRpId must be localhost or a DNS name")
	add(!isPlaceholder(m.Application.WebAuthnRPID), "application.webAuthnRpId still contains a placeholder")
	add(len(m.Application.WebAuthnRPOrigins) > 0, "application.webAuthnRpOrigins must not be empty")
	seenOrigins := make(map[string]bool)
	for _, origin := range m.Application.WebAuthnRPOrigins {
		add(validWebOrigin(origin), "every application.webAuthnRpOrigins entry must be a secure origin")
		add(!seenOrigins[origin], "application.webAuthnRpOrigins entries must be unique")
		seenOrigins[origin] = true
	}

	add(validAbsoluteCleanPath(m.TLS.CertificateFile), "tls.certificateFile must be a clean absolute path")
	add(validAbsoluteCleanPath(m.TLS.PrivateKeyFile), "tls.privateKeyFile must be a clean absolute path")
	add(validAbsoluteCleanPath(m.TLS.ClientCAFile), "tls.clientCAFile must be a clean absolute path")
	add(m.TLS.LeaderServerName == "" || dnsNamePattern.MatchString(m.TLS.LeaderServerName), "tls.leaderServerName must be a DNS name")

	if m.Node.Mode == "bootstrap" {
		add(len(m.Leaders.APIAddresses) == 0, "bootstrap manifests must not contain retry_join leaders")
		add(m.TLS.JoinCAFile == "" && m.TLS.JoinClientCertFile == "" && m.TLS.JoinClientKeyFile == "" && m.TLS.LeaderServerName == "", "bootstrap manifests must not contain join TLS inputs")
	} else {
		add(len(m.Leaders.APIAddresses) > 0, "join manifests require at least one retry_join leader")
		add(validAbsoluteCleanPath(m.TLS.JoinCAFile), "tls.joinCAFile must be a clean absolute path for join mode")
		add(validAbsoluteCleanPath(m.TLS.JoinClientCertFile), "tls.joinClientCertFile must be a clean absolute path for join mode")
		add(validAbsoluteCleanPath(m.TLS.JoinClientKeyFile), "tls.joinClientKeyFile must be a clean absolute path for join mode")
		add(dnsNamePattern.MatchString(m.TLS.LeaderServerName), "tls.leaderServerName is required for join mode")
	}

	seenLeaders := make(map[string]bool)
	for _, leader := range m.Leaders.APIAddresses {
		add(validHTTPSURL(leader), "every leaders.apiAddresses entry must be an HTTPS origin with an explicit port")
		add(!seenLeaders[leader], "leaders.apiAddresses entries must be unique")
		seenLeaders[leader] = true
	}

	add(m.Seal.Type == "awskms", "seal.type must be awskms")
	add(awsRegionPattern.MatchString(m.Seal.Region), "seal.region must be an AWS region")
	add(kmsKeyIDPattern.MatchString(m.Seal.KeyID), "seal.keyId must be a KMS ARN, alias, or key identifier")
	add(!isPlaceholder(m.Seal.KeyID), "seal.keyId still contains a placeholder")

	issued := m.Admission.IssuedAt.UTC()
	expires := m.Admission.ExpiresAt.UTC()
	add(!issued.IsZero(), "admission.issuedAt is required")
	add(!expires.IsZero(), "admission.expiresAt is required")
	add(expires.After(issued), "admission.expiresAt must be after issuedAt")
	add(expires.Sub(issued) <= maximumBundleLifetime, "admission bundle lifetime must not exceed 30 minutes")
	add(!issued.After(now.Add(time.Minute)), "admission.issuedAt is too far in the future")
	add(allowExpired || expires.After(now), "admission bundle has expired")
	add(m.Admission.MinimumVoters >= 3 && m.Admission.MinimumVoters%2 == 1, "admission.minimumVoters must be an odd number of at least 3")
	add(m.Admission.RequireVeilVerification, "admission.requireVeilVerification must be true")
	add(m.Admission.RequireMTLS, "admission.requireMTLS must be true")
	add(m.Admission.RequireSharedAutoUnseal, "admission.requireSharedAutoUnseal must be true")

	if checkFiles {
		for _, candidate := range []struct {
			name       string
			path       string
			directory  bool
			privateKey bool
		}{
			{"node.raftPath", m.Node.RaftPath, true, false},
			{"node.pluginDirectory", m.Node.PluginDirectory, true, false},
			{"tls.certificateFile", m.TLS.CertificateFile, false, false},
			{"tls.privateKeyFile", m.TLS.PrivateKeyFile, false, true},
			{"tls.clientCAFile", m.TLS.ClientCAFile, false, false},
			{"tls.joinCAFile", m.TLS.JoinCAFile, false, false},
			{"tls.joinClientCertFile", m.TLS.JoinClientCertFile, false, false},
			{"tls.joinClientKeyFile", m.TLS.JoinClientKeyFile, false, true},
		} {
			if candidate.path == "" {
				continue
			}
			if err := validateReferencedPath(candidate.path, candidate.directory, candidate.privateKey); err != nil {
				problems = append(problems, candidate.name+": "+err.Error())
			}
		}
	}

	if len(problems) > 0 {
		sort.Strings(problems)
		return errors.New(strings.Join(problems, "; "))
	}
	return nil
}

func validAbsoluteCleanPath(value string) bool {
	return value != "" && filepath.IsAbs(value) && filepath.Clean(value) == value && !strings.ContainsAny(value, "\n\r\x00")
}

func allZero(value string) bool {
	return value != "" && strings.Trim(value, "0") == ""
}

func isPlaceholder(value string) bool {
	upper := strings.ToUpper(value)
	return strings.Contains(upper, "REPLACE") || strings.Contains(upper, "REQUIRED_")
}

func validHTTPSURL(value string) bool {
	if isPlaceholder(value) {
		return false
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	host, port, err := net.SplitHostPort(u.Host)
	if err != nil || host == "" || port == "" {
		return false
	}
	if strings.HasSuffix(strings.ToLower(host), ".invalid") {
		return false
	}
	portNumber, err := strconv.Atoi(port)
	return err == nil && portNumber > 0 && portNumber < 65536
}

func validWebOrigin(value string) bool {
	if isPlaceholder(value) {
		return false
	}
	u, err := url.Parse(value)
	if err != nil || u.User != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	hostname := strings.ToLower(u.Hostname())
	if u.Scheme == "chrome-extension" || u.Scheme == "moz-extension" {
		return u.Port() == "" && extensionHostPattern.MatchString(hostname)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return false
	}
	if hostname == "" || strings.HasSuffix(hostname, ".invalid") || (net.ParseIP(hostname) == nil && !dnsNamePattern.MatchString(hostname)) {
		return false
	}
	if port := u.Port(); port != "" {
		portNumber, err := strconv.Atoi(port)
		if err != nil || portNumber < 1 || portNumber > 65535 {
			return false
		}
	}
	return u.Scheme == "https" || hostname == "localhost" || hostname == "127.0.0.1" || hostname == "::1"
}

func validateReferencedPath(value string, wantDirectory, privateKey bool) error {
	info, err := os.Lstat(value)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("symbolic links are not accepted")
	}
	if wantDirectory && !info.IsDir() {
		return errors.New("must be a directory")
	}
	if !wantDirectory && !info.Mode().IsRegular() {
		return errors.New("must be a regular file")
	}
	if info.Mode().Perm()&0o022 != 0 {
		return errors.New("must not be writable by group or other users")
	}
	if privateKey {
		if info.Mode().Perm()&0o007 != 0 {
			return errors.New("private key must not be accessible by other users")
		}
	}
	return nil
}

func (m *manifest) renderVaultHCL() string {
	var b strings.Builder
	q := strconv.Quote

	fmt.Fprintln(&b, "# Generated from a short-lived, validated node manifest. Do not edit.")
	fmt.Fprintln(&b, "ui = false")
	fmt.Fprintln(&b, "disable_mlock = true")
	fmt.Fprintf(&b, "api_addr = %s\n", q(m.Node.APIAddress))
	fmt.Fprintf(&b, "cluster_addr = %s\n", q(m.Node.ClusterAddress))
	fmt.Fprintf(&b, "plugin_directory = %s\n\n", q(m.Node.PluginDirectory))

	fmt.Fprintln(&b, "listener \"tcp\" {")
	fmt.Fprintf(&b, "  address = %s\n", q(m.Node.LoopbackAPIBind))
	fmt.Fprintln(&b, "  tls_disable = 1")
	fmt.Fprintln(&b, "}")
	fmt.Fprintln(&b)

	fmt.Fprintln(&b, "listener \"tcp\" {")
	fmt.Fprintf(&b, "  address = %s\n", q(m.Node.TunnelAPIBind))
	fmt.Fprintf(&b, "  cluster_address = %s\n", q(m.Node.TunnelClusterBind))
	fmt.Fprintf(&b, "  tls_cert_file = %s\n", q(m.TLS.CertificateFile))
	fmt.Fprintf(&b, "  tls_key_file = %s\n", q(m.TLS.PrivateKeyFile))
	fmt.Fprintf(&b, "  tls_client_ca_file = %s\n", q(m.TLS.ClientCAFile))
	fmt.Fprintln(&b, "  tls_require_and_verify_client_cert = true")
	fmt.Fprintln(&b, "}")
	fmt.Fprintln(&b)

	fmt.Fprintln(&b, "storage \"raft\" {")
	fmt.Fprintf(&b, "  path = %s\n", q(m.Node.RaftPath))
	fmt.Fprintf(&b, "  node_id = %s\n", q(m.Node.ID))
	for _, leader := range m.Leaders.APIAddresses {
		fmt.Fprintln(&b)
		fmt.Fprintln(&b, "  retry_join {")
		fmt.Fprintf(&b, "    leader_api_addr = %s\n", q(leader))
		fmt.Fprintf(&b, "    leader_tls_servername = %s\n", q(m.TLS.LeaderServerName))
		fmt.Fprintf(&b, "    leader_ca_cert_file = %s\n", q(m.TLS.JoinCAFile))
		fmt.Fprintf(&b, "    leader_client_cert_file = %s\n", q(m.TLS.JoinClientCertFile))
		fmt.Fprintf(&b, "    leader_client_key_file = %s\n", q(m.TLS.JoinClientKeyFile))
		fmt.Fprintln(&b, "  }")
	}
	fmt.Fprintln(&b, "}")
	fmt.Fprintln(&b)

	fmt.Fprintln(&b, "seal \"awskms\" {")
	fmt.Fprintf(&b, "  region = %s\n", q(m.Seal.Region))
	fmt.Fprintf(&b, "  kms_key_id = %s\n", q(m.Seal.KeyID))
	fmt.Fprintln(&b, "}")
	fmt.Fprintln(&b)
	fmt.Fprintln(&b, "telemetry {")
	fmt.Fprintln(&b, "  disable_hostname = true")
	fmt.Fprintln(&b, "  prometheus_retention_time = \"30s\"")
	fmt.Fprintln(&b, "}")

	return b.String()
}

func (m *manifest) renderEnvironment() string {
	return fmt.Sprintf(
		"WEBAUTHN_RP_ID='%s'\nWEBAUTHN_RP_ORIGINS='%s'\n",
		m.Application.WebAuthnRPID,
		strings.Join(m.Application.WebAuthnRPOrigins, ","),
	)
}

func atomicWrite(filename string, data []byte, mode os.FileMode) (err error) {
	if !validAbsoluteCleanPath(filename) {
		return errors.New("output path must be a clean absolute path")
	}
	if info, statErr := os.Lstat(filename); statErr == nil && info.Mode()&os.ModeSymlink != 0 {
		return errors.New("refusing to replace a symbolic-link output")
	} else if statErr != nil && !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	}

	directory := filepath.Dir(filename)
	tmp, err := os.CreateTemp(directory, ".spiral-node-config-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()
	if err := tmp.Chmod(mode); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, filename)
}
