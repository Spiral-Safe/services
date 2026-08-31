#!/usr/bin/env bash
set -euo pipefail

readonly pinned_veil_revision="2b8c06ca651e09b21832f6fc4ae2605371386f76"

usage() {
  cat >&2 <<'USAGE'
Usage:
  enroll-node.sh verify MANIFEST EIF SOURCE_DIR
  enroll-node.sh admit MANIFEST EIF SOURCE_DIR
  enroll-node.sh check MANIFEST

verify proves that a clean source checkout and the running Veil enclave match.
admit performs the same proof, then invokes SPIRAL_ENROLLMENT_HOOK and prints
only the short-lived bundle reference returned by that executable.
check verifies Vault auto-unseal, Raft voter membership, and Autopilot health
over the manifest's separate mTLS API endpoint.
USAGE
}

die() {
  echo "enroll-node: $*" >&2
  exit 1
}

resolve_executable() {
  local requested="$1"
  local description="$2"
  if [[ "${requested}" == */* ]]; then
    [[ -x "${requested}" ]] || die "${description} is not executable: ${requested}"
    printf '%s\n' "${requested}"
    return
  fi
  command -v "${requested}" 2>/dev/null || die "${description} is not installed: ${requested}"
}

sha384_file() {
  local filename="$1"
  if command -v sha384sum >/dev/null 2>&1; then
    sha384sum "${filename}" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 384 "${filename}" | awk '{print $1}'
    return
  fi
  die "sha384sum or shasum is required"
}

validate_manifest() {
  local manifest_file="$1"
  local allow_expired="$2"
  local node_config_bin="$3"
  local args=(
    -input "${manifest_file}"
    -validate-only
    -check-files=false
  )
  if [[ "${allow_expired}" == "true" ]]; then
    args+=(-allow-expired)
  fi
  "${node_config_bin}" "${args[@]}"
}

verify_attested_source() {
  local manifest_file="$1"
  local image_eif="$2"
  local source_dir="$3"
  local node_config_bin="$4"
  local jq_bin="$5"
  local git_bin="$6"
  local veil_verify_bin="$7"

  [[ -f "${manifest_file}" && ! -L "${manifest_file}" ]] || die "manifest must be a regular non-symlink file"
  [[ -f "${image_eif}" && ! -L "${image_eif}" ]] || die "EIF must be a regular non-symlink file"
  [[ -d "${source_dir}" && ! -L "${source_dir}" ]] || die "source directory must be a non-symlink directory"

  validate_manifest "${manifest_file}" false "${node_config_bin}"

  local expected_veil_revision
  local expected_source_revision
  local expected_eif_sha384
  local veil_address
  expected_veil_revision="$(${jq_bin} -er '.image.veilRevision' "${manifest_file}")"
  expected_source_revision="$(${jq_bin} -er '.image.sourceRevision' "${manifest_file}")"
  expected_eif_sha384="$(${jq_bin} -er '.image.eifSha384' "${manifest_file}")"
  veil_address="$(${jq_bin} -er '.node.veilAddress' "${manifest_file}")"

  [[ "${expected_veil_revision}" == "${pinned_veil_revision}" ]] || die "manifest Veil revision is not pinned"
  [[ "$(${git_bin} -C "${source_dir}" rev-parse HEAD)" == "${expected_source_revision}" ]] || die "source checkout revision does not match manifest"
  [[ -z "$(${git_bin} -C "${source_dir}" status --porcelain --untracked-files=all)" ]] || die "source checkout must be clean before reproducible verification"
  [[ ! -e "${source_dir}/enclave.tar" ]] || die "source checkout already contains enclave.tar; use a disposable clean checkout"

  local actual_eif_sha384
  actual_eif_sha384="$(sha384_file "${image_eif}")"
  [[ "${actual_eif_sha384}" == "${expected_eif_sha384}" ]] || die "EIF SHA-384 does not match manifest"

  echo "Verifying pinned Veil source, EIF measurements, nonce freshness, and TLS binding..." >&2
  if ! "${veil_verify_bin}" \
    -addr "${veil_address}" \
    -dir "${source_dir}" \
    -dockerfile nitro/Dockerfile 1>&2; then
    if [[ -f "${source_dir}/enclave.tar" && ! -L "${source_dir}/enclave.tar" ]]; then
      rm -f -- "${source_dir}/enclave.tar"
    fi
    die "Veil source or attestation verification failed; enrollment hook was not invoked"
  fi
  if [[ -f "${source_dir}/enclave.tar" && ! -L "${source_dir}/enclave.tar" ]]; then
    rm -f -- "${source_dir}/enclave.tar"
  fi
  echo "Veil source and attestation verification succeeded." >&2
  printf '%s\n' "${actual_eif_sha384}"
}

validate_bundle_reference() {
  local bundle_reference="$1"
  [[ ${#bundle_reference} -le 512 ]] || return 1
  [[ "${bundle_reference}" != *$'\n'* && "${bundle_reference}" != *$'\r'* ]] || return 1
  [[ "${bundle_reference}" =~ ^file:/[A-Za-z0-9._/@+-]+$ || "${bundle_reference}" =~ ^secret-ref://[A-Za-z0-9._/@:+-]+$ ]]
}

require_vault_environment() {
  local variable_name
  for variable_name in VAULT_CACERT VAULT_CLIENT_CERT VAULT_CLIENT_KEY VAULT_TLS_SERVER_NAME VAULT_TOKEN; do
    [[ -n "${!variable_name:-}" ]] || die "${variable_name} is required for membership checks"
  done
  for variable_name in VAULT_CACERT VAULT_CLIENT_CERT VAULT_CLIENT_KEY; do
    [[ -f "${!variable_name}" && ! -L "${!variable_name}" ]] || die "${variable_name} must reference a regular non-symlink file"
  done
}

check_membership_once() {
  local jq_bin="$1"
  local vault_bin="$2"
  local node_id="$3"
  local api_address="$4"
  local cluster_address="$5"
  local minimum_voters="$6"

  local status_json
  local peers_json
  local autopilot_json
  status_json="$(
    VAULT_ADDR="${api_address}" \
      VAULT_CACERT="${VAULT_CACERT}" \
      VAULT_CLIENT_CERT="${VAULT_CLIENT_CERT}" \
      VAULT_CLIENT_KEY="${VAULT_CLIENT_KEY}" \
      VAULT_TLS_SERVER_NAME="${VAULT_TLS_SERVER_NAME}" \
      VAULT_TOKEN="${VAULT_TOKEN}" \
      "${vault_bin}" status -format=json 2>/dev/null
  )" || return 1
  "${jq_bin}" -e '
    .initialized == true and
    .sealed == false and
    .storage_type == "raft" and
    .seal_type == "awskms"
  ' <<<"${status_json}" >/dev/null || return 1

  peers_json="$(
    VAULT_ADDR="${api_address}" \
      VAULT_CACERT="${VAULT_CACERT}" \
      VAULT_CLIENT_CERT="${VAULT_CLIENT_CERT}" \
      VAULT_CLIENT_KEY="${VAULT_CLIENT_KEY}" \
      VAULT_TLS_SERVER_NAME="${VAULT_TLS_SERVER_NAME}" \
      VAULT_TOKEN="${VAULT_TOKEN}" \
      "${vault_bin}" operator raft list-peers -format=json 2>/dev/null
  )" || return 1
  local voter_count
  voter_count="$(
    "${jq_bin}" -er '
      def servers: (.data.config.servers // .data.servers // .servers // []);
      [servers[] | select(.voter == true)] | length
    ' <<<"${peers_json}"
  )" || return 1
  [[ "${voter_count}" =~ ^[0-9]+$ ]] || return 1
  (( voter_count >= minimum_voters && voter_count % 2 == 1 )) || return 1
  local cluster_host_port="${cluster_address#https://}"
  # shellcheck disable=SC2016 # jq variables are expanded by jq, not Bash.
  "${jq_bin}" -e \
    --arg node_id "${node_id}" \
    --arg cluster_address "${cluster_host_port}" '
      def servers: (.data.config.servers // .data.servers // .servers // []);
      ([servers[] | select(
        .node_id == $node_id and
        .address == $cluster_address and
        .voter == true
      )] | length) == 1
    ' <<<"${peers_json}" >/dev/null || return 1

  autopilot_json="$(
    VAULT_ADDR="${api_address}" \
      VAULT_CACERT="${VAULT_CACERT}" \
      VAULT_CLIENT_CERT="${VAULT_CLIENT_CERT}" \
      VAULT_CLIENT_KEY="${VAULT_CLIENT_KEY}" \
      VAULT_TLS_SERVER_NAME="${VAULT_TLS_SERVER_NAME}" \
      VAULT_TOKEN="${VAULT_TOKEN}" \
      "${vault_bin}" operator raft autopilot state -format=json 2>/dev/null
  )" || return 1
  local required_failure_tolerance="$(( (voter_count - 1) / 2 ))"
  # shellcheck disable=SC2016 # jq variables are expanded by jq, not Bash.
  "${jq_bin}" -e \
    --arg node_id "${node_id}" \
    --argjson required_failure_tolerance "${required_failure_tolerance}" '
      def root: (.data // .);
      def node_healthy:
        (root.servers // {}) as $servers |
        if ($servers | type) == "object" then
          (($servers[$node_id].healthy // false) == true)
        elif ($servers | type) == "array" then
          any($servers[]; ((.id // .name) == $node_id) and .healthy == true)
        else
          false
        end;
      root.healthy == true and
      (root.failure_tolerance // -1) >= $required_failure_tolerance and
      node_healthy
    ' <<<"${autopilot_json}" >/dev/null || return 1

  # shellcheck disable=SC2016 # jq variables are expanded by jq, not Bash.
  "${jq_bin}" -cn \
    --arg nodeId "${node_id}" \
    --arg apiAddress "${api_address}" \
    --arg clusterAddress "${cluster_address}" \
    --argjson minimumVoters "${minimum_voters}" \
    --argjson voterCount "${voter_count}" \
    '{status:"healthy",nodeId:$nodeId,apiAddress:$apiAddress,clusterAddress:$clusterAddress,minimumVoters:$minimumVoters,voterCount:$voterCount}'
}

check_membership() {
  local manifest_file="$1"
  local node_config_bin="$2"
  local jq_bin="$3"
  local vault_bin="$4"

  [[ -f "${manifest_file}" && ! -L "${manifest_file}" ]] || die "manifest must be a regular non-symlink file"
  validate_manifest "${manifest_file}" true "${node_config_bin}"
  require_vault_environment

  local node_id
  local api_address
  local cluster_address
  local minimum_voters
  node_id="$(${jq_bin} -er '.node.id' "${manifest_file}")"
  api_address="$(${jq_bin} -er '.node.apiAddress' "${manifest_file}")"
  cluster_address="$(${jq_bin} -er '.node.clusterAddress' "${manifest_file}")"
  minimum_voters="$(${jq_bin} -er '.admission.minimumVoters' "${manifest_file}")"

  local wait_seconds="${SPIRAL_MEMBERSHIP_WAIT_SECONDS:-180}"
  [[ "${wait_seconds}" =~ ^[0-9]+$ && "${wait_seconds}" -le 3600 ]] || die "SPIRAL_MEMBERSHIP_WAIT_SECONDS must be 0-3600"
  local deadline="$((SECONDS + wait_seconds))"
  while true; do
    if check_membership_once \
      "${jq_bin}" \
      "${vault_bin}" \
      "${node_id}" \
      "${api_address}" \
      "${cluster_address}" \
      "${minimum_voters}"; then
      return
    fi
    if (( SECONDS >= deadline )); then
      die "Vault did not reach unsealed Raft voter and healthy Autopilot state before timeout"
    fi
    sleep 5
  done
}

main() {
  [[ "$#" -ge 2 ]] || {
    usage
    exit 2
  }
  local action="$1"
  local manifest_file="$2"

  local script_dir
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  local node_config_bin
  local jq_bin
  node_config_bin="$(resolve_executable "${SPIRAL_NODE_CONFIG_BIN:-${script_dir}/.tools/spiral-node-config}" "spiral-node-config")"
  jq_bin="$(resolve_executable "${JQ_BIN:-jq}" "jq")"

  case "${action}" in
    verify | admit)
      [[ "$#" -eq 4 ]] || {
        usage
        exit 2
      }
      local image_eif="$3"
      local source_dir="$4"
      local git_bin
      local veil_verify_bin
      git_bin="$(resolve_executable "${GIT_BIN:-git}" "git")"
      veil_verify_bin="$(resolve_executable "${VEIL_VERIFY_BIN:-${script_dir}/.tools/veil-verify}" "veil-verify")"
      local verified_eif_sha384
      verified_eif_sha384="$(verify_attested_source \
        "${manifest_file}" \
        "${image_eif}" \
        "${source_dir}" \
        "${node_config_bin}" \
        "${jq_bin}" \
        "${git_bin}" \
        "${veil_verify_bin}")"
      if [[ "${action}" == "verify" ]]; then
        echo "Admission precondition verified; no identity or bundle was released." >&2
        return
      fi

      local enrollment_hook="${SPIRAL_ENROLLMENT_HOOK:-}"
      [[ "${enrollment_hook}" == /* && -x "${enrollment_hook}" ]] || die "SPIRAL_ENROLLMENT_HOOK must be an absolute executable path"
      local node_id
      node_id="$(${jq_bin} -er '.node.id' "${manifest_file}")"
      local bundle_reference
      bundle_reference="$(
        SPIRAL_VERIFIED_NODE_ID="${node_id}" \
          SPIRAL_VERIFIED_EIF_SHA384="${verified_eif_sha384}" \
          "${enrollment_hook}" "${manifest_file}" 2>/dev/null
      )" || die "enrollment hook failed after Veil verification"
      validate_bundle_reference "${bundle_reference}" || die "enrollment hook must return exactly one safe short-lived file: or secret-ref:// reference"
      printf '%s\n' "${bundle_reference}"
      ;;
    check)
      [[ "$#" -eq 2 ]] || {
        usage
        exit 2
      }
      local vault_bin
      vault_bin="$(resolve_executable "${VAULT_BIN:-vault}" "vault")"
      check_membership "${manifest_file}" "${node_config_bin}" "${jq_bin}" "${vault_bin}"
      ;;
    *)
      usage
      exit 2
      ;;
  esac
}

main "$@"
