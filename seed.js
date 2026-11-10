// Optional: adds a few sample designs so a fresh shop is not empty.
// Run with `npm run seed`. Delete them from Admin > Products whenever you like.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, UPLOAD_DIR } = require('./db');

if (db.prepare('SELECT COUNT(*) n FROM products').get().n > 0) {
  console.log('Products already exist, skipping sample data.');
  process.exit(0);
}

const samples = [
  { name: 'Sunset Gig Poster', cat: 'Posters', price: 350, bg: '#ff4f81', fg: '#ffd43b', shape: 'sun', desc: 'A bold, print-ready gig poster. Layered vector shapes, editable text, A3 and A4 sizes.' },
  { name: 'Monogram Logo Pack', cat: 'Logos', price: 1200, bg: '#0e1116', fg: '#6b7aff', shape: 'mono', desc: 'Three logo directions with colour and one-colour versions, plus a short usage guide.' },
  { name: 'Story Template Set', cat: 'Story Designs', price: 280, bg: '#2a3bff', fg: '#ffffff', shape: 'frame', desc: 'Ten 1080x1920 story templates for announcements, promos and quotes.' },
  { name: 'Event Pubmat', cat: 'Pubmats', price: 250, bg: '#ffd43b', fg: '#0e1116', shape: 'stripes', desc: 'A clean event pubmat with room for your schedule, speakers and sponsors.' },
  { name: 'Brand Pattern Graphics', cat: 'Graphics', price: 400, bg: '#16c79a', fg: '#0e1116', shape: 'dots', desc: 'Seamless pattern tiles in five colourways for packaging, backgrounds and social posts.' },
  { name: 'Festival Poster', cat: 'Posters', price: 450, bg: '#6b7aff', fg: '#ffd43b', shape: 'rings', desc: 'High-energy festival poster with layered circles and expressive type.' },
];

function art({ bg, fg, shape, name }) {
  const shapes = {
    sun: `<circle cx="200" cy="240" r="120" fill="${fg}"/><rect x="0" y="330" width="400" height="30" fill="${bg}"/><rect x="0" y="380" width="400" height="20" fill="${bg}"/><rect x="0" y="420" width="400" height="12" fill="${bg}"/>`,
    mono: `<rect x="110" y="140" width="180" height="180" rx="22" fill="none" stroke="${fg}" stroke-width="14"/><path d="M150 290V170l50 70 50-70v120" fill="none" stroke="${fg}" stroke-width="14" stroke-linejoin="round"/>`,
    frame: `<rect x="40" y="60" width="320" height="480" rx="26" fill="none" stroke="${fg}" stroke-width="10"/><circle cx="200" cy="230" r="60" fill="${fg}"/><rect x="90" y="340" width="220" height="18" rx="9" fill="${fg}"/><rect x="120" y="376" width="160" height="18" rx="9" fill="${fg}" opacity=".6"/>`,
    stripes: Array.from({ length: 9 }, (_, i) => `<rect x="${-20 + i * 52}" y="0" width="26" height="600" fill="${fg}" transform="skewX(-14)" opacity="${0.15 + (i % 3) * 0.2}"/>`).join('') + `<rect x="60" y="230" width="280" height="140" fill="${fg}"/>`,
    dots: Array.from({ length: 42 }, (_, i) => `<circle cx="${50 + (i % 6) * 60}" cy="${70 + Math.floor(i / 6) * 70}" r="${10 + ((i * 7) % 5) * 5}" fill="${fg}" opacity="${0.4 + ((i * 3) % 5) * 0.12}"/>`).join(''),
    rings: `<circle cx="200" cy="250" r="150" fill="none" stroke="${fg}" stroke-width="16"/><circle cx="200" cy="250" r="100" fill="none" stroke="${fg}" stroke-width="16" opacity=".7"/><circle cx="200" cy="250" r="50" fill="${fg}"/>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 500" width="800" height="1000"><rect width="400" height="500" fill="${bg}"/>${shapes[shape]}<text x="28" y="462" font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="30" fill="${fg}">${name.replace(/&/g, '&amp;')}</text></svg>`;
}

const cat = (n) => db.prepare('SELECT id FROM categories WHERE name = ?').get(n).id;
const t = new Date().toISOString();
for (const s of samples) {
  const info = db.prepare('INSERT INTO products (name, description, price_cents, category_id, published, available, created_at, updated_at) VALUES (?,?,?,?,1,1,?,?)')
    .run(s.name, s.desc, s.price * 100, cat(s.cat), t, t);
  const file = `sample-${crypto.randomBytes(6).toString('hex')}.svg`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), art(s));
  db.prepare('INSERT INTO product_images (product_id, filename, sort_order) VALUES (?,?,0)').run(info.lastInsertRowid, file);
}
console.log(`Added ${samples.length} sample products.`);
