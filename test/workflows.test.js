const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { DatabaseService, initializeDatabase } = require('../electron/database');
const { buildPurchaseOrderHtml } = require('../electron/report-pdf');

async function createService(t) {
  const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const database = new SQL.Database();
  database.run('PRAGMA foreign_keys = ON');
  database.exec(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
  const filePath = path.join(os.tmpdir(), `holool-workflow-${process.pid}-${Date.now()}-${Math.random()}.sqlite`);
  const service = new DatabaseService(database, filePath);
  service.persist();
  t.after(() => {
    database.close();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });
  return service;
}

function seedActorsAndCatalog(service) {
  for (const actor of ['purchaser', 'finance', 'accountant', 'treasury', 'warehouse', 'pricing', 'cashier', 'commercial', 'payroll']) {
    service.run(`INSERT INTO users(id, username, password, role, job_profile)
      VALUES (?, ?, 'test-only', 'Manager', 'Staff')`, [actor, actor]);
  }
  service.run("INSERT INTO suppliers(code, name) VALUES ('SUP-TEST', 'Workflow Supplier')");
  service.run("INSERT INTO products(sku, name, category_id, default_unit_id) VALUES ('SKU-TEST', 'Workflow Product', 1, 1)");
  return {
    supplierId: Number(service.all("SELECT id FROM suppliers WHERE code = 'SUP-TEST'")[0].id),
    productId: Number(service.all("SELECT id FROM products WHERE sku = 'SKU-TEST'")[0].id)
  };
}

test('application locale is shared through app settings and validates supported languages', async t => {
  const service = await createService(t);
  assert.equal(service.getApplicationLocale(), null);
  assert.equal(service.saveApplicationLocale('ar'), 'ar');
  assert.equal(service.getApplicationLocale(), 'ar');
  assert.throws(() => service.saveApplicationLocale('fr'), /supported application language/i);
});

test('approved purchase, funding, payment, receipt, pricing, sale, and return remain balanced and auditable', async t => {
  const service = await createService(t);
  const { supplierId, productId } = seedActorsAndCatalog(service);
  const date = '2026-08-08';

  assert.throws(() => service.createPurchase({
    supplierId, currencyId: 1, warehouseId: 1, exchangeRate: 1, invoiceDate: date,
    lines: [{ productId, unitId: 1, unitQuantity: 1, quantity: 1, unitPrice: 50 }]
  }, [], 'purchaser'), /finance-approved purchase order/i);

  const order = service.savePurchaseOrder(null, {
    supplierId, currencyId: 1, warehouseId: 1, exchangeRate: 1, orderDate: date,
    lines: [{ productId, unitId: 1, unitQuantity: 1, quantity: 10, unitPrice: 50 }]
  }, 'purchaser');
  service.setPurchaseOrderStatus(order.id, 'SUBMIT', 'purchaser');
  assert.equal(service.getPurchaseOrder(order.id).approval_state, 'PENDING_COMMERCIAL');
  assert.throws(() => service.setPurchaseOrderStatus(order.id, 'FINANCE_APPROVE', 'finance'), /not allowed/i);
  assert.throws(() => service.setPurchaseOrderStatus(order.id, 'COMMERCIAL_APPROVE', 'purchaser'), /requester cannot approve/i);
  const commerciallyApproved = service.setPurchaseOrderStatus(order.id, 'COMMERCIAL_APPROVE', 'commercial', 'Commercially approved');
  assert.equal(commerciallyApproved.approval_state, 'PENDING_FINANCE');
  assert.equal(commerciallyApproved.status, 'DRAFT');
  assert.throws(() => service.createPurchase({
    purchaseOrderId: order.id, supplierId, currencyId: 1, warehouseId: 1, exchangeRate: 1, invoiceDate: date,
    lines: [{ purchaseOrderLineId: order.lines[0].id, productId, unitId: 1, unitQuantity: 1, quantity: 1, unitPrice: 50 }]
  }, [], 'purchaser'), /final Financial approval/i);
  assert.throws(() => service.setPurchaseOrderStatus(order.id, 'FINANCE_APPROVE', 'commercial'), /Commercial approver cannot/i);
  const approvedOrder = service.setPurchaseOrderStatus(order.id, 'FINANCE_APPROVE', 'finance', 'Budget approved');
  assert.equal(approvedOrder.approval_state, 'FINANCE_APPROVED');
  assert.equal(approvedOrder.status, 'OPEN');
  assert.ok(approvedOrder.accounting_handoff_at);
  assert.equal(service.listPurchaseOrders('accounting').length, 1);
  assert.deepEqual(approvedOrder.approvalHistory.map(row => row.action), [
    'SUBMITTED_TO_COMMERCIAL', 'COMMERCIAL_APPROVED', 'ROUTED_TO_FINANCE', 'FINANCE_APPROVED', 'HANDED_TO_ACCOUNTING'
  ]);
  const poPdf = buildPurchaseOrderHtml(approvedOrder, { username: 'finance' }, { businessName: 'Test Company' }, 'en');
  assert.match(poPdf, /Commercial approval/); assert.match(poPdf, /Financial approval/); assert.match(poPdf, /Accounting handoff/);

  const orderLine = approvedOrder.lines[0];
  const purchase = service.createPurchase({
    purchaseOrderId: order.id, supplierId, currencyId: 1, warehouseId: 1, exchangeRate: 1,
    invoiceDate: date, supplierInvoiceNumber: 'VENDOR-001',
    lines: [{ purchaseOrderLineId: orderLine.id, productId, unitId: 1, unitQuantity: 1, quantity: 10, unitPrice: 50 }]
  }, [], 'purchaser');
  assert.equal(purchase.workflow_state, 'DRAFT');
  service.submitPurchaseInvoice(purchase.id, 'purchaser');
  const funding = service.listPurchaseFunding()[0];
  assert.throws(() => service.decidePurchaseFunding(funding.id, 'AUTHORIZE', '', 'purchaser'), /requester cannot authorize/i);
  service.decidePurchaseFunding(funding.id, 'AUTHORIZE', 'Funds available', 'finance');
  assert.throws(() => service.executeSupplierPayment(funding.id, { amount: 500, paymentMethodId: 1, entryDate: date }, 'treasury'), /disbursement order/i);
  const advanceOrder = service.createPurchaseDisbursement(funding.id, { amount: 200, paymentMode: 'PURCHASING_ADVANCE' }, 'accountant');
  assert.equal(advanceOrder.status, 'PENDING_TREASURY');
  assert.throws(() => service.executeSupplierPayment(advanceOrder.id, { amount: 200, paymentMethodId: 1, entryDate: date }, 'accountant'), /issued the order cannot execute/i);
  const advance = service.executeSupplierPayment(advanceOrder.id, { amount: 200, paymentMethodId: 1, entryDate: date }, 'treasury');
  assert.equal(advance.paymentMode, 'PURCHASING_ADVANCE');
  assert.equal(advance.recipientUserId, 'purchaser');
  assert.equal(advance.fullyPaid, false);
  const supplierOrder = service.createPurchaseDisbursement(funding.id, { amount: 300, paymentMode: 'SUPPLIER' }, 'accountant');
  assert.throws(() => service.executeSupplierPayment(supplierOrder.id, { amount: 301, paymentMethodId: 1, entryDate: date }, 'treasury'), /exceeds the Accountant/i);
  const payment = service.executeSupplierPayment(supplierOrder.id, { amount: 300, paymentMethodId: 1, entryDate: date }, 'treasury');
  assert.equal(payment.fullyPaid, true);
  assert.equal(service.getPurchaseDisbursement(supplierOrder.id).payment_account_name, 'Cash');
  assert.throws(() => service.createCashVoucher('payment', { entryDate: date, description: 'Bypass purchase approval',
    paymentMethodId: 1, currencyId: 1, exchangeRateToBase: 1, amount: 1, accountId: 2100, supplierId }, [], 'treasury'),
  /disbursement order/i);

  const queueLine = service.listGoodsReceiptQueue()[0];
  assert.ok(queueLine);
  assert.equal(Object.hasOwn(queueLine, 'unit_price'), false, 'warehouse queue must not expose price');
  const receipt = service.confirmGoodsReceipt({
    purchaseInvoiceId: purchase.id, receiptDate: date,
    lines: [{ purchaseInvoiceLineId: queueLine.purchase_invoice_line_id, acceptedQuantity: 9, damagedQuantity: 1, rejectedQuantity: 0 }]
  }, 'warehouse');
  assert.equal(receipt.complete, true);
  assert.equal(receipt.workflow, 'SETTLED');
  assert.equal(Number(service.all("SELECT balance FROM account_balances WHERE code = '1250'")[0].balance), 0, 'purchasing advance must clear on receipt');
  assert.equal(Number(service.all("SELECT quantity FROM inventory_balances WHERE product_id = ? AND status = 'AVAILABLE'", [productId])[0].quantity), 9);
  assert.equal(Number(service.all("SELECT quantity FROM inventory_balances WHERE product_id = ? AND status = 'DAMAGED'", [productId])[0].quantity), 1);

  const price = service.publishProductPrice({ productId, warehouseId: 1, pricingMethod: 'MARKUP', markupPercent: 40, effectiveFrom: date }, 'pricing');
  assert.equal(Number(price.published_price), 70);
  assert.equal(service.getSalesSetup().products[0].average_unit_cost_base, 50);
  assert.throws(() => service.createSale({
    invoiceDate: date, paymentMethodId: 1, currencyId: 1, warehouseId: 1, exchangeRate: 1, status: 'COMPLETED',
    lines: [{ productId, quantity: 1, unitPrice: 69 }]
  }, [], 'cashier'), /PRICE_BELOW_FLOOR/);

  assert.throws(() => service.createSale({
    invoiceDate: date, paymentMethodId: 1, currencyId: 1, warehouseId: 1, exchangeRate: 1,
    lines: [{ productId, quantity: 1, unitPrice: 75 }]
  }, [], 'cashier'), /Permission is required to increase/i);
  const increasedPriceDraft = service.createSale({
    invoiceDate: date, paymentMethodId: 1, currencyId: 1, warehouseId: 1, exchangeRate: 1,
    allowPriceIncrease: true, lines: [{ productId, quantity: 1, unitPrice: 75 }]
  }, [], 'cashier');
  assert.equal(Number(increasedPriceDraft.lines[0].unit_price), 75);
  assert.equal(service.deleteSale(increasedPriceDraft.id, 'cashier'), true);

  const draftInput = { invoiceDate: date, paymentMethodId: 1, currencyId: 1, warehouseId: 1, exchangeRate: 1, status: 'DRAFT',
    lines: [{ productId, quantity: 1, unitPrice: 70 }] };
  const draft = service.createSale(draftInput, [], 'cashier');
  assert.throws(() => service.updateSale(draft.id, draftInput, [], 'purchaser'), /only edit your own/i);
  assert.throws(() => service.deleteSale(draft.id, 'purchaser'), /only delete your own/i);
  assert.equal(service.deleteSale(draft.id, 'cashier'), true);

  const sale = service.createSale({
    invoiceDate: date, paymentMethodId: 1, currencyId: 1, warehouseId: 1, exchangeRate: 1, status: 'COMPLETED',
    lines: [{ productId, quantity: 2, unitPrice: 70 }]
  }, [], 'cashier');
  assert.equal(sale.status, 'COMPLETED');
  assert.throws(() => service.updateSale(sale.id, {}, [], 'cashier'), /immutable/i);
  assert.throws(() => service.deleteSale(sale.id, 'cashier'), /immutable/i);
  assert.equal(service.listSales('cashier').length, 1);
  assert.equal(service.listSales('purchaser').length, 0);

  const salesLine = sale.lines[0];
  const salesReturn = service.createSalesReturn({
    salesInvoiceId: sale.id, returnDate: date, reason: 'Customer return',
    lines: [{ salesInvoiceLineId: salesLine.id, quantity: 1, restockStatus: 'AVAILABLE' }]
  }, 'cashier');
  service.decideSalesReturn(salesReturn.id, 'COMMERCIAL_APPROVE', '', 'commercial');
  service.decideSalesReturn(salesReturn.id, 'FINANCE_APPROVE', '', 'finance');
  assert.throws(() => service.settleSalesReturn(salesReturn.id, 1, 'finance'), /approver cannot execute/i);
  const refund = service.settleSalesReturn(salesReturn.id, 1, 'accountant');
  assert.equal(refund.refundTransaction, 70);
  assert.equal(service.listSalesReturns()[0].status, 'REFUNDED');
  assert.equal(Number(service.all("SELECT quantity FROM inventory_balances WHERE product_id = ? AND status = 'AVAILABLE'", [productId])[0].quantity), 8);

  const unbalanced = service.all("SELECT journal_entry_id FROM journal_entry_balances WHERE status = 'POSTED' AND abs(difference) > 0.0001");
  assert.deepEqual(unbalanced, []);
  assert.deepEqual(service.all('PRAGMA foreign_key_check'), []);
  assert.ok(Number(service.all('SELECT count(*) AS total FROM audit_events')[0].total) >= 7);
  const workflow = service.buildOperationalWorkflow(date, date);
  assert.ok(workflow.rows.some(row => row.entity === 'Purchase Order' && row.status === 'FINANCE_APPROVED' && row.stage === 'Accounting handoff'));
  assert.ok(workflow.rows.some(row => row.entity === 'Goods Receipt' && row.status === 'CONFIRMED'));
  assert.ok(workflow.rows.some(row => row.entity === 'Sales Return' && row.status === 'REFUNDED'));
});

test('salary grades and payroll require submission, independent approval, and independent payment', async t => {
  const service = await createService(t);
  seedActorsAndCatalog(service);
  service.run(`INSERT INTO accounts(id, code, name, account_type, normal_balance, parent_id, is_control)
    VALUES (6250, '6250', 'Salaries & Wages Expense', 'EXPENSE', 'DEBIT', 6000, 0)`);
  const grade = service.saveSalaryGrade({ code: 'G1', name: 'Grade One', minimumSalary: 1000, maximumSalary: 3000, defaultBaseSalary: 2000 })[0];
  assert.throws(() => service.saveEmployee({
    fullName: 'Out of Range', employmentType: 'full_time', hireDate: '2026-01-01',
    baseSalary: 4000, salaryGradeId: grade.id, components: []
  }), /grade range/i);
  const employeeId = service.saveEmployee({
    fullName: 'Payroll Employee', employmentType: 'full_time', hireDate: '2026-01-01',
    baseSalary: 2000, salaryGradeId: grade.id, components: []
  });
  const employee = service.all('SELECT * FROM employees WHERE id = ?', [employeeId])[0];
  assert.equal(Number(employee.salary_grade_id), Number(grade.id));
  const run = service.createPayrollRun({ periodMonth: 8, periodYear: 2026 }, 'payroll');
  assert.throws(() => service.postPayrollRun(run.id, 1, 'accountant'), /finance-approved/i);
  const submitted = service.finalizePayrollRun(run.id);
  assert.equal(submitted.workflow_state, 'SUBMITTED');
  const approved = service.decidePayrollRun(run.id, 'APPROVE', 'Approved', 'finance');
  assert.equal(approved.workflow_state, 'APPROVED');
  assert.throws(() => service.postPayrollRun(run.id, 1, 'finance'), /approver cannot execute/i);
  const paid = service.postPayrollRun(run.id, 1, 'accountant');
  assert.equal(paid.workflow_state, 'PAID');
  assert.equal(paid.status, 'posted');
  assert.throws(() => service.savePayrollRun(run.id, { items: [] }), /locked/i);
  assert.deepEqual(service.all("SELECT journal_entry_id FROM journal_entry_balances WHERE status = 'POSTED' AND abs(difference) > 0.0001"), []);
  assert.deepEqual(service.all('PRAGMA foreign_key_check'), []);
});

test('purchase-order rejections return to Procurement and resubmission restarts Commercial approval', async t => {
  const service = await createService(t);
  const { supplierId, productId } = seedActorsAndCatalog(service);
  const input = {
    supplierId, currencyId: 1, warehouseId: 1, exchangeRate: 1, orderDate: '2026-08-08',
    lines: [{ productId, unitId: 1, unitQuantity: 1, quantity: 2, unitPrice: 25 }]
  };
  const order = service.savePurchaseOrder(null, input, 'purchaser');
  service.setPurchaseOrderStatus(order.id, 'SUBMIT', 'purchaser');
  assert.throws(() => service.setPurchaseOrderStatus(order.id, 'COMMERCIAL_REJECT', 'commercial', ''), /rejection reason/i);
  const commercialRejected = service.setPurchaseOrderStatus(order.id, 'COMMERCIAL_REJECT', 'commercial', 'Revise supplier terms');
  assert.equal(commercialRejected.approval_state, 'COMMERCIAL_REJECTED');
  service.savePurchaseOrder(order.id, { ...input, notes: 'Revised terms' }, 'purchaser');
  service.setPurchaseOrderStatus(order.id, 'SUBMIT', 'purchaser');
  service.setPurchaseOrderStatus(order.id, 'COMMERCIAL_APPROVE', 'commercial', 'Terms accepted');
  assert.throws(() => service.setPurchaseOrderStatus(order.id, 'FINANCE_REJECT', 'finance', ''), /rejection reason/i);
  const financeRejected = service.setPurchaseOrderStatus(order.id, 'FINANCE_REJECT', 'finance', 'Budget correction required');
  assert.equal(financeRejected.approval_state, 'FINANCE_REJECTED');
  service.savePurchaseOrder(order.id, { ...input, notes: 'Budget corrected' }, 'purchaser');
  const resubmitted = service.setPurchaseOrderStatus(order.id, 'SUBMIT', 'purchaser');
  assert.equal(resubmitted.approval_state, 'PENDING_COMMERCIAL');
  assert.equal(resubmitted.commercial_approved_by, null);
  assert.equal(resubmitted.financial_approved_by, null);
  assert.equal(resubmitted.accounting_handoff_at, null);
  assert.equal(resubmitted.approvalHistory.filter(row => row.action === 'SUBMITTED_TO_COMMERCIAL').length, 3);
  assert.deepEqual(service.all('PRAGMA foreign_key_check'), []);
});

test('role templates isolate sensitive capabilities and passwords are hashed', async t => {
  const service = await createService(t);
  assert.equal(service.all('PRAGMA user_version')[0].user_version, 12);
  assert.throws(() => service.addUser({
    id: 'weak', username: 'weak', password: 'short', role: 'Staff', jobProfile: 'Staff',
    permissions: { dashboard: 'view' }
  }), /at least 8 characters/i);

  service.addUser({
    id: 'warehouse-user', username: 'warehouse-user', password: 'StrongPass123', role: 'Manager',
    jobProfile: 'Warehouse Manager', permissions: { dashboard: 'view', inventory: 'manage' }
  });
  const stored = service.all("SELECT password, password_hash FROM users WHERE id = 'warehouse-user'")[0];
  assert.equal(stored.password, '');
  assert.match(stored.password_hash, /^scrypt\$/);
  const warehouse = service.authenticate('warehouse-user', 'StrongPass123');
  assert.ok(warehouse.capabilities.includes('goods_receipt_confirm'));
  assert.ok(warehouse.capabilities.includes('stock_quantity_view'));
  assert.equal(warehouse.capabilities.includes('pricing_cost_view'), false);
  assert.equal(warehouse.capabilities.includes('purchase_funding_approve'), false);

  const capabilities = profile => service.applyRoleProfile({ id: `unused-${profile}`, username: profile,
    role: 'Manager', job_profile: profile }).capabilities;
  assert.ok(capabilities('Pricing Manager').includes('pricing_cost_view'));
  assert.ok(capabilities('Procurement Manager').includes('purchase_order_submit'));
  assert.ok(capabilities('Procurement Manager').includes('supplier_manage'));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8'), /data-supplier-target="purchaseOrderSupplier"/);
  assert.ok(capabilities('Financial Manager').includes('purchase_order_finance_approve'));
  assert.equal(capabilities('Financial Manager').includes('purchase_order_commercial_approve'), false);
  assert.ok(capabilities('Financial Manager').includes('purchase_funding_approve'));
  assert.equal(capabilities('Financial Manager').includes('purchase_disbursement_create'), false);
  assert.ok(capabilities('Accountant').includes('purchase_disbursement_create'));
  assert.equal(capabilities('Accountant').includes('purchase_disbursement_execute'), false);
  assert.ok(capabilities('Treasury Manager').includes('purchase_disbursement_execute'));
  const commercial = capabilities('Commercial Manager');
  assert.ok(commercial.includes('stock_quantity_view'));
  assert.ok(commercial.includes('pricing_cost_view'));
  assert.ok(commercial.includes('pricing_publish'));
  assert.ok(commercial.includes('purchase_order_view'));
  assert.ok(commercial.includes('purchase_invoice_view'));
  assert.ok(commercial.includes('purchase_order_commercial_approve'));
  assert.equal(commercial.includes('purchase_order_finance_approve'), false);
  assert.ok(commercial.includes('sales_return_approve'));
  assert.equal(commercial.includes('financial_reports_view'), false);
  assert.equal(commercial.includes('purchase_funding_approve'), false);
  assert.equal(commercial.includes('supplier_payment_execute'), false);
  assert.equal(commercial.includes('payroll_approve'), false);
  assert.ok(capabilities('General Manager').includes('financial_reports_view'));
  assert.ok(capabilities('Sales / Cashier').includes('sale_price_increase'));
  assert.ok(capabilities('Accountant').includes('purchase_order_accounting_view'));

  assert.ok(service.authenticate('admin', '1234'));
  const migratedAdmin = service.all("SELECT password, password_hash FROM users WHERE id = 'admin'")[0];
  assert.equal(migratedAdmin.password, '');
  assert.match(migratedAdmin.password_hash, /^scrypt\$/);
});

test('schema v10 purchase orders migrate without losing final approval or foreign keys', async t => {
  const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const legacy = new SQL.Database(); legacy.run('PRAGMA foreign_keys = ON');
  legacy.exec(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
  legacy.run('PRAGMA foreign_keys = OFF');
  legacy.run('DROP TABLE purchase_order_approval_history'); legacy.run('DROP TABLE purchase_orders');
  legacy.run(`CREATE TABLE purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, po_number TEXT NOT NULL UNIQUE,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id), order_date TEXT NOT NULL, expected_delivery_date TEXT,
    currency_id INTEGER NOT NULL REFERENCES currencies(id), exchange_rate_to_base REAL NOT NULL DEFAULT 1,
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id), supplier_reference TEXT, notes TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT', created_by TEXT REFERENCES users(id),
    approval_state TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (approval_state IN ('NOT_SUBMITTED','PENDING','APPROVED','REJECTED')),
    submitted_by TEXT REFERENCES users(id), submitted_at TEXT, approved_by TEXT REFERENCES users(id),
    approved_at TEXT, approval_comment TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  legacy.run(`CREATE TABLE purchase_order_approval_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN ('SUBMITTED','APPROVED','REJECTED','RECALLED')), comment TEXT,
    acted_by TEXT NOT NULL REFERENCES users(id), acted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  legacy.run("INSERT INTO suppliers(code, name) VALUES ('SUP-LEGACY', 'Legacy Supplier')");
  legacy.run(`INSERT INTO purchase_orders(po_number, supplier_id, order_date, currency_id, warehouse_id, status, created_by,
    approval_state, submitted_by, submitted_at, approved_by, approved_at, approval_comment)
    VALUES ('PO-LEGACY-001', 1, '2026-08-01', 1, 1, 'OPEN', 'admin', 'APPROVED', 'admin',
      '2026-08-01 08:00:00', 'admin', '2026-08-01 09:00:00', 'Legacy approval')`);
  legacy.run("INSERT INTO purchase_order_approval_history(purchase_order_id, action, acted_by) VALUES (1, 'SUBMITTED', 'admin')");
  legacy.run("INSERT INTO purchase_order_approval_history(purchase_order_id, action, comment, acted_by) VALUES (1, 'APPROVED', 'Legacy approval', 'admin')");
  legacy.run('PRAGMA user_version = 10');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holool-v10-migration-'));
  fs.writeFileSync(path.join(tempDir, 'holool.sqlite'), Buffer.from(legacy.export())); legacy.close();
  const service = await initializeDatabase({ isPackaged: true, userDataPath: tempDir });
  t.after(() => { service.database.close(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const migrated = service.getPurchaseOrder(1);
  assert.equal(service.all('PRAGMA user_version')[0].user_version, 12);
  assert.equal(migrated.approval_state, 'FINANCE_APPROVED');
  assert.equal(migrated.financial_approved_by, 'admin');
  assert.equal(migrated.financial_approval_comment, 'Legacy approval');
  assert.ok(migrated.accounting_handoff_at);
  assert.ok(migrated.approvalHistory.some(row => row.action === 'LEGACY_MIGRATED'));
  assert.equal(service.listPurchaseOrders('accounting').length, 1);
  assert.deepEqual(service.all('PRAGMA foreign_key_check'), []);
});
