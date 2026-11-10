const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { db, UPLOAD_DIR, RECEIPT_DIR, getSetting, setSetting, ensureAdmin, sessionSecret } = require('./db');

ensureAdmin();

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const STATUSES = ['Pending Payment', 'Payment Verification', 'Paid', 'Rejected', 'Completed', 'Cancelled'];
const REVENUE_STATUSES = ['Paid', 'Completed'];
const METHODS = { gcash: 'GCash', maya: 'Maya', maribank: 'MariBank' };
const MAX_CART_ITEMS = 30;

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '100kb' }));

// ---------- helpers ----------
const now = () => new Date().toISOString();
const toCents = (pesos) => Math.round(Number(pesos) * 100);
const fromCents = (c) => c / 100;
const fail = (res, code, message, field) => res.status(code).json({ error: message, field });

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml' };

function saveImage(dir, file, prefix) {
  const ext = sniffImage(file.buffer);
  if (!ext) return null; // not a real JPEG/PNG/WebP, whatever the extension claims
  const name = `${prefix}-${crypto.randomBytes(12).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(dir, name), file.buffer, { mode: 0o640 });
  return name;
}
function removeFile(dir, name) {
  if (!name || !/^[\w.-]+$/.test(name)) return;
  fs.rm(path.join(dir, name), { force: true }, () => {});
}

const uploadImages = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 6 } });
const uploadReceipt = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 1, fields: 20 } });

function handleUpload(mw) {
  return (req, res, next) => mw(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return fail(res, 400, 'That file is too large. Images must be under 8 MB (receipts under 6 MB).');
    return fail(res, 400, 'The upload could not be read. Try a different image.');
  });
}

const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '');

function productRows(where = '', params = []) {
  const rows = db.prepare(`
    SELECT p.*, c.name AS category FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    ${where} ORDER BY p.created_at DESC, p.id DESC`).all(...params);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const imgs = db.prepare(`SELECT id, product_id, filename FROM product_images WHERE product_id IN (${ids.map(() => '?').join(',')}) ORDER BY sort_order, id`).all(...ids);
  const byProduct = {};
  for (const i of imgs) (byProduct[i.product_id] ||= []).push({ id: i.id, url: `/uploads/${i.filename}` });
  return rows.map((r) => ({
    id: r.id, name: r.name, description: r.description, price: fromCents(r.price_cents),
    category_id: r.category_id, category: r.category, published: !!r.published, available: !!r.available,
    delivery_url: r.delivery_url, images: byProduct[r.id] || [], created_at: r.created_at, updated_at: r.updated_at,
  }));
}
const publicProduct = (p) => ({ id: p.id, name: p.name, description: p.description, price: p.price, category: p.category, available: p.available, images: p.images, updated_at: p.updated_at });

function orderCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const bytes = crypto.randomBytes(8);
    let s = '';
    for (const b of bytes) s += alphabet[b % alphabet.length];
    const code = `ORD-${s}`;
    if (!db.prepare('SELECT 1 FROM orders WHERE code = ?').get(code)) return code;
  }
}

function orderDetail(o, { admin = false } = {}) {
  const items = db.prepare(`
    SELECT oi.id, oi.product_id, oi.name, oi.price_cents, p.delivery_url
    FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ?`).all(o.id);
  const unlocked = REVENUE_STATUSES.includes(o.status);
  const out = {
    code: o.code, status: o.status, total: fromCents(o.total_cents), payment_method: o.payment_method,
    payment_method_label: METHODS[o.payment_method], reference_number: o.reference_number,
    has_receipt: !!o.receipt_file, reject_reason: o.reject_reason, created_at: o.created_at, updated_at: o.updated_at,
    paid_at: o.paid_at,
    items: items.map((i) => ({
      name: i.name, price: fromCents(i.price_cents),
      // Download links are only revealed after the payment is verified by the admin.
      delivery_url: unlocked && i.delivery_url ? i.delivery_url : '',
    })),
  };
  if (admin) {
    out.id = o.id; out.customer_name = o.customer_name; out.email = o.email; out.phone = o.phone; out.notes = o.notes;
    out.events = db.prepare('SELECT status, note, created_at FROM order_events WHERE order_id = ? ORDER BY id').all(o.id);
    out.items = items.map((i) => ({ name: i.name, price: fromCents(i.price_cents), product_id: i.product_id }));
  } else {
    out.customer_name = o.customer_name;
  }
  return out;
}

function logEvent(orderId, status, note = '') {
  db.prepare('INSERT INTO order_events (order_id, status, note, created_at) VALUES (?, ?, ?, ?)').run(orderId, status, note, now());
}

// ---------- rate limiters ----------
const limiter = (windowMs, max, message) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: message } });
const orderLimiter = limiter(60 * 60 * 1000, 30, 'Too many orders from this connection. Please try again later.');
const lookupLimiter = limiter(15 * 60 * 1000, 40, 'Too many attempts. Please wait a few minutes and try again.');
const loginLimiter = limiter(15 * 60 * 1000, 10, 'Too many login attempts. Try again in 15 minutes.');

// =====================================================================
// PUBLIC SHOP API
// =====================================================================
const api = express.Router();
api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

api.get('/shop', (req, res) => {
  const payments = {};
  for (const key of Object.keys(METHODS)) {
    let cfg = {};
    try { cfg = JSON.parse(getSetting(`pay_${key}`) || '{}'); } catch { /* ignore */ }
    const qr = getSetting(`qr_${key}`);
    payments[key] = { label: METHODS[key], account_name: cfg.account_name || '', account_number: cfg.account_number || '', instructions: cfg.instructions || '', qr_url: qr ? `/uploads/${qr}` : '' };
  }
  const categories = db.prepare(`
    SELECT c.id, c.name, COUNT(p.id) AS count FROM categories c
    LEFT JOIN products p ON p.category_id = c.id AND p.published = 1
    GROUP BY c.id ORDER BY c.name`).all();
  res.json({
    shop_name: getSetting('shop_name'), tagline: getSetting('tagline'), about: getSetting('about'),
    contact_email: getSetting('contact_email'), payments, categories,
  });
});

api.get('/products', (req, res) => {
  const rows = productRows('WHERE p.published = 1').map(publicProduct);
  res.json({ products: rows });
});

api.get('/products/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return fail(res, 404, 'Product not found.');
  const p = productRows('WHERE p.published = 1 AND p.id = ?', [id])[0];
  if (!p) return fail(res, 404, 'Product not found.');
  res.json({ product: publicProduct(p) });
});

api.post('/orders', orderLimiter, handleUpload(uploadReceipt.single('receipt')), (req, res) => {
  const b = req.body || {};
  const name = clean(b.customer_name, 100);
  const email = clean(b.email, 160).toLowerCase();
  const phone = clean(b.phone, 25);
  const notes = clean(b.notes, 500);
  const method = clean(b.payment_method, 20);
  const reference = clean(b.reference_number, 60);

  if (name.length < 2) return fail(res, 400, 'Enter your full name.', 'customer_name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(res, 400, 'Enter a valid email address.', 'email');
  if (!/^[0-9+()\-\s]{7,25}$/.test(phone)) return fail(res, 400, 'Enter a valid contact number, like 09171234567.', 'phone');
  if (!METHODS[method]) return fail(res, 400, 'Choose GCash, Maya or MariBank.', 'payment_method');
  if (reference && !/^[A-Za-z0-9\- ]{4,60}$/.test(reference)) return fail(res, 400, 'The reference number should be 4–60 letters or numbers.', 'reference_number');

  let ids;
  try { ids = JSON.parse(b.items || '[]'); } catch { ids = null; }
  if (!Array.isArray(ids) || !ids.length) return fail(res, 400, 'Your cart is empty.', 'items');
  ids = [...new Set(ids.map(Number))];
  if (ids.length > MAX_CART_ITEMS || ids.some((n) => !Number.isInteger(n) || n < 1)) return fail(res, 400, 'Your cart has invalid items.', 'items');

  // Prices always come from the database, never from the browser.
  const products = db.prepare(`SELECT id, name, price_cents, published, available FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const bad = ids.filter((id) => { const p = products.find((x) => x.id === id); return !p || !p.published || !p.available; });
  if (bad.length) return fail(res, 409, 'Some items in your cart are no longer available. Remove them and try again.', 'items');

  const hasProof = !!req.file || !!reference;
  let receiptFile = '';
  if (hasProof) {
    if (!reference) return fail(res, 400, 'Enter the reference number from your payment receipt.', 'reference_number');
    if (!req.file) return fail(res, 400, 'Upload a screenshot of your payment receipt.', 'receipt');
    receiptFile = saveImage(RECEIPT_DIR, req.file, 'rc');
    if (!receiptFile) return fail(res, 400, 'The receipt must be a JPG, PNG or WebP image.', 'receipt');
  }

  const total = products.reduce((s, p) => s + p.price_cents, 0);
  const status = hasProof ? 'Payment Verification' : 'Pending Payment';
  const t = now();
  const code = orderCode();
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO orders (code, customer_name, email, phone, notes, payment_method, reference_number, receipt_file, status, total_cents, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(code, name, email, phone, notes, method, reference, receiptFile, status, total, t, t);
    const oid = info.lastInsertRowid;
    const ins = db.prepare('INSERT INTO order_items (order_id, product_id, name, price_cents) VALUES (?,?,?,?)');
    for (const p of products) ins.run(oid, p.id, p.name, p.price_cents);
    logEvent(oid, status, hasProof ? 'Order placed with payment proof.' : 'Order placed. Waiting for payment proof.');
    return oid;
  });
  const oid = tx();
  res.status(201).json({ order: orderDetail(db.prepare('SELECT * FROM orders WHERE id = ?').get(oid)) });
});

