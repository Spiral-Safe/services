          ui = true

          listener "tcp" {
            tls_disable = 1
            address = "0.0.0.0:8200"
            cluster_address = "[::]:8201"
          }
          storage "file" {
            path = "/home/saber/code/solana-secret-engine/vault/data"
          }

          plugin_directory = "/home/saber/code/solana-secret-engine/vault/plugins"