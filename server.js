// server.js
// Node/Express API for Railway + MySQL (Railway env vars)
// Works with variables like:
// MYSQLHOST, MYSQLPORT, MYSQLUSER, MYSQLPASSWORD, MYSQLDATABASE
//
// Endpoints:
//   GET  /health
//   GET  /db-test
//   GET  /api/test-runs
//   GET  /api/board/:serial
//   POST /api/test-runs   (JSON body)  -> creates board + test_run (minimal)

const express = require("express");
const mysql = require("mysql2/promise");

const app = express();

// ====== Config ======
const PORT = Number(process.env.PORT || 3000);

function env(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === null || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

const DB_HOST = env("MYSQLHOST");
const DB_PORT = Number(env("MYSQLPORT", "3306"));
const DB_USER = env("MYSQLUSER");
const DB_PASS = env("MYSQLPASSWORD");
const DB_NAME = env("MYSQLDATABASE");

// ====== Middleware ======
app.use(express.json({ limit: "5mb" })); // JSON only for now
// If you host the frontend from the same server later, you can add:
// app.use(express.static("public"));

// ====== MySQL Pool ======
const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// ====== Basic endpoints ======
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/db-test", async (req, res) => {
  const [rows] = await pool.query("SELECT NOW() AS now, DATABASE() AS db");
  res.json(rows[0]);
});

// ====== Helpers ======
async function ensureSchema() {
  // Minimal schema that satisfies your existing pages:
  // boards + test_runs
  // (You can add powered/unpowered and photo tables later.)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS boards (
      board_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      serial_number VARCHAR(64) NOT NULL UNIQUE,
      hardware_rev VARCHAR(64),
      pcb_rev VARCHAR(64),
      batch VARCHAR(64),
      date_assembled DATE,
      assembled_by VARCHAR(128),
      country VARCHAR(64),
      lab VARCHAR(128),
      status VARCHAR(32),
      gdt_key VARCHAR(128),
      gdt_url TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS test_runs (
      testrun_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      board_id BIGINT NOT NULL,
      test_datetime TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      test_location VARCHAR(64),
      tester VARCHAR(128) NOT NULL,
      firmware_version VARCHAR(64),
      test_fixture_version VARCHAR(64),
      overall_result VARCHAR(16),
      comments TEXT,
      FOREIGN KEY (board_id) REFERENCES boards(board_id) ON DELETE CASCADE,
      INDEX (board_id)
    ) ENGINE=InnoDB;
  `);
}

async function upsertBoardBySerial(board) {
  const serial = board.serial_number?.trim();
  if (!serial) throw new Error("serial_number is required");

  // Insert if missing; update if exists
  await pool.query(
    `
    INSERT INTO boards
      (serial_number, hardware_rev, pcb_rev, batch, date_assembled, assembled_by, country, lab, status, gdt_key, gdt_url, notes)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      hardware_rev=VALUES(hardware_rev),
      pcb_rev=VALUES(pcb_rev),
      batch=VALUES(batch),
      date_assembled=VALUES(date_assembled),
      assembled_by=VALUES(assembled_by),
      country=VALUES(country),
      lab=VALUES(lab),
      status=VALUES(status),
      gdt_key=VALUES(gdt_key),
      gdt_url=VALUES(gdt_url),
      notes=VALUES(notes)
    `,
    [
      serial,
      board.hardware_rev || null,
      board.pcb_rev || null,
      board.batch || null,
      board.date_assembled || null,
      board.assembled_by || null,
      board.country || null,
      board.lab || null,
      board.status || null,
      board.gdt_key || null,
      board.gdt_url || null,
      board.notes || null,
    ]
  );

  const [rows] = await pool.query(
    `SELECT board_id, serial_number FROM boards WHERE serial_number = ? LIMIT 1`,
    [serial]
  );
  return rows[0];
}

// ====== API endpoints expected by your UI ======

// records.html expects list of runs
app.get("/api/test-runs", async (req, res) => {
  // Returns a list; shape can be adjusted to match your UI exactly
  const [rows] = await pool.query(`
    SELECT
      tr.testrun_id,
      b.serial_number,
      tr.test_datetime,
      tr.tester,
      tr.firmware_version,
      tr.test_fixture_version,
      tr.overall_result,
      tr.comments
    FROM test_runs tr
    JOIN boards b ON b.board_id = tr.board_id
    ORDER BY tr.test_datetime DESC
    LIMIT 500
  `);
  res.json({ ok: true, runs: rows });
});

// board.html expects board details + its runs
app.get("/api/board/:serial", async (req, res) => {
  const serial = (req.params.serial || "").trim();
  if (!serial) return res.status(400).json({ ok: false, error: "serial required" });

  const [boards] = await pool.query(
    `SELECT * FROM boards WHERE serial_number = ? LIMIT 1`,
    [serial]
  );
  if (boards.length === 0) return res.status(404).json({ ok: false, error: "not found" });

  const board = boards[0];

  const [runs] = await pool.query(
    `
    SELECT
      testrun_id, test_datetime, tester, firmware_version, test_fixture_version, overall_result, comments
    FROM test_runs
    WHERE board_id = ?
    ORDER BY test_datetime DESC
    `,
    [board.board_id]
  );

  res.json({ ok: true, board, runs });
});

// factory-form.html will POST here (JSON for now)
app.post("/api/test-runs", async (req, res) => {
  try {
    // Accept a flexible body:
    // {
    //   board: { serial_number, hardware_rev, pcb_rev, ..., gdt_key, gdt_url, notes },
    //   run:   { tester, firmware_version, test_fixture_version, overall_result, comments, test_location }
    // }
    const { board, run } = req.body || {};
    if (!board || !run) {
      return res.status(400).json({ ok: false, error: "Body must include { board, run }" });
    }
    if (!run.tester) {
      return res.status(400).json({ ok: false, error: "run.tester is required" });
    }

    const b = await upsertBoardBySerial(board);

    const [result] = await pool.query(
      `
      INSERT INTO test_runs
        (board_id, test_location, tester, firmware_version, test_fixture_version, overall_result, comments)
      VALUES
        (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        b.board_id,
        run.test_location || null,
        run.tester,
        run.firmware_version || null,
        run.test_fixture_version || null,
        run.overall_result || null,
        run.comments || null,
      ]
    );

    res.json({ ok: true, testrun_id: result.insertId, board_id: b.board_id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || "server error" });
  }
});

// ====== Start ======
(async () => {
  await ensureSchema();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`API listening on port ${PORT}`);
    console.log(`DB: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}`);
  });
})().catch((e) => {
  console.error("Startup failed:", e);
  process.exit(1);
});