function findOrder(code, email) {
  const o = db.prepare('SELECT * FROM orders WHERE code = ?').get(clean(code, 20).toUpperCase());
  if (!o) return null;
  const a = Buffer.from(o.email);
  const b = Buffer.from(clean(email, 160).toLowerCase());
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return o;
}

api.post('/orders/lookup', lookupLimiter, (req, res) => {
  const o = findOrder(req.body && req.body.code, req.body && req.body.email);
  if (!o) return fail(res, 404, 'No order matches that code and email.');
  res.json({ order: orderDetail(o) });
});

api.post('/orders/:code/proof', lookupLimiter, handleUpload(uploadReceipt.single('receipt')), (req, res) => {
  const o = findOrder(req.params.code, req.body && req.body.email);
  if (!o) return fail(res, 404, 'No order matches that code and email.');
  if (!['Pending Payment', 'Rejected'].includes(o.status)) return fail(res, 409, 'This order is not waiting for payment proof.');
  const reference = clean(req.body.reference_number, 60);
  if (!/^[A-Za-z0-9\- ]{4,60}$/.test(reference)) return fail(res, 400, 'Enter the reference number from your payment receipt.', 'reference_number');
  if (!req.file) return fail(res, 400, 'Upload a screenshot of your payment receipt.', 'receipt');
  const file = saveImage(RECEIPT_DIR, req.file, 'rc');
  if (!file) return fail(res, 400, 'The receipt must be a JPG, PNG or WebP image.', 'receipt');
  removeFile(RECEIPT_DIR, o.receipt_file);
  db.prepare(`UPDATE orders SET reference_number = ?, receipt_file = ?, status = 'Payment Verification', reject_reason = '', updated_at = ? WHERE id = ?`).run(reference, file, now(), o.id);
  logEvent(o.id, 'Payment Verification', 'Customer submitted payment proof.');
  res.json({ order: orderDetail(db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id)) });
});

