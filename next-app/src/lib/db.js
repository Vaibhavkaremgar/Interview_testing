import { Pool } from "pg";

const DB_URL = process.env.DATABASE_URL || "";
const DB_READY = DB_URL.length > 0 && !DB_URL.includes("user:password");
const DB_SSL = (process.env.DATABASE_SSL || "true").toString().trim().toLowerCase();
const ssl =
  DB_SSL === "false" || DB_SSL === "0" || DB_SSL === "no"
    ? false
    : { rejectUnauthorized: false };

const pool = DB_READY
  ? new Pool({
      connectionString: DB_URL,
      ssl,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    })
  : null;

if (pool) {
  pool.on("error", (err) => {
    console.error("Unexpected error on idle client", err);
  });
}

export { pool, DB_READY };
