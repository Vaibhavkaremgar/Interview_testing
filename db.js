const { Pool } = require("pg");

const DB_URL = process.env.DATABASE_URL || "";
const DB_READY = DB_URL.length > 0 && !DB_URL.includes("user:password");

// Create connection pool for Railway PostgreSQL
const pool = DB_READY
  ? new Pool({
      connectionString: DB_URL,
      ssl: { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    })
  : null;

// Handle pool errors
if (pool) {
  pool.on("error", (err) => {
    console.error("Unexpected error on idle client", err);
  });
}

module.exports = { pool, DB_READY };