app.use('/api', api);

// public product images / QR codes. Sandboxed so an image can never run script.
app.use('/uploads', express.static(UPLOAD_DIR, {
  index: false, dotfiles: 'deny', maxAge: '7d', immutable: true,
  setHeaders(res) {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  },
}));

// =====================================================================
// ADMIN
// =====================================================================
class SqliteStore extends session.Store {
  get(sid, cb) {
    try {
      const r = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!r || r.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(r.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 8 * 3600e3;
      db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires').run(sid, JSON.stringify(sess), exp);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) { try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb && cb(null); } catch (e) { cb && cb(e); } }
}
setInterval(() => { try { db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()); } catch { /* ignore */ } }, 3600e3).unref();

const admin = express.Router();
admin.use(session({
  name: 'studio_admin',
  secret: sessionSecret(),
  store: new SqliteStore(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: IS_PROD, maxAge: 8 * 3600e3, path: '/admin' },
}));
admin.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// CSRF defence in depth (cookie is SameSite=Strict as well): reject cross-origin writes.
admin.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.get('host'); } catch { /* ignore */ }
    if (!ok) return fail(res, 403, 'Cross-origin request blocked.');
  }
  next();
});

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);
admin.post('/api/login', loginLimiter, (req, res) => {
  const username = clean(req.body && req.body.username, 60);
  const password = typeof (req.body && req.body.password) === 'string' ? req.body.password.slice(0, 200) : '';
  const user = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  const ok = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH) && !!user;
  if (!ok) return fail(res, 401, 'Wrong username or password.');
  req.session.regenerate((err) => {
    if (err) return fail(res, 500, 'Could not start a session.');
    req.session.adminId = user.id;
    req.session.username = user.username;
    res.json({ ok: true, username: user.username });
  });
});
admin.post('/api/logout', (req, res) => req.session.destroy(() => { res.clearCookie('studio_admin', { path: '/admin' }); res.json({ ok: true }); }));
admin.get('/api/me', (req, res) => {
  if (!req.session.adminId) return fail(res, 401, 'Not signed in.');
  res.json({ username: req.session.username });
});

