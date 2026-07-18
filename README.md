# J&T Order Intake

A buyer order form + seller admin panel for Facebook sellers who ship via J&T Express (Philippines).

## What it does
- **Buyer link** (share under your FB post): the buyer fills in the same recipient
  fields J&T's own order page uses — Name, Phone (+63), Province → City → Barangay
  (cascading dropdowns from the full PSGC list), detailed address — plus item / size /
  qty / payment. They get a reference number on submit.
- **Admin panel**: every order lands here. Review, then **Approve** / **Reject**.
  Your **sender info is fixed** (set once in Settings) — buyers never see or touch it.
- **Export approved orders** as a J&T bulk-upload CSV (sender + recipient per row) to
  drop into the J&T VIP dashboard. When you have J&T merchant API credentials, the
  "Approve" action can be wired to create the waybill automatically.

## Run
```
npm install
ADMIN_USER=admin ADMIN_PASS=yourpass ADMIN_TOKEN=$(openssl rand -hex 24) node server.js
```
Buyer form: `/`  · Admin: `/admin.html`

## Stack
Node + Express + better-sqlite3. PH location data: PSGC (86 provinces, 1,647 cities/municipalities, 42k barangays).
