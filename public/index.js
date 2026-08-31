let signingPayload = "";
let signingOperation = "transaction";
let authenticationCeremonyId = "";

let host = "";
let hostError = "";
try {
  host = resolveServiceOrigin();
} catch (error) {
  hostError = error instanceof Error ? error.message : "Invalid API origin";
}

function notify(message, variant = "primary", _icon, duration = 4000) {
  const region = document.getElementById("notifications");
  const alert = document.createElement("div");
  alert.className = `notice ${variant}`;
  alert.setAttribute("role", variant === "danger" ? "alert" : "status");
  alert.textContent = String(message);
  region.append(alert);
  window.setTimeout(() => alert.remove(), duration);
  return alert;
}

function resolveServiceOrigin() {
  const candidate =
    new URLSearchParams(window.location.search).get("api") ||
    "http://localhost:3000";
  const url = new URL(candidate);
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (
    url.protocol !== "http:" ||
    !loopback.has(url.hostname) ||
    url.hostname !== window.location.hostname ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "The local demo API must be a plain-HTTP loopback origin on the same host.",
    );
  }
  return url.origin;
}

function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function bytesToBase64URL(bytes) {
  return bytesToBase64(bytes)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64URLToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function apiToken() {
  return document.getElementById("api-token").value;
}

async function apiFetch(path, body) {
  if (!host) throw new Error(hostError || "The local API origin is invalid");
  const response = await fetch(`${host}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      json?.error?.message || `${path} failed with status ${response.status}`,
    );
  }
  return json;
}

function prepareCreationOptions(options) {
  options.publicKey.user.id = base64URLToBytes(options.publicKey.user.id);
  options.publicKey.challenge = base64URLToBytes(options.publicKey.challenge);
  for (const credential of options.publicKey.excludeCredentials || []) {
    credential.id = base64URLToBytes(credential.id);
  }
  return options;
}

function prepareAssertionOptions(options) {
  options.publicKey.challenge = base64URLToBytes(options.publicKey.challenge);
  for (const credential of options.publicKey.allowCredentials || []) {
    credential.id = base64URLToBytes(credential.id);
  }
  return options;
}

function serializeCreationCredential(credential) {
  return {
    id: credential.id,
    rawId: bytesToBase64URL(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bytesToBase64URL(credential.response.clientDataJSON),
      attestationObject: bytesToBase64URL(
        credential.response.attestationObject,
      ),
    },
  };
}

function serializeAssertionCredential(credential) {
  const response = {
    clientDataJSON: bytesToBase64URL(credential.response.clientDataJSON),
    authenticatorData: bytesToBase64URL(credential.response.authenticatorData),
    signature: bytesToBase64URL(credential.response.signature),
  };
  if (credential.response.userHandle) {
    response.userHandle = bytesToBase64URL(credential.response.userHandle);
  }
  return {
    id: credential.id,
    rawId: bytesToBase64URL(credential.rawId),
    type: credential.type,
    response,
  };
}

if (!window.PublicKeyCredential) {
  notify("WebAuthn is not supported in this browser.", "danger");
}

document.getElementById("register").addEventListener("click", async () => {
  try {
    const username = document.getElementById("username-register").value;
    const chain = document.getElementById("chain-register").value;
    const initialized = await apiFetch("/init", { username, chain });
    if (!initialized.ceremonyId)
      throw new Error("Backend did not bind the registration ceremony");
    const credential = await navigator.credentials.create(
      prepareCreationOptions(initialized.options),
    );
    const created = await apiFetch("/create", {
      username,
      chain,
      ceremonyId: initialized.ceremonyId,
      credential: serializeCreationCredential(credential),
    });
    document.getElementById("publicKey").textContent = created.address;
    document.getElementById("username-sign").value = username;
    document.getElementById("chain-sign").value = chain;
    notify(`Registered ${chain} wallet`, "success");
  } catch (error) {
    notify(error.message, "danger");
  }
});

document.getElementById("transaction").addEventListener("click", async () => {
  try {
    const username = document.getElementById("username-sign").value;
    const chain = document.getElementById("chain-sign").value;
    const wallet = await apiFetch("/check", { username, chain });

    if (chain === "ethereum") {
      const message = document.getElementById("message").value;
      if (!message) throw new Error("Enter an Ethereum message to sign");
      signingPayload = bytesToBase64(new TextEncoder().encode(message));
      signingOperation = "message";
    } else {
      const publicKey = new solanaWeb3.PublicKey(wallet.address);
      const connection = new solanaWeb3.Connection(
        "https://api.devnet.solana.com",
        "confirmed",
      );
      const blockInfo = await connection.getLatestBlockhash("confirmed");
      const transaction = new solanaWeb3.Transaction().add(
        solanaWeb3.SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: new solanaWeb3.PublicKey(
            "33wvmHvb3ZQy26QEyfjw5hMJKkFchctsQH2nG2XCbeVk",
          ),
          lamports: solanaWeb3.LAMPORTS_PER_SOL / 10,
        }),
      );
      transaction.recentBlockhash = blockInfo.blockhash;
      transaction.feePayer = publicKey;
      signingPayload = transaction
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64");
      signingOperation = "transaction";
    }

    document.getElementById("rawTransaction").textContent = signingPayload;
    document.getElementById("authenticate").disabled = false;
    notify(`Prepared ${chain} ${signingOperation}`, "success");
  } catch (error) {
    notify(error.message, "danger");
  }
});

document.getElementById("authenticate").addEventListener("click", async () => {
  try {
    const username = document.getElementById("username-sign").value;
    const chain = document.getElementById("chain-sign").value;
    const started = await apiFetch("/signin", {
      username,
      chain,
      operation: signingOperation,
      payload: signingPayload,
    });
    authenticationCeremonyId = started.ceremonyId;
    if (!authenticationCeremonyId)
      throw new Error("Backend did not bind the signing ceremony");
    const credential = await navigator.credentials.get(
      prepareAssertionOptions(started.options),
    );
    const completed = await apiFetch("/complete", {
      username,
      chain,
      ceremonyId: authenticationCeremonyId,
      operation: signingOperation,
      credential: serializeAssertionCredential(credential),
    });
    authenticationCeremonyId = "";
    document.getElementById("signedTransaction").textContent =
      completed.encodedTX || completed.signature;
    notify(`Signed ${chain} ${signingOperation}`, "success");
  } catch (error) {
    authenticationCeremonyId = "";
    notify(error.message, "danger");
  }
});

if (hostError) notify(hostError, "danger", undefined, 10_000);
else notify("Local development demo ready", "primary");
