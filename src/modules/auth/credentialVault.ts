/*
  CredentialVault: AES-256-GCM envelope encryption for broker secrets.

  Each user's credentials (Dhan PIN + TOTP secret) are encrypted at rest.
  KEK (Key Encryption Key) is derived from MASTER_ENCRYPTION_KEY env var + userId.
  Uses PBKDF2 with 100,000 iterations for key derivation.

  Stored in users table: dhan_credentials_enc (ciphertext+authTag) + dhan_credentials_iv
*/

import crypto from "crypto";

export interface BrokerCredentials {
  pin?: string;
  totpSecret?: string;
}

export class CredentialVault {
  constructor(private masterKey: string) {
    if (masterKey.length < 32) {
      throw new Error("MASTER_ENCRYPTION_KEY must be at least 32 characters");
    }
  }

  /**
   * Encrypt broker credentials for a specific user.
   * Returns { enc: Buffer (ciphertext + 16-byte authTag), iv: Buffer (16 bytes) }
   */
  async encrypt(
    userId: number,
    credentials: BrokerCredentials,
  ): Promise<{ enc: Buffer; iv: Buffer }> {
    const kek = this.deriveKEK(userId);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-gcm", kek, iv);

    const plaintext = JSON.stringify(credentials);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Store ciphertext + authTag together
    return { enc: Buffer.concat([encrypted, authTag]), iv };
  }

  /**
   * Decrypt broker credentials for a specific user.
   */
  async decrypt(userId: number, enc: Buffer, iv: Buffer): Promise<BrokerCredentials> {
    const kek = this.deriveKEK(userId);

    // Last 16 bytes are the auth tag
    const authTag = enc.subarray(-16);
    const ciphertext = enc.subarray(0, -16);

    const decipher = crypto.createDecipheriv("aes-256-gcm", kek, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  }

  /**
   * Derive a per-user KEK from the master key + userId using PBKDF2.
   * 100,000 iterations of SHA-256 → 32-byte key.
   */
  private deriveKEK(userId: number): Buffer {
    return crypto.pbkdf2Sync(this.masterKey, `user:${userId}`, 100000, 32, "sha256");
  }
}