// Everything below this line requires a signed-in admin.
const requireAdmin = (req, res, next) => (req.session.adminId ? next() : fail(res, 401, 'Please sign in.'));
admin.use('/api', requireAdmin);

admin.post('/api/password', (req, res) => {
  const { current, next } = req.body || {};
  if (typeof next !== 'string' || next.length < 10) return fail(res, 400, 'The new password must be at least 10 characters.');
  const user = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.session.adminId);
  if (typeof current !== 'string' || !bcrypt.compareSync(current, user.password_hash)) return fail(res, 400, 'Your current password is wrong.');
  db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 12), user.id);
  res.json({ ok: true });
});

// ----- stats -----
admin.get('/api/stats', (req, res) => {
  const q = (sql, ...p) => db.prepare(sql).get(...p);
  const rev = REVENUE_STATUSES.map(() => '?').join(',');
  const revenue = q(`SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) s FROM orders WHERE status IN (${rev})`, ...REVENUE_STATUSES);
  const byStatus = {};
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM orders GROUP BY status').all()) byStatus[r.status] = r.n;
  const recent = db.prepare('SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 8').all().map((o) => ({
    id: o.id, code: o.code, customer_name: o.customer_name, payment_method: METHODS[o.payment_method], status: o.status, total: fromCents(o.total_cents), created_at: o.created_at,
  }));
  res.json({
    total_sales: revenue.n,
    total_revenue: fromCents(revenue.s),
    total_orders: Object.values(byStatus).reduce((a, b) => a + b, 0),
    pending_payments: (byStatus['Pending Payment'] || 0) + (byStatus['Payment Verification'] || 0),
    needs_verification: byStatus['Payment Verification'] || 0,
    confirmed_payments: byStatus['Paid'] || 0,
    completed_orders: byStatus['Completed'] || 0,
    products: q('SELECT COUNT(*) n FROM products').n,
    recent,
  });
});

