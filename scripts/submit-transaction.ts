import {
  Connection,
  sendAndConfirmRawTransaction,
  Transaction,
} from "@solana/web3.js";

async function main(): Promise<void> {
  const encoded = process.env.SIGNED_TRANSACTION;
  if (!encoded)
    throw new Error(
      "SIGNED_TRANSACTION must contain a standard-base64 transaction",
    );
  const transaction = Transaction.from(Buffer.from(encoded, "base64"));
  const serialized = transaction.serialize({
    requireAllSignatures: true,
    verifySignatures: true,
  });
  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed",
  );
  console.log(
    await sendAndConfirmRawTransaction(connection, serialized, {
      commitment: "confirmed",
      skipPreflight: false,
    }),
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
