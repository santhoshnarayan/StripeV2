import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function getBidEncryptionKey() {
  const secret = process.env.BID_ENCRYPTION_SECRET || process.env.BETTER_AUTH_SECRET;

  if (!secret) {
    throw new Error("Missing BID_ENCRYPTION_SECRET or BETTER_AUTH_SECRET");
  }

  return createHash("sha256").update(secret).digest();
}

export function encryptBidAmount(amount: number) {
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getBidEncryptionKey(), initializationVector);
  const encrypted = Buffer.concat([
    cipher.update(String(amount), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    initializationVector.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(".");
}

export function decryptBidAmount(payload: string) {
  const [initializationVector, authTag, encrypted] = payload.split(".");

  if (!initializationVector || !authTag || !encrypted) {
    throw new Error("Invalid encrypted bid payload");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    getBidEncryptionKey(),
    Buffer.from(initializationVector, "base64"),
  );

  decipher.setAuthTag(Buffer.from(authTag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final(),
  ]).toString("utf8");

  const amount = Number(decrypted);

  if (!Number.isInteger(amount)) {
    throw new Error("Decrypted bid amount was not an integer");
  }

  return amount;
}
