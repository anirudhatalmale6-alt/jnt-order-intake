/* J&T Order Intake - buyer order form + admin panel.
 *
 * Flow: buyer opens the public link (shared under a Facebook post), fills in the
 * SAME recipient fields J&T's own order page uses (Name, Phone +63,
 * Province -> City -> Barangay, detailed address) plus what they're buying.
 * The order lands in the seller's admin panel. Seller reviews and Approves.
 * The sender side is fixed to the seller's own info (set once in Settings),
 * so buyers never see or touch it.
 *
 * When the seller has J&T merchant API credentials we wire "Approve" straight
 * to J&T to create the waybill. Until then, an approved order can be exported
 * as a J&T bulk-upload CSV.
 */
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 4700;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'jnt-admin-token';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'orders.db');

// ---- PH location data (province -> city -> [barangays]) ----
const LOCATIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'ph_locations.json'), 'utf8'));
const PROVINCES = Object.keys(LOCATIONS);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id           TEXT PRIMARY KEY,
    created_at   INTEGER,
    status       TEXT DEFAULT 'pending',
    buyer_name   TEXT,
    phone        TEXT,
    province     TEXT,
    city         TEXT,
    barangay     TEXT,
    address      TEXT,
    item         TEXT,
    size         TEXT,
    qty          INTEGER DEFAULT 1,
    amount       TEXT,
    payment      TEXT,
    note         TEXT,
    tracking_no  TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
