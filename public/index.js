let pubKey = "";
let rawTx = "";
const bf = ethereumjs.Buffer.Buffer;
function notify(
  message,
  variant = "primary",
  icon = "info-circle",
  duration = 3000
) {
  const alert1 = Object.assign(document.createElement("sl-alert"), {
    variant,
    closable: true,
    duration: duration,
    innerHTML: `
        <sl-icon name="${icon}" slot="icon"></sl-icon>
        ${message}
      `,
  });

  document.body.append(alert1);
  try {
    return alert1.toast();
  } catch (err) {}
}
function padString(input) {
  // const b = ethereumjs.Buffer.Buffer;
  let segmentLength = 4;
  let stringLength = input.length;
  let diff = stringLength % segmentLength;

  if (!diff) {
    return input;
  }

  let position = stringLength;
  let padLength = segmentLength - diff;
  let paddedStringLength = stringLength + padLength;
  let buffer = bf.alloc(paddedStringLength);

  buffer.write(input);

  while (padLength--) {
    buffer.write("=", position++);
  }

  return buffer.toString();
}
function base64url_encode(input, encoding = "utf8") {
  if (bf.isBuffer(input)) {
    return fromBase64(input.toString("base64"));
  }
  return fromBase64(bf.from(input, encoding).toString("base64"));
}
function base64url_decode(base64url) {
  return bf.from(toBase64(base64url), "base64");
}
function toBase64(base64url) {
  base64url = base64url.toString();
  return padString(base64url).replace(/\-/g, "+").replace(/_/g, "/");
}
function fromBase64(base64) {
  return base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
const host = "http://localhost:3000";
// Check if the browser supports WebAuthn
if (!window.PublicKeyCredential) {
  alert("WebAuthn is not supported in this browser.");
}

document.getElementById("register").addEventListener("click", async () => {
  const usernameInput = document.getElementById("username-register");
  let response = await fetch(`${host}/init`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: usernameInput.value,
    }),
  });
  if (response.status === 409) {
    notify("Already registered", "danger");
    return;
  } else if (response.status === 200) {
    let json = await response.json();
    console.log(json.options.publicKey.challenge.toString());
    json.options.publicKey.user.id = base64url_decode(
      json.options.publicKey.user.id
    );
    json.options.publicKey.challenge = base64url_decode(
      json.options.publicKey.challenge.toString()
    );

    if (json.options.publicKey.excludeCredentials) {
      for (let cred of json.options.publicKey.excludeCredentials) {
        cred.id = base64url_decode(cred.id);
      }
    }
    console.log(json);
    const cred = await navigator.credentials.create(json.options);
    console.log(cred);

    const credential = {};
    credential.id = cred.id;
    credential.rawId = base64url_encode(cred.rawId);
    credential.type = cred.type;

    if (cred.response) {
      const clientDataJSON = base64url_encode(cred.response.clientDataJSON);
      const attestationObject = base64url_encode(
        cred.response.attestationObject
      );
      credential.response = {
        clientDataJSON,
        attestationObject,
      };
    }
    console.log(credential);

    response = await fetch(`${host}/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        username: usernameInput.value,
        credential,
      }),
    });
    console.log(response.status);
    if (response.status === 200) {
      json = await response.json();
      console.log(json.data.pubKey);
      pubKey = json.data.pubKey;
      document.getElementById("publicKey").textContent = pubKey;
      document.getElementById("username-sign").value = usernameInput.value;
      notify("Successfully registered", "success");
      return;
    }
  }
});

document.getElementById("transaction").addEventListener("click", async () => {
  const usernameInput = document.getElementById("username-sign");
  let response = await fetch(`${host}/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: usernameInput.value,
    }),
  });
  if (response.status === 404) {
    notify("Not registered", "danger");
    return;
  }
  let json = await response.json();
  console.log(json);
  const fooPublicKey = new solanaWeb3.PublicKey(json.pubKey);
  const solConn = new solanaWeb3.Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );
  let blockInfo = await solConn.getLatestBlockhash("confirmed");
  const tfTX = new solanaWeb3.Transaction().add(
    solanaWeb3.SystemProgram.transfer({
      fromPubkey: fooPublicKey,
      toPubkey: new solanaWeb3.PublicKey(
        "33wvmHvb3ZQy26QEyfjw5hMJKkFchctsQH2nG2XCbeVk"
      ),
      lamports: solanaWeb3.LAMPORTS_PER_SOL / 10,
    })
  );
  tfTX.recentBlockhash = blockInfo.blockhash;
  tfTX.feePayer = fooPublicKey;

  rawTx = tfTX
    .serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    })
    .toString("base64");
  document.getElementById("rawTransaction").textContent = rawTx;
  document.getElementById("authenticate").disabled = false;
  notify("Created the transaction", "success");
});

document.getElementById("authenticate").addEventListener("click", async () => {
  const usernameInput = document.getElementById("username-sign");
  let response = await fetch(`${host}/signin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: usernameInput.value,
      rawTx: rawTx,
    }),
  });
  let json = await response.json();
  json.options.publicKey.challenge = base64url_decode(
    json.options.publicKey.challenge.toString()
  );

  for (let cred of json.options.publicKey.allowCredentials) {
    cred.id = base64url_decode(cred.id);
  }
  console.log(json);
  const cred = await navigator.credentials.get(json.options);

  const credential = {};
  credential.id = cred.id;
  credential.type = cred.type;
  credential.rawId = base64url_encode(cred.rawId);

  if (cred.response) {
    const clientDataJSON = base64url_encode(cred.response.clientDataJSON);
    const authenticatorData = base64url_encode(cred.response.authenticatorData);
    const signature = base64url_encode(cred.response.signature);
    const userHandle = base64url_encode(cred.response.userHandle);
    credential.response = {
      clientDataJSON,
      authenticatorData,
      signature,
      userHandle,
    };
  }
  console.log(credential);

  response = await fetch(`${host}/complete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username: usernameInput.value,
      credential,
    }),
  });
  json = await response.json();
  document.getElementById("signedTransaction").textContent = json.encodedTX;
  notify("Signed the transaction", "success");
  return;
});
notify("Welcome", "primary");
