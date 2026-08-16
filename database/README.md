# Database structure

The development database is `data/dev.sqlite`; `database/schema.sql` is the editable source of truth. Schema version 12 adds Accountant-issued purchase disbursement orders and Treasury-executed payment vouchers to the two-stage Commercial-to-Financial PO approval sequence, role templates, audit events, purchase funding and receipt workflows, purchasing advances, versioned pricing, sales returns/refunds, salary grades, and payroll approvals.

## Accounting design

Every financial transaction creates a `journal_entries` header and balanced `journal_lines`. Database triggers prevent posting an unbalanced journal and prevent modification of posted journal lines. Operational records retain their journal link.

- Sale: debit cash/bank/receivable, credit Sales Revenue; debit Cost of Goods Sold, credit Inventory.
- Goods receipt: debit Inventory and credit Accounts Payable at landed cost.
- Supplier payment: debit Accounts Payable and credit the selected cash or bank account.
- Purchasing advance: debit Purchasing Advances and credit cash/bank when funds are released to the Procurement Manager; receipt later clears the advance against Accounts Payable.
- Sales refund: reverse revenue to the selected cash/bank method and reverse inventory/COGS for restocked items.
- Payroll payment: debit salary expense and credit deductions plus the selected payment account.

## Purchasing, funding, and receipt

Purchasing creates a draft PO and submits it to Finance. A requester cannot approve their own PO. An approved PO becomes open for supplier invoicing; direct purchase invoices are rejected.

The Procurement Manager submits each PO to the Commercial Manager. Commercial approval automatically routes the complete PO to the Financial Manager; final Financial approval opens it for invoicing and hands a read-only copy to Accounting. Procurement can create a supplier directly from either the PO or invoice editor. Submitting the resulting PO-linked invoice creates a `purchase_funding_requests` row. A different Financial Manager authorizes or rejects funding. An Accountant then creates a `purchase_disbursement_orders` instruction that locks the invoice, amount, currency, payment route, and debit account. A different Treasury Manager selects the cash or bank account and posts the payment voucher. Generic Accounts Payable payment vouchers cannot bypass this workflow. Warehouse receives only expected and received quantities—no cost or selling-price fields—and records accepted, damaged, and rejected quantities. Partial receipts remain open.

Additional costs are normalized rows. `purchase_line_costs` allocates them by each line's extended value:

```text
line share = line total / purchase goods total
allocated cost = line share * total additional costs
landed unit cost = (line total + allocated cost) / base quantity
```

## Pricing and POS

Pricing Managers see quantity and landed unit cost. A published price is stored in `product_price_versions` as either a manual price or:

```text
published price = landed unit cost * (1 + markup percent / 100)
```

Publishing expires the prior version for the same scope. POS reads the active version, records that version on the invoice line, permits an authorized Cashier to increase the price, and rejects prices below the published floor. Completed sales are immutable; corrections use approved `sales_returns` and separately posted `refunds`.

## Roles and audit

`role_profiles`, `role_profile_permissions`, and `role_profile_capabilities` define normalized job templates. `user_permissions` and `user_capabilities` add explicit per-user access. Electron handlers enforce capabilities server-side, so hidden UI controls are not the security boundary.

`audit_events` records PO and funding decisions, supplier payments, warehouse receipts, price publication, returns/refunds, and payroll decisions. Passwords are stored as salted scrypt hashes; successful legacy authentication transparently replaces plaintext storage.

## Payroll

`salary_grades` defines reusable salary bands. Payroll begins as a draft, is submitted and locked, approved or rejected by Finance, then paid by a different Accountant. `payroll_approval_history` and the posted journal remain linked to the run.

## Verification

Run `npm test`. The integration suite builds a clean schema and verifies workflow segregation, price floors, completed-sale immutability, journal balance, audit creation, and foreign-key integrity.
