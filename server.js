// server.js – Krake factory API, using MySQL and port 4000

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static('public'));

// ---------- MySQL CONFIG ----------
const pool = mysql.createPool({
  host: '127.0.0.1',
  port: 3306,
  user: 'root',                 // change if needed
  password: 'N@jh@M..2429', // TODO: put your real password
  database: 'krake_factory',    // change if your DB name is different
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function getConn() {
  return pool.getConnection();
}

// ---------- HELPERS ----------

// Find a board by serial_number, or create it if it doesn't exist
async function getOrCreateBoard(conn, board) {
  const serial = (board.serial_number || '').trim();
  if (!serial) {
    throw new Error('serial_number is required');
  }

  // 1) Try existing
  const [existing] = await conn.query(
    'SELECT board_id FROM boards WHERE serial_number = ?',
    [serial]
  );
  if (existing.length) {
    return existing[0].board_id;
  }

  // 2) Insert new
  const [result] = await conn.query(
    `INSERT INTO boards
       (serial_number, hardware_rev, pcb_rev, batch,
        date_assembled, assembled_by, country, lab,
        status, gdt_key, gdt_url, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      board.notes || null
    ]
  );

  return result.insertId;
}

// ---------- ROUTES ----------

// Simple ping to confirm Node <-> MySQL works
app.get('/api/ping', async (req, res) => {
  let conn;
  try {
    conn = await getConn();
    const [rows] = await conn.query('SELECT 1 AS ok');
    res.json({ ok: true, db: rows[0].ok });
  } catch (err) {
    console.error('PING error:', err);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /api/test-run  -> save board + test_runs + unpowered + powered
app.post('/api/test-run', async (req, res) => {
  const { board, test_run, unpowered, powered } = req.body || {};

  let conn;
  try {
    conn = await getConn();
    await conn.beginTransaction();

    // 1) board
    const boardId = await getOrCreateBoard(conn, board || {});

    // 2) test_runs
    const tr = test_run || {};
    const [runResult] = await conn.query(
      `INSERT INTO test_runs
         (board_id, test_location, tester,
          firmware_version, test_fixture_version,
          overall_result, comments)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        boardId,
        tr.test_location || null,
        tr.tester || null,
        tr.firmware_version || null,
        tr.test_fixture_version || null,
        tr.overall_result || null,
        tr.comments || null
      ]
    );
    const testrunId = runResult.insertId;

    // 3) unpowered_results
    if (unpowered) {
      const u = unpowered;
      await conn.query(
        `INSERT INTO unpowered_results
           (testrun_id,
            meter_make, meter_model, meter_sn,
            res_tp102_tp101_vin, res_tp103_tp101_5v,
            res_tp201_tp101_vbus, res_tp202_tp101_v3,
            res_j103pin2_tp101_ctrl_vcc,
            pass_fail, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          testrunId,
          u.meter_make || null,
          u.meter_model || null,
          u.meter_sn || null,
          u.res_tp102_tp101_vin || null,
          u.res_tp103_tp101_5v || null,
          u.res_tp201_tp101_vbus || null,
          u.res_tp202_tp101_v3 || null,
          u.res_j103pin2_tp101_ctrl_vcc || null,
          u.pass_fail || null,
          u.notes || null
        ]
      );
    }

    // 4) powered_results
    if (powered) {
      const p = powered;
      await conn.query(
        `INSERT INTO powered_results
           (testrun_id,
            supply_current_ma, vin_tp102_v, v5_tp103_v,
            v5_esp32_u103_v, v3p3_tab_u103_v, v3_tp202_u501_v,
            v3v3_ctrl_d103k_v, vcclcd_tp401_v, v5_dfp_c505_v,
            v_charge_pump_plus_v, v_charge_pump_minus_v,
            pass_fail, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          testrunId,
          p.supply_current_ma ?? null,
          p.vin_tp102_v ?? null,
          p.v5_tp103_v ?? null,
          p.v5_esp32_u103_v ?? null,
          p.v3p3_tab_u103_v ?? null,
          p.v3_tp202_u501_v ?? null,
          p.v3v3_ctrl_d103k_v ?? null,
          p.vcclcd_tp401_v ?? null,
          p.v5_dfp_c505_v ?? null,
          p.v_charge_pump_plus_v ?? null,
          p.v_charge_pump_minus_v ?? null,
          p.pass_fail || null,
          p.notes || null
        ]
      );
    }

    await conn.commit();
    res.json({
      message: 'Test run saved',
      board_id: boardId,
      testrun_id: testrunId
    });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch (_) {}
    }
    console.error('POST /api/test-run error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// GET /api/test-runs – summary for inventory page
app.get('/api/test-runs', async (req, res) => {
  let conn;
  try {
    conn = await getConn();
    const [rows] = await conn.query(
      `SELECT
         b.serial_number,
         b.country,
         b.lab,
         tr.test_datetime,
         tr.test_location,
         tr.tester,
         tr.firmware_version,
         tr.overall_result
       FROM test_runs tr
       JOIN boards b ON tr.board_id = b.board_id
       ORDER BY tr.test_datetime DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/test-runs error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// GET /api/board/:serial – board + runs + measurements
app.get('/api/board/:serial', async (req, res) => {
  const serial = (req.params.serial || '').trim();
  if (!serial) {
    return res.status(400).json({ error: 'Serial is required' });
  }

  let conn;
  try {
    conn = await getConn();

    // Board
    const [boardRows] = await conn.query(
      'SELECT * FROM boards WHERE serial_number = ?',
      [serial]
    );
    if (!boardRows.length) {
      return res.json({ board: null, test_runs: [] });
    }
    const board = boardRows[0];

    // Runs for that board
    const [runs] = await conn.query(
      'SELECT * FROM test_runs WHERE board_id = ? ORDER BY test_datetime DESC',
      [board.board_id]
    );

    const detailedRuns = [];
    for (const run of runs) {
      const [unpRows] = await conn.query(
        'SELECT * FROM unpowered_results WHERE testrun_id = ?',
        [run.testrun_id]
      );
      const [powRows] = await conn.query(
        'SELECT * FROM powered_results WHERE testrun_id = ?',
        [run.testrun_id]
      );

      detailedRuns.push({
        ...run,
        unpowered_results: unpRows,
        powered_results: powRows
      });
    }

    res.json({ board, test_runs: detailedRuns });
  } catch (err) {
    console.error('GET /api/board/:serial error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// ---------- START SERVER ----------
const PORT = 4000;
app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
