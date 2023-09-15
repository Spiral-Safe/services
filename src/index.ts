import express, { Request, Response } from 'express';
import cors from "cors";

const app = express();
const port = 3000;

app.use(cors())
app.use(express.json());

const vaultAddress = process.env.VAULT_ADDRESS || 'http://127.0.0.1:8200';
const vaultToken = process.env.ROOT_TOKEN || 'root';

app.post('/init', async (req: Request, res: Response) => {
  const response = await fetch(`${vaultAddress}/v1/spiral-safe/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Vault-Token': vaultToken
    },
    body: JSON.stringify({
      username: req.body.username
    })
  });
  const json = await response.json();
  if (response.ok) {
    res.send({ ...json?.data });
  } else {
    console.error(response.status, json);
    if (json?.errors[0]?.includes("409")) {
      return res.sendStatus(409);
    }
    return res.sendStatus(500);
  }
})

app.post('/create', async (req: Request, res: Response) => {
  const credResponse = req.body.credential;
  console.log(req.body);

  const response = await fetch(`${vaultAddress}/v1/spiral-safe/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Vault-Token': vaultToken
    },
    body: JSON.stringify({
      username: req.body.username,
      credential: credResponse
    })
  });
  const json = await response.json();
  console.log(JSON.stringify(json));

  if (response.ok) {
    res.send(json);
  } else {
    console.error(response.status, json);
    res.sendStatus(500);
  }
});

app.post('/check', async (req: Request, res: Response) => {
  const response = await fetch(`${vaultAddress}/v1/spiral-safe/check`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Vault-Token': vaultToken
    },
    body: JSON.stringify({
      username: req.body.username,
    })
  });
  const json = await response.json();
  if (response.ok) {
    res.send({ ...json?.data });
  } else {
    console.error(response.status, json);
    if (json?.errors[0]?.includes("404")) {
      return res.sendStatus(404);
    }
    res.sendStatus(500);
  }
});

app.post('/signin', async (req: Request, res: Response) => {
  console.log("signin");

  const response = await fetch(`${vaultAddress}/v1/spiral-safe/auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Vault-Token': vaultToken
    },
    body: JSON.stringify({
      username: req.body.username,
      tx: req.body.rawTx,
    })
  });
  const json = await response.json();
  if (response.ok) {
    res.send({ ...json?.data });
  } else {
    console.error(response.status, json);
    res.sendStatus(500);
  }
});

app.post('/complete', async (req: Request, res: Response) => {
  const credResponse = req.body.credential;
  console.log(req.body);

  const response = await fetch(`${vaultAddress}/v1/spiral-safe/auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Vault-Token': vaultToken
    },
    body: JSON.stringify({
      username: req.body.username,
      credential: credResponse
    })
  });
  const json = await response.json();
  if (response.ok) {
    res.send({ ...json?.data });
  } else {
    console.error(response.status, json);
    res.sendStatus(500);
  }
});

// Start the Express server
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