// ----- categories -----
admin.get('/api/categories', (req, res) => {
  res.json({ categories: db.prepare('SELECT c.id, c.name, COUNT(p.id) AS count FROM categories c LEFT JOIN products p ON p.category_id = c.id GROUP BY c.id ORDER BY c.name').all() });
});
admin.post('/api/categories', (req, res) => {
  const name = clean(req.body && req.body.name, 40);
  if (name.length < 2) return fail(res, 400, 'Enter a category name.');
  try {
    const info = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
    res.status(201).json({ category: { id: info.lastInsertRowid, name, count: 0 } });
  } catch { fail(res, 409, 'That category already exists.'); }
});
admin.delete('/api/categories/:id', (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) n FROM products WHERE category_id = ?').get(id).n;
  if (used) return fail(res, 409, `This category has ${used} product(s). Move them first.`);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ----- products -----
function parseProductBody(b) {
  const name = clean(b.name, 120);
  const description = clean(b.description, 4000);
  const price = Number(b.price);
  const category_id = b.category_id === '' || b.category_id == null ? null : Number(b.category_id);
  const delivery_url = clean(b.delivery_url, 500);
  if (name.length < 2) return { error: 'Enter a product name.', field: 'name' };
  if (!Number.isFinite(price) || price < 0 || price > 1000000) return { error: 'Enter a price between 0 and 1,000,000.', field: 'price' };
  if (category_id !== null && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(category_id)) return { error: 'Choose a valid category.', field: 'category_id' };
  if (delivery_url && !/^https:\/\/[^\s]+$/i.test(delivery_url)) return { error: 'The download link must start with https://', field: 'delivery_url' };
  const flag = (v, d) => (v === undefined ? d : v === true || v === 'true' || v === 1 || v === '1' ? 1 : 0);
  return { value: { name, description, price_cents: toCents(price), category_id, delivery_url, published: flag(b.published, 1), available: flag(b.available, 1) } };
}

function addImages(productId, files) {
  let order = db.prepare('SELECT COALESCE(MAX(sort_order),-1) m FROM product_images WHERE product_id = ?').get(productId).m;
  const have = db.prepare('SELECT COUNT(*) n FROM product_images WHERE product_id = ?').get(productId).n;
  let added = 0, rejected = 0;
  for (const f of files || []) {
    if (have + added >= 8) { rejected++; continue; }
    const name = saveImage(UPLOAD_DIR, f, 'p');
    if (!name) { rejected++; continue; }
    db.prepare('INSERT INTO product_images (product_id, filename, sort_order) VALUES (?,?,?)').run(productId, name, ++order);
    added++;
  }
  return { added, rejected };
}

admin.get('/api/products', (req, res) => res.json({ products: productRows() }));

admin.post('/api/products', handleUpload(uploadImages.array('images', 6)), (req, res) => {
  const parsed = parseProductBody(req.body || {});
  if (parsed.error) return fail(res, 400, parsed.error, parsed.field);
  const v = parsed.value;
  const t = now();
  const info = db.prepare(`INSERT INTO products (name, description, price_cents, category_id, published, available, delivery_url, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(v.name, v.description, v.price_cents, v.category_id, v.published, v.available, v.delivery_url, t, t);
  const imgs = addImages(info.lastInsertRowid, req.files);
  res.status(201).json({ product: productRows('WHERE p.id = ?', [info.lastInsertRowid])[0], images: imgs });
});

admin.put('/api/products/:id', handleUpload(uploadImages.array('images', 6)), (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) return fail(res, 404, 'Product not found.');
  const parsed = parseProductBody(req.body || {});
  if (parsed.error) return fail(res, 400, parsed.error, parsed.field);
  const v = parsed.value;
  db.prepare(`UPDATE products SET name=?, description=?, price_cents=?, category_id=?, published=?, available=?, delivery_url=?, updated_at=? WHERE id=?`)
    .run(v.name, v.description, v.price_cents, v.category_id, v.published, v.available, v.delivery_url, now(), id);
  const imgs = addImages(id, req.files);
  res.json({ product: productRows('WHERE p.id = ?', [id])[0], images: imgs });
});

admin.delete('/api/products/:id', (req, res) => {
  const id = Number(req.params.id);
  const files = db.prepare('SELECT filename FROM product_images WHERE product_id = ?').all(id);
  const info = db.prepare('DELETE FROM products WHERE id = ?').run(id);
  if (!info.changes) return fail(res, 404, 'Product not found.');
  files.forEach((f) => removeFile(UPLOAD_DIR, f.filename));
  res.json({ ok: true });
});

admin.delete('/api/products/:id/images/:imageId', (req, res) => {
  const img = db.prepare('SELECT * FROM product_images WHERE id = ? AND product_id = ?').get(Number(req.params.imageId), Number(req.params.id));
  if (!img) return fail(res, 404, 'Image not found.');
  db.prepare('DELETE FROM product_images WHERE id = ?').run(img.id);
  removeFile(UPLOAD_DIR, img.filename);
  db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').run(now(), img.product_id);
  res.json({ product: productRows('WHERE p.id = ?', [img.product_id])[0] });
});

admin.post('/api/products/:id/images/:imageId/cover', (req, res) => {
  const pid = Number(req.params.id);
  const img = db.prepare('SELECT * FROM product_images WHERE id = ? AND product_id = ?').get(Number(req.params.imageId), pid);
  if (!img) return fail(res, 404, 'Image not found.');
  const min = db.prepare('SELECT MIN(sort_order) m FROM product_images WHERE product_id = ?').get(pid).m;
  db.prepare('UPDATE product_images SET sort_order = ? WHERE id = ?').run(min - 1, img.id);
  db.prepare('UPDATE products SET updated_at = ? WHERE id = ?').run(now(), pid);
  res.json({ product: productRows('WHERE p.id = ?', [pid])[0] });
});

// ----- orders -----
admin.get('/api/orders', (req, res) => {
  const status = clean(req.query.status, 30);
  const q = clean(req.query.q, 80);
  const where = [], params = [];
  if (STATUSES.includes(status)) { where.push('status = ?'); params.push(status); }
  if (q) { where.push('(code LIKE ? OR customer_name LIKE ? OR email LIKE ? OR reference_number LIKE ?)'); const like = `%${q.replace(/[%_]/g, '')}%`; params.push(like, like, like, like); }
  const rows = db.prepare(`SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT 300`).all(...params);
  res.json({
    orders: rows.map((o) => {
      const d = orderDetail(o, { admin: true });
      delete d.events;
      return d;
    }),
  });
});

admin.get('/api/orders/:id', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!o) return fail(res, 404, 'Order not found.');
  res.json({ order: orderDetail(o, { admin: true }) });
});

admin.get('/api/orders/:id/receipt', (req, res) => {
  const o = db.prepare('SELECT receipt_file FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!o || !o.receipt_file || !/^[\w.-]+$/.test(o.receipt_file)) return fail(res, 404, 'No receipt uploaded.');
  const ext = path.extname(o.receipt_file).slice(1);
  res.set({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
  res.sendFile(o.receipt_file, { root: RECEIPT_DIR, dotfiles: 'deny' });
});

admin.post('/api/orders/:id/status', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(req.params.id));
  if (!o) return fail(res, 404, 'Order not found.');
  const status = clean(req.body && req.body.status, 30);
  const note = clean(req.body && req.body.note, 300);
  if (!STATUSES.includes(status)) return fail(res, 400, 'Unknown status.');
  if (status === o.status) return fail(res, 400, `This order is already ${status}.`);
  if (status === 'Completed' && !o.paid_at) return fail(res, 400, 'Verify the payment (mark it Paid) before completing the order.');
  if (status === 'Rejected' && !note) return fail(res, 400, 'Add a short reason so the customer knows what to fix.');
  const t = now();
  let paidAt = o.paid_at;
  if (status === 'Paid') paidAt = o.paid_at || t;
  if (['Pending Payment', 'Payment Verification', 'Rejected', 'Cancelled'].includes(status)) paidAt = null;
  const reason = status === 'Rejected' ? note : '';
  db.prepare('UPDATE orders SET status=?, paid_at=?, reject_reason=?, updated_at=? WHERE id=?').run(status, paidAt, reason, t, o.id);
  logEvent(o.id, status, note || `Status changed to ${status} by admin.`);
  res.json({ order: orderDetail(db.prepare('SELECT * FROM orders WHERE id = ?').get(o.id), { admin: true }) });
});

// ----- sales -----
const PH_OFFSET_MS = 8 * 3600e3; // Philippines is UTC+8 all year
const phNow = () => new Date(Date.now() + PH_OFFSET_MS);
const iso = (d) => d.toISOString().slice(0, 10);

function series(kind) {
  const rev = REVENUE_STATUSES.map(() => '?').join(',');
  const today = phNow();
  let expr, keys = [];
  if (kind === 'daily') {
    expr = `date(paid_at,'+8 hours')`;
    for (let i = 29; i >= 0; i--) keys.push(iso(new Date(today.getTime() - i * 864e5)));
  } else if (kind === 'weekly') {
    expr = `date(paid_at,'+8 hours','weekday 0','-6 days')`;
    const dow = (today.getUTCDay() + 6) % 7; // Monday = 0
    const monday = new Date(today.getTime() - dow * 864e5);
    for (let i = 11; i >= 0; i--) keys.push(iso(new Date(monday.getTime() - i * 7 * 864e5)));
  } else {
    expr = `strftime('%Y-%m', paid_at,'+8 hours')`;
    for (let i = 11; i >= 0; i--) { const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1)); keys.push(d.toISOString().slice(0, 7)); }
  }
  const rows = db.prepare(`SELECT ${expr} AS k, COUNT(*) n, SUM(total_cents) s FROM orders WHERE status IN (${rev}) AND paid_at IS NOT NULL GROUP BY k`).all(...REVENUE_STATUSES);
  const map = Object.fromEntries(rows.map((r) => [r.k, r]));
  return keys.map((k) => ({ key: k, orders: map[k] ? map[k].n : 0, revenue: map[k] ? fromCents(map[k].s) : 0 }));
}

admin.get('/api/sales', (req, res) => {
  const rev = REVENUE_STATUSES.map(() => '?').join(',');
  const total = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) s FROM orders WHERE status IN (${rev})`).get(...REVENUE_STATUSES);
  const todayKey = iso(phNow());
  const monthKey = todayKey.slice(0, 7);
  const sumWhere = (cond, ...p) => db.prepare(`SELECT COALESCE(SUM(total_cents),0) s FROM orders WHERE status IN (${rev}) AND ${cond}`).get(...REVENUE_STATUSES, ...p).s;
  const byMethod = db.prepare(`SELECT payment_method m, COUNT(*) n, SUM(total_cents) s FROM orders WHERE status IN (${rev}) GROUP BY payment_method`).all(...REVENUE_STATUSES);
  const topProducts = db.prepare(`
    SELECT oi.name, COUNT(*) n, SUM(oi.price_cents) s FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN (${rev}) GROUP BY oi.name ORDER BY s DESC LIMIT 8`).all(...REVENUE_STATUSES);
  const history = db.prepare(`SELECT * FROM orders WHERE status IN (${rev}) ORDER BY paid_at DESC LIMIT 100`).all(...REVENUE_STATUSES).map((o) => ({
    id: o.id, code: o.code, customer_name: o.customer_name, payment_method: METHODS[o.payment_method], reference_number: o.reference_number,
    total: fromCents(o.total_cents), status: o.status, paid_at: o.paid_at,
  }));
  res.json({
    total_revenue: fromCents(total.s), total_sales: total.n,
    today: fromCents(sumWhere(`date(paid_at,'+8 hours') = ?`, todayKey)),
    this_month: fromCents(sumWhere(`strftime('%Y-%m', paid_at,'+8 hours') = ?`, monthKey)),
    daily: series('daily'), weekly: series('weekly'), monthly: series('monthly'),
    by_method: Object.keys(METHODS).map((k) => { const r = byMethod.find((x) => x.m === k); return { method: METHODS[k], orders: r ? r.n : 0, revenue: r ? fromCents(r.s) : 0 }; }),
    top_products: topProducts.map((p) => ({ name: p.name, sold: p.n, revenue: fromCents(p.s) })),
    history,
  });
});

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
};
admin.get('/api/sales/export.csv', (req, res) => {
  const okDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  const from = okDate(req.query.from) ? req.query.from : '2000-01-01';
  const to = okDate(req.query.to) ? req.query.to : '2999-12-31';
  const rev = REVENUE_STATUSES.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM orders WHERE status IN (${rev}) AND date(paid_at,'+8 hours') BETWEEN ? AND ? ORDER BY paid_at`).all(...REVENUE_STATUSES, from, to);
  const lines = [['Order', 'Paid on (PH)', 'Customer', 'Email', 'Method', 'Reference', 'Items', 'Total (PHP)', 'Status'].map(csvCell).join(',')];
  for (const o of rows) {
    const items = db.prepare('SELECT name FROM order_items WHERE order_id = ?').all(o.id).map((i) => i.name).join('; ');
    const paid = new Date(new Date(o.paid_at).getTime() + PH_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16);
    lines.push([o.code, paid, o.customer_name, o.email, METHODS[o.payment_method], o.reference_number, items, fromCents(o.total_cents).toFixed(2), o.status].map(csvCell).join(','));
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="sales-${from}-to-${to}.csv"` });
  res.send('﻿' + lines.join('\r\n'));
});

