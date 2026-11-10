const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');          // public product images
const RECEIPT_DIR = path.join(DATA_DIR, 'receipts');        // PRIVATE: only served to the logged-in admin
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(RECEIPT_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'shop.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  published INTEGER NOT NULL DEFAULT 1,
  available INTEGER NOT NULL DEFAULT 1,
  delivery_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS product_images (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL,
  reference_number TEXT NOT NULL DEFAULT '',
  receipt_file TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  reject_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_images_product ON product_images(product_id, sort_order);
`);

const DEFAULT_SETTINGS = {
  shop_name: 'Your Studio',
  tagline: 'Posters, logos, story designs and pubmats made to order.',
  about: 'I design posters, logos, story templates, pubmats and graphics. Pick a design, pay with GCash, Maya or MariBank, and I will send your files once your payment is verified.',
  contact_email: '',
  'pay_gcash': JSON.stringify({ account_name: '', account_number: '', instructions: 'Open GCash, tap Send Money, and send the exact total. Then enter the reference number and upload a screenshot of your receipt.' }),
  'pay_maya': JSON.stringify({ account_name: '', account_number: '', instructions: 'Open Maya, tap Send Money, and send the exact total. Then enter the reference number and upload a screenshot of your receipt.' }),
  'pay_maribank': JSON.stringify({ account_name: '', account_number: '', instructions: 'Open the MariBank app, choose Send Money, and send the exact total. Then enter the reference number and upload a screenshot of your receipt.' }),
};
const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

const insCat = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
for (const c of ['Posters', 'Logos', 'Story Designs', 'Pubmats', 'Graphics', 'Other']) insCat.run(c);

function getSetting(key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// First run: create the admin account. Credentials come from the environment,
// or a random password is generated and printed once. Nothing is hard-coded.
function ensureAdmin() {
  const count = db.prepare('SELECT COUNT(*) c FROM admins').get().c;
  if (count > 0) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  let password = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (!password) { password = crypto.randomBytes(9).toString('base64url'); generated = true; }
  if (password.length < 10) { console.error('ADMIN_PASSWORD must be at least 10 characters.'); process.exit(1); }
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, bcrypt.hashSync(password, 12));
  console.log('\n=== Admin account created ===');
  console.log('Username:', username);
  if (generated) console.log('Password:', password, '\n(shown once - change it in Admin > Settings)');
  else console.log('Password: taken from ADMIN_PASSWORD');
  console.log('=============================\n');
}

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, '.session_secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

module.exports = { db, DATA_DIR, UPLOAD_DIR, RECEIPT_DIR, getSetting, setSetting, ensureAdmin, sessionSecret };
