require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const cron = require("node-cron");
const { Client } = require("pg");

const doBackup = require("./backup");
const listmlbackups = require("./listmlbackups");
const restoreFromBucket = require("./restoreFromBucket");
const cleanupOldBackups = require("./cleanupOldBackups");
const pingDatabase = require("./ping");
const supabase = require("./db");

// --------------------------------------
// PostgreSQL Connection
// --------------------------------------
const pg = new Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { rejectUnauthorized: false },
});

pg.connect()
  .then(() => console.log("✅ PostgreSQL connected"))
  .catch((err) => console.error("❌ PG Error:", err));

const app = express();

// =====================================================
// 🔥 SUPER CORS FIX
// =====================================================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

app.get("/", (req, res) => res.json({ ok: true }));

// =====================================================================
// BACKUP SYSTEM
// =====================================================================

// 🔹 POST backup trigger
app.post("/api/backup", async (req, res) => {
  const result = await doBackup();
  res.json(result);
});

// 🔹 GET backup trigger (cron-job.org)
app.get("/api/backup", async (req, res) => {
  const result = await doBackup();
  res.json(result);
});

// 🔹 List backups
app.get("/api/list-backups", async (req, res) => {
  try {
    const files = await listmlbackups();
    res.json({ success: true, files });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 🔹 Restore from bucket
app.post("/api/restore-from-bucket", upload.any(), async (req, res) => {
  try {
    const result = await restoreFromBucket({ body: req.body });
    res.json(result);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// 🔹 Download backup
app.get("/api/download-backup/:name", async (req, res) => {
  try {
    const { data, error } = await supabase.storage
      .from("mlbackups")
      .download(req.params.name);

    if (error || !data) return res.status(404).send("File not found");

    const buffer = Buffer.from(await data.arrayBuffer());
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${req.params.name}"`
    );
    res.send(buffer);
  } catch {
    res.status(500).send("Download failed");
  }
});

// 🔹 Delete backup (manual)
app.post("/api/delete-backup", async (req, res) => {
  try {
    const { fileName, password } = req.body;
    if (password !== "faizanyounus")
      return res.json({ success: false, error: "Invalid password" });

    const { error } = await supabase.storage
      .from("mlbackups")
      .remove([fileName]);

    if (error) return res.json({ success: false, error: error.message });

    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// =====================================================================
// ⏰ CRON JOBS
// =====================================================================

// 🔹 Auto Backup – Daily 2AM Pakistan Time
cron.schedule(
  "0 2 * * *",
  async () => {
    console.log("⏰ Auto Backup Running...");
    await doBackup();
  },
  { timezone: "Asia/Karachi" }
);

// 🔹 Auto Cleanup – Daily 3AM (60 days old backups)
cron.schedule(
  "0 3 * * *",
  async () => {
    console.log("🧹 Cleanup Old Backups...");
    await cleanupOldBackups();
  },
  { timezone: "Asia/Karachi" }
);

// =====================================
// AUTO CLEANUP OLD BACKUPS (60 DAYS)
// =====================================
app.get("/api/cleanup-backups", async (req, res) => {
  try {
    const result = await cleanupOldBackups();
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =====================================
// KEEP ALIVE PING (FREE PLAN FIX)
// =====================================
app.get("/api/ping", async (req, res) => {
  try {
    const result = await pingDatabase();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});



// =====================================================================
// STOCK SNAPSHOT SQL
// =====================================================================
const STOCK_SNAPSHOT_SQL = `
WITH last_snap AS (
  SELECT MAX(snap_date) AS snap_date
  FROM stock_snapshots
  WHERE snap_date <= $1
),
base AS (
  SELECT 
    i.barcode::text AS barcode,
    i.item_name,
    COALESCE(s.stock_qty, 0) AS base_qty
  FROM items i
  LEFT JOIN stock_snapshots s
    ON s.barcode::text = i.barcode::text
   AND s.snap_date = (SELECT snap_date FROM last_snap)
),
pur AS (
  SELECT barcode::text, SUM(qty) total_purchase
  FROM purchases, last_snap
  WHERE purchase_date > COALESCE(last_snap.snap_date,'1900-01-01')
    AND purchase_date <= $1
    AND is_deleted = FALSE
  GROUP BY barcode::text
),
sal AS (
  SELECT barcode::text, SUM(qty) total_sale
  FROM sales, last_snap
  WHERE sale_date > COALESCE(last_snap.snap_date,'1900-01-01')
    AND sale_date <= $1
    AND is_deleted = FALSE
  GROUP BY barcode::text
),
ret AS (
  SELECT barcode::text, SUM(return_qty) total_return
  FROM sale_returns, last_snap
  WHERE created_at::date > COALESCE(last_snap.snap_date,'1900-01-01')
    AND created_at::date <= $1
  GROUP BY barcode::text
)
SELECT 
  b.barcode,
  b.item_name,
  b.base_qty
  + COALESCE(pur.total_purchase,0)
  - COALESCE(sal.total_sale,0)
  + COALESCE(ret.total_return,0) AS stock_qty
FROM base b
LEFT JOIN pur ON pur.barcode = b.barcode
LEFT JOIN sal ON sal.barcode = b.barcode
LEFT JOIN ret ON ret.barcode = b.barcode
`;

// =====================================================================
// باقی snapshot / stock / archive APIs
// 👉 تمہارا code یہاں بالکل SAFE ہے، کوئی change نہیں کیا
// =====================================================================

// =====================================================================
// SNAPSHOT PREVIEW
// =====================================================================
app.post("/api/snapshot-preview", async (req, res) => {
  try {
    const { end_date } = req.body;
    if (!end_date)
      return res.json({ success: false, error: "End date is required" });

    const sql = `
      SELECT 
        q.barcode,
        q.item_name,
        q.stock_qty
      FROM (${STOCK_SNAPSHOT_SQL}) q
      WHERE q.stock_qty <> 0
    `;
    const result = await pg.query(sql, [end_date]);
    res.json({ success: true, rows: result.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// =====================================================================
// SNAPSHOT CREATE + LOG
// =====================================================================
app.post("/api/snapshot-create", async (req, res) => {
  try {
    const { start_date, end_date, password } = req.body;
    if (password !== "faizanyounus2122")
      return res.json({ success: false, error: "Wrong password" });
    if (!end_date)
      return res.json({ success: false, error: "End date is required" });

    const sqlInsert = `
      INSERT INTO stock_snapshots (snap_date, barcode, item_name, stock_qty)
      SELECT 
        $1::date AS snap_date,
        q.barcode,
        q.item_name,
        q.stock_qty
      FROM (${STOCK_SNAPSHOT_SQL}) q
      WHERE q.stock_qty <> 0;
    `;
    const result = await pg.query(sqlInsert, [end_date]);

    await pg.query(
      `INSERT INTO snapshot_logs (from_date, to_date, items_inserted)
       VALUES ($1, $2, $3)`,
      [start_date, end_date, result.rowCount]
    );

    res.json({ success: true, message: "Snapshot created!", inserted: result.rowCount });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// =====================================================================
// SNAPSHOT HISTORY
// =====================================================================
app.get("/api/snapshot-history", async (req, res) => {
  try {
    const result = await pg.query(`
      SELECT id, from_date, to_date, items_inserted, created_at
      FROM snapshot_logs
      ORDER BY id DESC
    `);
    res.json({ success: true, rows: result.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// =====================================================================
// STOCK REPORT
// =====================================================================
// ===================================
// STOCK REPORT (SNAPSHOT + LIVE)
// ===================================
router.get("/stock-report", async (req, res) => {
  try {
    // 1️⃣ Latest snapshot date
    const snapDateRes = await db.query(`
      SELECT MAX(snap_date) AS snap_date
      FROM stock_snapshots
    `);

    const snapDate = snapDateRes.rows[0].snap_date;

    // 2️⃣ Snapshot stock
    const snapshotRes = await db.query(`
      SELECT
        s.barcode,
        s.item_name,
        SUM(s.stock_qty) AS snap_qty
      FROM stock_snapshots s
      WHERE s.snap_date = $1
      GROUP BY s.barcode, s.item_name
    `, [snapDate]);

    // 3️⃣ Live stock after snapshot
    const liveRes = await db.query(`
      SELECT
        l.barcode,
        SUM(l.in_qty)  AS in_qty,
        SUM(l.out_qty) AS out_qty
      FROM stock_ledger l
      WHERE l.created_at::date > $1
      GROUP BY l.barcode
    `, [snapDate]);

    // 4️⃣ Items (rate)
    const itemsRes = await db.query(`
      SELECT
        barcode,
        item_name,
        purchase_price
      FROM items
    `);

    // =============================
    // MERGE DATA
    // =============================
    const liveMap = {};
    liveRes.rows.forEach(r => {
      liveMap[r.barcode] = {
        in_qty: Number(r.in_qty || 0),
        out_qty: Number(r.out_qty || 0),
      };
    });

    const itemsMap = {};
    itemsRes.rows.forEach(i => {
      itemsMap[i.barcode] = i;
    });

    const finalRows = snapshotRes.rows.map(s => {
      const live = liveMap[s.barcode] || { in_qty: 0, out_qty: 0 };
      const item = itemsMap[s.barcode] || {};

      const stock_qty =
        Number(s.snap_qty || 0) +
        Number(live.in_qty || 0) -
        Number(live.out_qty || 0);

      const rate = Number(item.purchase_price || 0);
      const amount = stock_qty * rate;

      return {
        barcode: s.barcode,
        item_name: s.item_name,
        stock_qty,
        rate,
        amount,
      };
    });

    res.json({
      success: true,
      snapshot_date: snapDate,
      rows: finalRows,
    });

  } catch (err) {
    console.error("STOCK REPORT ERROR:", err);
    res.json({ success: false, error: err.message });
  }
});

// =====================================================================
// ARCHIVE PREVIEW / DELETE
// =====================================================================
app.post("/api/archive-preview", async (req, res) => {
  try {
    const { start_date, end_date } = req.body;

    const sql = `
      SELECT 
        barcode::text AS barcode,
        item_name,
        SUM(purchase_qty) AS purchase_qty,
        SUM(sale_qty) AS sale_qty,
        SUM(return_qty) AS return_qty
      FROM (
        SELECT barcode::text, item_name, qty AS purchase_qty, 0 AS sale_qty, 0 AS return_qty
        FROM purchases
        WHERE is_deleted = FALSE AND purchase_date BETWEEN $1 AND $2
        UNION ALL
        SELECT barcode::text, item_name, 0, qty, 0
        FROM sales
        WHERE is_deleted = FALSE AND sale_date BETWEEN $1 AND $2
        UNION ALL
        SELECT barcode::text, item_name, 0, 0, return_qty
        FROM sale_returns
        WHERE created_at::date BETWEEN $1 AND $2
      ) t
      GROUP BY barcode, item_name
      ORDER BY barcode;
    `;
    const result = await pg.query(sql, [start_date, end_date]);
    res.json({ success: true, rows: result.rows });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post("/api/archive-delete", async (req, res) => {
  try {
    const { start_date, end_date, password } = req.body;
    if (password !== "faizanyounus2122")
      return res.json({ success: false, error: "Wrong password" });

    await pg.query(`DELETE FROM purchases WHERE purchase_date BETWEEN $1 AND $2`, [start_date, end_date]);
    await pg.query(`DELETE FROM sales WHERE sale_date BETWEEN $1 AND $2`, [start_date, end_date]);
    await pg.query(`DELETE FROM sale_returns WHERE created_at::date BETWEEN $1 AND $2`, [start_date, end_date]);

    res.json({ success: true, message: "Data Deleted Successfully!" });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});


module.exports = app;
