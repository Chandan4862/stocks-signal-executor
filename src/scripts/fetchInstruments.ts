/**
 * One-time script: Fetch the Dhan NSE_EQ instrument CSV and load it into
 * the `instrument_list_nse_eq` Postgres table.
 *
 * Usage:
 *   npx ts-node src/scripts/fetchInstruments.ts
 *   # or
 *   npm run script:fetch-instruments
 */

import "dotenv/config";
import axios from "axios";
import { Client } from "pg";

const INSTRUMENT_URL = "https://api.dhan.co/v2/instrument/NSE_EQ";

// Expected CSV columns (order matters — must match the header row)
const EXPECTED_COLUMNS = [
  "EXCH_ID",
  "SECURITY_ID",
  "INSTRUMENT",
  "UNDERLYING_SYMBOL",
  "DISPLAY_NAME",
  "INSTRUMENT_TYPE",
  "SERIES",
];

interface InstrumentRow {
  exch_id: string;
  security_id: string;
  instrument: string;
  underlying_symbol: string;
  display_name: string;
  instrument_type: string;
  series: string;
}

// ─── CSV helpers ──────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCsv(raw: string): InstrumentRow[] {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("CSV is empty");

  // Validate header
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toUpperCase());
  for (const col of EXPECTED_COLUMNS) {
    if (!header.includes(col)) {
      throw new Error(
        `Missing expected column "${col}" in CSV header: ${header.join(", ")}`,
      );
    }
  }

  // Build index map so we're resilient to extra columns or reordering
  const idx: Record<string, number> = {};
  for (const col of EXPECTED_COLUMNS) {
    idx[col] = header.indexOf(col);
  }

  const rows: InstrumentRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < EXPECTED_COLUMNS.length) continue; // skip malformed rows

    rows.push({
      exch_id: fields[idx.EXCH_ID] ?? "",
      security_id: fields[idx.SECURITY_ID] ?? "",
      instrument: fields[idx.INSTRUMENT] ?? "",
      underlying_symbol: fields[idx.UNDERLYING_SYMBOL] ?? "",
      display_name: fields[idx.DISPLAY_NAME] ?? "",
      instrument_type: fields[idx.INSTRUMENT_TYPE] ?? "",
      series: fields[idx.SERIES] ?? "",
    });
  }

  return rows;
}

// ─── Batch INSERT ─────────────────────────────────────────────────────

async function batchInsert(pg: Client, rows: InstrumentRow[]): Promise<number> {
  const BATCH_SIZE = 500;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    // Build parameterized multi-row INSERT
    const values: string[] = [];
    const params: string[] = [];
    let paramIdx = 1;

    for (const row of batch) {
      values.push(
        `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`,
      );
      params.push(
        row.exch_id,
        row.security_id,
        row.instrument,
        row.underlying_symbol,
        row.display_name,
        row.instrument_type,
        row.series,
      );
    }

    const sql = `
      INSERT INTO instrument_list_nse_eq
        (exch_id, security_id, instrument, underlying_symbol, display_name, instrument_type, series)
      VALUES ${values.join(", ")}
    `;

    await pg.query(sql, params);
    inserted += batch.length;
    process.stdout.write(`\r  Inserted ${inserted} / ${rows.length} rows`);
  }

  console.log(); // newline after progress
  return inserted;
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║  Dhan NSE_EQ Instrument List → Postgres Loader    ║");
  console.log("╚═══════════════════════════════════════════════════╝\n");

  // 1. Connect to Postgres
  const pg = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT || 5432),
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
  });

  await pg.connect();
  console.log("✔ Connected to Postgres\n");

  try {
    // 3. Fetch CSV
    console.log(`⏳ Fetching CSV from ${INSTRUMENT_URL} ...`);
    const { data: csvText } = await axios.get<string>(INSTRUMENT_URL, {
      responseType: "text",
      timeout: 60_000, // 60s — file can be large
    });
    console.log(`✔ Downloaded ${(csvText.length / 1024).toFixed(1)} KB\n`);

    // 4. Parse
    console.log("⏳ Parsing CSV ...");
    const rows = parseCsv(csvText);
    console.log(`✔ Parsed ${rows.length} instrument rows\n`);

    if (rows.length === 0) {
      console.log("⚠ No rows to insert — exiting.");
      return;
    }

    // 5. Truncate old data & insert fresh
    console.log("⏳ Truncating existing instrument_list_nse_eq data ...");
    await pg.query("TRUNCATE TABLE instrument_list_nse_eq RESTART IDENTITY");
    console.log("✔ Table truncated\n");

    console.log("⏳ Inserting rows ...");
    const count = await batchInsert(pg, rows);
    console.log(
      `\n✔ Successfully loaded ${count} instruments into instrument_list_nse_eq`,
    );

    // 6. Quick sanity check
    const { rows: sample } = await pg.query(
      "SELECT security_id, underlying_symbol, display_name FROM instrument_list_nse_eq LIMIT 5",
    );
    console.log("\n📋 Sample rows:");
    console.table(sample);
  } finally {
    await pg.end();
    console.log("\n✔ Postgres connection closed");
  }
}

main().catch((err) => {
  console.error("\n✖ Fatal error:", err);
  process.exit(1);
});
