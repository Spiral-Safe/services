ui = true
cluster_addr = "http://127.0.0.1:8201"
api_addr      = "https://127.0.0.1:8200"
disable_mlock = true

listener "tcp" {
    tls_disable = 1
    address = "0.0.0.0:8200"
    cluster_address = "0.0.0.0:8201"
}
storage "raft" {
  path = "/vault/"
  node_id = "raft_node_1"
}

plugin_directory = "/vault/plugins"

seal "awskms" {
    region     = "us-east-2"
    access_key = ""
    secret_key = ""
    kms_key_id = "5ccb4727-8f87-4e65-a84d-7676e7d97f21"
}