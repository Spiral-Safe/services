ui = false
disable_mlock = true
api_addr = "http://127.0.0.1:8200"
cluster_addr = "http://127.0.0.1:8201"
plugin_directory = "/vault/plugins"

listener "tcp" {
  address = "127.0.0.1:8200"
  cluster_address = "127.0.0.1:8201"
  tls_disable = 1
}

# Nitro Enclaves do not provide persistent storage. This Raft directory makes
# the adapter bootable, but it is destroyed with the enclave and must not hold
# production keys without an attested external persistence protocol.
storage "raft" {
  path = "/vault/data"
  node_id = "spiral-safe-enclave"
}
