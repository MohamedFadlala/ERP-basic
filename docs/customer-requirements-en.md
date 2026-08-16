# Customer requirements — English implementation trace

This document translates the actionable requirements from the supplied Arabic recording and maps them to the implemented ERP behavior. The opening remark about an electricity/charging issue does not describe a software behavior, acceptance criterion, or reproducible defect, so it is recorded as context rather than implemented as a feature.

## Translated requirements and completion

1. **Named, password-protected job roles with role-specific navigation.** Users must sign in with a username and password, see their relevant work areas in the left navigation, and receive only their assigned authority.
   - Implemented with administrator-created users, salted scrypt password hashes, role templates, granular permissions/capabilities, server-side authorization, and role-aware sidebar workflow shortcuts.
   - Predictable default role passwords are deliberately not seeded. Administrators provision real accounts in Settings and communicate credentials securely.

2. **Procurement Manager workflow.** The Procurement Manager creates a purchase order (PO), submits it first to the Commercial Manager and then automatically to the Financial Manager, sees both decisions, creates a supplier invoice only from a finally approved PO, can enter it manually and attach the supplier's invoice, and can create new items needed for purchasing.
   - Implemented with separate Commercial and Financial approval stages, automatic routing and Accounting handoff, separation of requester and both approvers, PO-linked purchase invoices, attachments, supplier creation in both PO and invoice editors, products, additional costs, and audit events.

3. **Financial approval and release of purchase funds.** The Financial Manager approves the PO and authorizes invoice funding. The approved invoice goes to the Accountant, who issues a disbursement order to Treasury. The Treasury Manager chooses the cash or bank account and posts the payment voucher.
   - Implemented as Commercial PO approval, final Financial PO approval, invoice funding authorization, an Accountant instruction that locks the payment purpose and debit account, and independent Treasury execution. The Finance approver, Accountant instructor, and Treasury executor are segregated, and generic Accounts Payable vouchers cannot bypass the purchase workflow.

4. **Warehouse Manager receives quantities only.** Purchased goods are sent to Inventory. Warehouse confirms what arrived and sees quantities, but not purchase cost or selling-price controls.
   - Implemented with quantity-only receipt screens, accepted/damaged/rejected quantities, partial receipts, batch/expiry capture, server-side warehouse capability checks, and no cost capability in the Warehouse role.

5. **Pricing Manager sees stock and landed unit cost and controls selling prices.** Pricing can be entered manually or calculated using a markup percentage and may change as the market changes. Additional purchase costs must form part of unit cost.
   - Implemented with allocated landed-cost calculation, cost visibility restricted to Pricing and authorized oversight roles, manual/markup price publication, effective dates, price history/versioning, and market notes.

6. **Accountant manages ordinary accounting activity and purchase disbursement instructions.** The Accountant handles journal entries and receipts, reviews authorized purchase funding, and issues disbursement orders to Treasury without inheriting Financial Manager approval or Treasury execution authority.
   - Implemented with balanced double-entry posting, controlled vouchers, disbursement orders, chart-of-account access, immutable posted journal lines, and audit trails.

7. **Financial Manager controls finance and HR/payroll approvals.** This role sees accounting and the chart of accounts, approves POs and invoice funding, manages employees/grades/allowances/deductions, calculates net payroll, and approves payroll for Accountant payment.
   - Implemented with finance, accounting, HR and payroll permissions; salary grades and recurring components; draft/submitted/approved/rejected/paid payroll states; and approver/payor separation.

8. **General Manager sees all reports.** Reports must show POs raised/approved, warehouse receipt status, prices, and wider financial/operational results.
   - Implemented with General Manager report access and an operational workflow report covering PO, funding, payment, receipt, pricing, returns, and payroll, alongside the financial and register reports.

9. **Cashier/POS creates customer invoices only.** POS uses the Pricing Manager's published price. The Cashier may increase it but cannot sell below the published floor.
   - Implemented with published-price loading, server-side floor enforcement, explicit price-increase authority, cashier ownership checks on draft edits/deletes, immutable completed sales, and journal/inventory posting.

10. **Commercial Manager has broad non-financial oversight.** This role sees inventory, costs/pricing, operational reports and purchase/sales information, may change pricing, and participates in exceptional returns, but has no HR, accounting, financial approval, or payment authority.
    - Implemented through the Commercial Manager role template with operational read/pricing/return capabilities and explicit exclusion of finance, payroll, journal and payment capabilities.

11. **Returned invoices require controlled settlement.** Commercial and Finance participate in return approval/settlement rather than letting a Cashier silently alter a completed sale.
    - Implemented with return creation, Commercial approval, Finance approval/rejection, restock disposition, and separate Accountant refund posting. Completed invoices stay immutable.

## Cross-cutting controls added

- Dedicated left-navigation shortcuts for each workflow, hidden when the current user lacks the required capability.
- Validated modal forms for approvals, funding, receipts, pricing, returns, salary grades, and payroll decisions.
- Arabic UI translations for the new workflow labels and dialogs.
- Audit records for approval, payment, receipt, price, return/refund, and payroll decisions.
- Integration tests for duty separation, cash advances, journal balance, price floors, draft ownership, completed-sale immutability, password hashing, role isolation, and foreign-key integrity.