// ----- settings -----
admin.get('/api/settings', (req, res) => {
  const out = { shop_name: getSetting('shop_name'), tagline: getSetting('tagline'), about: getSetting('about'), contact_email: getSetting('contact_email'), payments: {} };
  for (const k of Object.keys(METHODS)) {
    let cfg = {};
    try { cfg = JSON.parse(getSetting(`pay_${k}`) || '{}'); } catch { /* ignore */ }
    const qr = getSetting(`qr_${k}`);
    out.payments[k] = { label: METHODS[k], account_name: cfg.account_name || '', account_number: cfg.account_number || '', instructions: cfg.instructions || '', qr_url: qr ? `/uploads/${qr}` : '' };
  }
  res.json(out);
});
admin.put('/api/settings', (req, res) => {
  const b = req.body || {};
  const shopName = clean(b.shop_name, 60);
  if (shopName.length < 2) return fail(res, 400, 'Enter a shop name.', 'shop_name');
  const email = clean(b.contact_email, 160);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(res, 400, 'Enter a valid contact email.', 'contact_email');
  setSetting('shop_name', shopName);
  setSetting('tagline', clean(b.tagline, 160));
  setSetting('about', clean(b.about, 1200));
  setSetting('contact_email', email);
  for (const k of Object.keys(METHODS)) {
    const p = (b.payments || {})[k] || {};
    setSetting(`pay_${k}`, JSON.stringify({ account_name: clean(p.account_name, 80), account_number: clean(p.account_number, 40), instructions: clean(p.instructions, 600) }));
  }
  res.json({ ok: true });
});
admin.post('/api/settings/qr/:method', handleUpload(uploadReceipt.single('qr')), (req, res) => {
  const m = req.params.method;
  if (!METHODS[m]) return fail(res, 404, 'Unknown payment method.');
  if (!req.file) return fail(res, 400, 'Choose a QR image to upload.');
  const name = saveImage(UPLOAD_DIR, req.file, `qr-${m}`);
  if (!name) return fail(res, 400, 'The QR code must be a JPG, PNG or WebP image.');
  removeFile(UPLOAD_DIR, getSetting(`qr_${m}`));
  setSetting(`qr_${m}`, name);
  res.json({ qr_url: `/uploads/${name}` });
});
admin.delete('/api/settings/qr/:method', (req, res) => {
  const m = req.params.method;
  if (!METHODS[m]) return fail(res, 404, 'Unknown payment method.');
  removeFile(UPLOAD_DIR, getSetting(`qr_${m}`));
  db.prepare('DELETE FROM settings WHERE key = ?').run(`qr_${m}`);
  res.json({ ok: true });
});

admin.use('/api', (req, res) => fail(res, 404, 'Not found.'));
admin.use(express.static(path.join(__dirname, 'admin'), { index: 'index.html', dotfiles: 'deny' }));
app.use('/admin', admin);

// =====================================================================
// SHOP FRONTEND
// =====================================================================
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', dotfiles: 'deny', maxAge: IS_PROD ? '1h' : 0 }));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return fail(res, 404, 'Not found.');
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  if (res.headersSent) return;
  fail(res, 500, 'Something went wrong on the server.');
});

app.listen(PORT, () => {
  console.log(`Shop:  http://localhost:${PORT}/`);
  console.log(`Admin: http://localhost:${PORT}/admin/`);
});
