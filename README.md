# Studio Shop

A digital portfolio and online shop with a separate, private admin dashboard. Both use the same database, so anything you change in the admin shows up in the shop right away.

- **Shop** (`/`): browse designs, search and filter, cart, checkout, pay with GCash / Maya / MariBank, upload a receipt, track the order.
- **Admin** (`/admin/`): products, orders and payment verification, sales and revenue, settings.

## Run it

Requires Node.js 18 or newer.

```bash
npm install
ADMIN_PASSWORD='choose-a-strong-password' npm start
```

Open http://localhost:3000 for the shop and http://localhost:3000/admin/ for the dashboard.

- On first start the admin account is created. Username is `admin` (or `ADMIN_USERNAME`). If you do not set `ADMIN_PASSWORD`, a random password is printed once in the terminal.
- Change the password later in **Admin > Settings**.
- Optional: `npm run seed` adds six sample designs so the shop is not empty. Delete them in Admin > Products.

## First things to do in Admin

1. **Settings**: set your shop name, headline, and your GCash / Maya / MariBank account name and number. Upload your QR codes if you have them. Customers see these at checkout.
2. **Products > Add product**: upload images, enter the name, price and category, then press **Publish product**. It is live in the shop immediately, with no code changes.
3. **Orders**: when a customer pays, the order appears as *Payment Verification*. Open it, look at the receipt, check the money arrived in your app, then press **Approve payment**.

## How payments work

GCash, Maya and MariBank do not offer a simple public checkout API for individual sellers, so this uses **manual payment with admin verification**:

1. The customer sends the exact total to your account and enters the reference number and a receipt screenshot.
2. The order is saved as **Payment Verification**. A screenshot never marks an order as paid.
3. You check your wallet or bank app, then **Approve** (becomes *Paid*) or **Reject** with a reason. The customer sees the result on their order page.
4. Revenue only counts orders that are *Paid* or *Completed*.

Statuses: Pending Payment, Payment Verification, Paid, Rejected, Completed, Cancelled.

**Delivering files:** each product has an optional *download link* (for example a private Google Drive or Dropbox link). The customer only sees it after you mark the order Paid. Products without a link show "Your files will be sent to your email", so you send them yourself.

## Security

- Admin login uses a bcrypt-hashed password, an HttpOnly SameSite=Strict session cookie, login rate limiting, and a cross-origin write check. All admin API routes require a signed-in session.
- No credentials are in the code. The session secret is generated and stored in `data/` (or set `SESSION_SECRET`).
- Prices and totals are always calculated on the server from the database, never trusted from the browser.
- All input is validated on the server. Uploads are checked by their real file contents (JPG, PNG, WebP only), renamed to random names, and size limited.
- Payment receipts are stored in a private folder with no public URL. Only a signed-in admin can view them.
- Customers look up an order with the order code **and** the email used at checkout.
- Security headers (CSP, no framing, nosniff) are set with Helmet.

## Putting it online

Use any host that runs Node and has a **persistent disk** (the database and uploads live in `DATA_DIR`). Set these environment variables (see `.env.example`):

`NODE_ENV=production`, `TRUST_PROXY=true`, `ADMIN_PASSWORD`, `DATA_DIR` (path to the persistent disk).

Always serve it over HTTPS. **Back up the `data/` folder** regularly: it holds your products, orders and receipts.

## Project layout

```
server.js     API, admin auth, uploads, reports
db.js         SQLite schema and first-run setup
seed.js       optional sample products
public/       the customer shop (HTML, CSS, JS)
admin/        the admin dashboard (HTML, CSS, JS)
data/         created on first run: shop.db, uploads/, receipts/ (private)
```
