import "dotenv/config";
import { Pool } from "pg";
import { loadConfig } from "../config";
import { CredentialVault } from "../modules/auth/credentialVault";

async function main() {
  const config = loadConfig();
  const pool = new Pool(config.postgres);
  const vault = new CredentialVault(config.masterEncryptionKey);

  const numUsers = parseInt(process.argv[2] || "1000", 10);
  console.log(`Starting DB seed for ${numUsers} users...`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (let i = 1; i <= numUsers; i++) {
      const tgChatId = `load_test_user_${i}`;
      const username = `LoadTester${i}`;
      const clientId = `MOCK_CLIENT_${i}`;

      const { enc, iv } = await vault.encrypt(i, {
        pin: "123456",
        totpSecret: "DUMMYSECRET123456",
      });

      await client.query(
        `INSERT INTO users (
          telegram_chat_id, 
          telegram_username, 
          display_name, 
          dhan_client_id, 
          dhan_credentials_enc, 
          dhan_credentials_iv, 
          status, 
          trading_enabled, 
          onboarded_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE', TRUE, NOW())
        ON CONFLICT (telegram_chat_id) DO NOTHING`,
        [tgChatId, username, username, clientId, enc, iv],
      );

      if (i % 100 === 0) {
        console.log(`  Seeded ${i} users...`);
      }
    }

    await client.query("COMMIT");
    console.log(`✅ Successfully seeded ${numUsers} users.`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Seeding failed:", err);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(console.error);
