import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");

async function main(): Promise<void> {
  const keypairPath =
    process.env.SOLANA_KEYPAIR || resolve(homedir(), ".config/solana/id.json");
  const authority = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(await readFile(keypairPath, "utf8"))),
  );
  const nonce = Keypair.generate();
  const wallet = new PublicKey(
    process.env.SPIRAL_SAFE_SOLANA_ADDRESS ||
      "DMwkaqFxdcgytj7i8fshcGYXTHLUMDQezwkeeg6ebxpf",
  );
  const recipient = new PublicKey(
    process.env.SOLANA_RECIPIENT ||
      "2ocFY4FUppAFoVnApmyxk8nh7Ft1dMuVwrJx5bqKKdEU",
  );

  const airdropSignature = await connection.requestAirdrop(
    wallet,
    LAMPORTS_PER_SOL,
  );
  const block = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    { signature: airdropSignature, ...block },
    "finalized",
  );

  const initializeNonce = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: nonce.publicKey,
      lamports:
        await connection.getMinimumBalanceForRentExemption(
          NONCE_ACCOUNT_LENGTH,
        ),
      space: NONCE_ACCOUNT_LENGTH,
      programId: SystemProgram.programId,
    }),
    SystemProgram.nonceInitialize({
      noncePubkey: nonce.publicKey,
      authorizedPubkey: authority.publicKey,
    }),
  );
  await connection.sendTransaction(initializeNonce, [authority, nonce]);

  let nonceInfo;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const accountInfo = await connection.getAccountInfo(
      nonce.publicKey,
      "confirmed",
    );
    if (accountInfo) {
      nonceInfo = NonceAccount.fromAccountData(accountInfo.data);
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (!nonceInfo) throw new Error("nonce account was not confirmed");

  const transaction = new Transaction().add(
    SystemProgram.nonceAdvance({
      authorizedPubkey: authority.publicKey,
      noncePubkey: nonce.publicKey,
    }),
    SystemProgram.transfer({
      fromPubkey: wallet,
      toPubkey: recipient,
      lamports: LAMPORTS_PER_SOL / 100,
    }),
  );
  transaction.recentBlockhash = nonceInfo.nonce;
  transaction.feePayer = wallet;
  transaction.partialSign(authority);
  console.log(
    transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
