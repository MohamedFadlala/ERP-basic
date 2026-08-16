# Holool App

An Electron ERP with role-based purchasing, inventory, pricing, POS, accounting, reporting, and payroll workflows backed by SQLite.

## Included

- Role templates for Cashier, Purchasing, Warehouse, Pricing, Accountant, Financial, Commercial, General, Treasury, and Staff users.
- Commercial-then-Financial approved purchase orders with automatic Accounting handoff, PO-linked supplier invoices, funding authorization, Accountant disbursement orders, Treasury payment vouchers, and quantity-only warehouse receipt.
- Role-aware workflow shortcuts in the left navigation and validated dialogs for operational decisions.
- Landed-cost pricing with versioned manual or markup-based published prices and POS floor-price enforcement.
- Immutable completed sales with approved returns and separately posted refunds.
- Salary grades and payroll submission, approval, and payment segregation.
- Double-entry journals, operational/financial reports, audit events, and administrator-managed users.
- Scrypt password hashing with transparent migration of legacy credentials.

The editable schema is at `database/schema.sql`. During development the standard SQLite file is `data/dev.sqlite`; it can be opened with DB Browser for SQLite or another SQLite editor. See `database/README.md` for table links, posting rules, and formulas.

## Run

```bash
npm install
npm start
```

Administrators create role accounts in Settings and communicate credentials securely. New passwords must contain at least eight characters.

## Verify

```bash
npm test
```

The tests build a fresh schema and exercise purchasing through receipt, pricing, POS, returns/refunds, payroll approval/payment, journal balancing, and foreign-key integrity.

## Package for Windows

```bash
npm run dist
```