`);

// Seller / sender defaults (editable in the admin Settings tab).
const SENDER_DEFAULTS = {
  sender_name: '', sender_phone: '', sender_province: '', sender_city: '',
  sender_barangay: '', sender_address: '', shop_name: 'My Shop'
};
const getSetting = db.prepare('SELECT v FROM settings WHERE k = ?');
const setSetting = db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');
function settings() {
  const out = { ...SENDER_DEFAULTS };
  for (const k of Object.keys(SENDER_DEFAULTS)) {
    const row = getSetting.get(k);
    if (row) out[k] = row.v;
  }
  return out;
}

const app = express();
app.use(express.json({ limit: '256kb' }));

function requireAdmin(req, res, next) {
  const t = req.headers['x-admin-token'] || '';
  if (t !== ADMIN_TOKEN) return res.status(401).json({ error: 'not authorized' });
  next();
}

// ---------- public: location dropdowns ----------
app.get('/api/locations/provinces', (req, res) => res.json(PROVINCES));
app.get('/api/locations/cities', (req, res) => {
  const p = LOCATIONS[req.query.province];
  res.json(p ? Object.keys(p) : []);
});
app.get('/api/locations/barangays', (req, res) => {
  const p = LOCATIONS[req.query.province];
  res.json(p && p[req.query.city] ? p[req.query.city] : []);
});

// ---------- public: shop name for the form header ----------
app.get('/api/shop', (req, res) => res.json({ shop_name: settings().shop_name }));

// ---------- public: create order ----------
function newRef() {
  const s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 6; i++) r += s[Math.floor(Math.random() * s.length)];
  return 'ORD-' + r;
}
const insertOrder = db.prepare(`INSERT INTO orders
  (id, created_at, status, buyer_name, phone, province, city, barangay, address, item, size, qty, amount, payment, note)
  VALUES (@id,@created_at,'pending',@buyer_name,@phone,@province,@city,@barangay,@address,@item,@size,@qty,@amount,@payment,@note)`);

app.post('/api/order', (req, res) => {
  const b = req.body || {};
  const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n || 200);
  const name = clean(b.buyer_name, 120);
  let phone = clean(b.phone, 20).replace(/[^\d]/g, '');
  const province = clean(b.province, 80);
  const city = clean(b.city, 80);
  const barangay = clean(b.barangay, 120);
  const address = clean(b.address, 300);

  if (!name) return res.status(400).json({ error: 'Please enter your name' });
  if (phone.startsWith('63')) phone = phone.slice(2);
  if (phone.startsWith('0')) phone = phone.slice(1);
  if (phone.length !== 10) return res.status(400).json({ error: 'Please enter a valid PH mobile number (10 digits after +63)' });
  if (!LOCATIONS[province]) return res.status(400).json({ error: 'Please choose a valid province' });
  if (!LOCATIONS[province][city]) return res.status(400).json({ error: 'Please choose a valid city/municipality' });
  if (!address) return res.status(400).json({ error: 'Please enter your detailed address' });

  let qty = parseInt(b.qty, 10); if (!Number.isFinite(qty) || qty < 1) qty = 1; if (qty > 999) qty = 999;
  const rec = {
    id: newRef(), created_at: Date.now(),
    buyer_name: name, phone: '+63' + phone,
    province, city, barangay: clean(b.barangay, 120), address,
    item: clean(b.item, 160), size: clean(b.size, 40), qty,
    amount: clean(b.amount, 40), payment: clean(b.payment, 40), note: clean(b.note, 500)
  };
  insertOrder.run(rec);
  res.json({ ok: true, ref: rec.id });
});

// ---------- admin ----------
app.post('/admin/login', (req, res) => {
  const { user, pass } = req.body || {};
  if (user === ADMIN_USER && pass === ADMIN_PASS) return res.json({ ok: true, token: ADMIN_TOKEN });
  res.status(401).json({ error: 'wrong username or password' });
});

app.get('/api/orders', requireAdmin, (req, res) => {
  const status = req.query.status;
  const rows = status && status !== 'all'
    ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  res.json(rows);
});

app.post('/api/orders/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!['pending', 'approved', 'rejected', 'shipped'].includes(status))
    return res.status(400).json({ error: 'bad status' });
  const r = db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ ok: r.changes > 0 });
});

app.delete('/api/orders/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// J&T-format view of one order (sender fixed + recipient from the order)
app.get('/api/orders/:id/jnt', requireAdmin, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'not found' });
  const s = settings();
  res.json({
    sender: { name: s.sender_name, phone: s.sender_phone, province: s.sender_province,
      city: s.sender_city, barangay: s.sender_barangay, address: s.sender_address },
    recipient: { name: o.buyer_name, phone: o.phone, province: o.province,
      city: o.city, barangay: o.barangay, address: o.address },
    parcel: { item: o.item, size: o.size, qty: o.qty, amount: o.amount, payment: o.payment, note: o.note }
  });
});

// J&T bulk-upload CSV of approved orders (import into the J&T VIP dashboard)
app.get('/api/export.csv', requireAdmin, (req, res) => {
  const s = settings();
  const rows = db.prepare("SELECT * FROM orders WHERE status = 'approved' ORDER BY created_at").all();
  const head = ['Ref', 'Sender Name', 'Sender Phone', 'Sender Address',
    'Recipient Name', 'Recipient Phone', 'Province', 'City', 'Barangay',
    'Recipient Address', 'Item', 'Qty', 'Amount', 'Payment', 'Note'];
  const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const senderAddr = [s.sender_address, s.sender_barangay, s.sender_city, s.sender_province].filter(Boolean).join(', ');
  const lines = [head.map(esc).join(',')];
  for (const o of rows) {
    lines.push([o.id, s.sender_name, s.sender_phone, senderAddr,
      o.buyer_name, o.phone, o.province, o.city, o.barangay, o.address,
      o.item, o.qty, o.amount, o.payment, o.note].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="jnt-orders.csv"');
  res.send(lines.join('\r\n'));
});

app.get('/api/settings', requireAdmin, (req, res) => res.json(settings()));
app.post('/api/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  for (const k of Object.keys(SENDER_DEFAULTS)) {
    if (b[k] != null) setSetting.run(k, String(b[k]).slice(0, 300));
  }
  res.json({ ok: true, settings: settings() });
});

app.use('/', express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log('J&T order intake on :' + PORT));
