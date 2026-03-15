import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Client } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const appName = process.argv[2] ?? "rummy500";
const planOnly = process.argv.includes("--plan");
const inheritedEnvKeys = new Set(Object.keys(process.env));

validateAppName(appName);
loadEnvFiles();

const databaseUrl = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("Missing SUPABASE_DB_URL or DATABASE_URL.");
  process.exit(1);
}

const migrationsDir = path.join(repoRoot, "migrations", appName);
const metaSchema = `${appName}_meta`;
const metaTable = "migrations";
const advisoryLockKey = createSignedLockKey(`app-migrations:${appName}`);

async function main() {
  const migrations = await readMigrations();
  const client = new Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") ? false : { rejectUnauthorized: false }
  });

  await client.connect();

  try {
    await withAdvisoryLock(client, async () => {
      if (planOnly) {
        const appliedMigrations = await loadAppliedMigrations(client);
        printPlan(migrations, appliedMigrations);
        return;
      }

      await ensureMetadataStorage(client);
      const appliedMigrations = await loadAppliedMigrations(client);
      let appliedCount = 0;

      for (const migration of migrations) {
        const existing = appliedMigrations.get(migration.version);

        if (existing) {
          if (existing.checksum !== migration.checksum) {
            throw new Error(
              `Checksum mismatch for ${migration.filename}. Applied checksum ${existing.checksum} differs from local checksum ${migration.checksum}.`
            );
          }

          console.log(`skip ${migration.filename}`);
          continue;
        }

        const startedAt = Date.now();
        await client.query("begin");

        try {
          await client.query(migration.sql);
          await client.query(
            `insert into ${ident(metaSchema)}.${ident(metaTable)} (app_name, version, name, checksum, execution_ms)
             values ($1, $2, $3, $4, $5)`,
            [appName, migration.version, migration.name, migration.checksum, Date.now() - startedAt]
          );
          await client.query("commit");
          appliedCount += 1;
          console.log(`apply ${migration.filename}`);
        } catch (error) {
          await client.query("rollback");
          throw new Error(`Migration failed for ${migration.filename}: ${formatError(error)}`);
        }
      }

      if (appliedCount === 0) {
        console.log("No pending migrations.");
      } else {
        console.log(`Applied ${appliedCount} migration${appliedCount === 1 ? "" : "s"}.`);
      }
    });
  } finally {
    await client.end();
  }
}

async function readMigrations() {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  const seenVersions = new Set();
  const migrations = [];

  for (const filename of files) {
    const match = filename.match(/^(\d{14})_(.+)\.sql$/);

    if (!match) {
      throw new Error(`Invalid migration filename: ${filename}`);
    }

    const [, version, name] = match;

    if (seenVersions.has(version)) {
      throw new Error(`Duplicate migration version detected: ${version}`);
    }

    seenVersions.add(version);

    const absolutePath = path.join(migrationsDir, filename);
    const sql = readFileSync(absolutePath, "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");

    migrations.push({
      version,
      name,
      filename,
      sql,
      checksum
    });
  }

  return migrations;
}

async function ensureMetadataStorage(client) {
  await client.query(`create schema if not exists ${ident(metaSchema)}`);
  await client.query(
    `create table if not exists ${ident(metaSchema)}.${ident(metaTable)} (
      app_name text not null,
      version text not null,
      name text not null,
      checksum text not null,
      executed_at timestamptz not null default timezone('utc', now()),
      execution_ms integer not null,
      primary key (app_name, version)
    )`
  );
}

async function loadAppliedMigrations(client) {
  const { rows: existenceRows } = await client.query("select to_regclass($1) as relation_name", [
    `${metaSchema}.${metaTable}`
  ]);

  if (!existenceRows[0]?.relation_name) {
    return new Map();
  }

  const { rows } = await client.query(
    `select version, checksum
     from ${ident(metaSchema)}.${ident(metaTable)}
     where app_name = $1
     order by version asc`,
    [appName]
  );

  return new Map(rows.map((row) => [row.version, { checksum: row.checksum }]));
}

async function withAdvisoryLock(client, callback) {
  await client.query("select pg_advisory_lock($1::bigint)", [advisoryLockKey]);

  try {
    return await callback();
  } finally {
    await client.query("select pg_advisory_unlock($1::bigint)", [advisoryLockKey]);
  }
}

function printPlan(migrations, appliedMigrations) {
  if (migrations.length === 0) {
    console.log(`No migrations found in ${migrationsDir}`);
    return;
  }

  for (const migration of migrations) {
    const existing = appliedMigrations.get(migration.version);

    if (!existing) {
      console.log(`pending ${migration.filename}`);
      continue;
    }

    if (existing.checksum !== migration.checksum) {
      console.log(`drift ${migration.filename}`);
      continue;
    }

    console.log(`applied ${migration.filename}`);
  }
}

function loadEnvFiles() {
  for (const filename of [".env", ".env.local"]) {
    const absolutePath = path.join(repoRoot, filename);

    try {
      const raw = readFileSync(absolutePath, "utf8");
      applyEnvContents(raw);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }
}

function applyEnvContents(contents) {
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (inheritedEnvKeys.has(key)) {
      continue;
    }

    process.env[key] = value;
  }
}

function createSignedLockKey(input) {
  const bytes = createHash("sha256").update(input).digest();
  let value = 0n;

  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) + BigInt(bytes[index]);
  }

  if (value >= 2n ** 63n) {
    value -= 2n ** 64n;
  }

  return value.toString();
}

function validateAppName(value) {
  if (!/^[a-z0-9_]+$/u.test(value)) {
    throw new Error(`Invalid app name "${value}". Use lowercase letters, numbers, and underscores only.`);
  }
}

function ident(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

await main();
