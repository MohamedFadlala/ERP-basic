'use strict';

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateInternalEan13 } = require('./barcode');

const INVENTORY_STATUSES = Object.freeze(['AVAILABLE', 'RESERVED', 'DAMAGED', 'SALVAGE', 'DISPOSED']);
const STATUS_TRANSITIONS = Object.freeze({
  MARK_DAMAGED: { from: 'AVAILABLE', to: 'DAMAGED', prefix: 'DMG' },
  MOVE_TO_SALVAGE: { from: 'DAMAGED', to: 'SALVAGE', prefix: 'SLV' },
  REPAIR: { from: 'DAMAGED', to: 'AVAILABLE', prefix: 'RPR' },
  DISPOSE_DAMAGED: { from: 'DAMAGED', to: 'DISPOSED', prefix: 'DSP' },
  DISPOSE_SALVAGE: { from: 'SALVAGE', to: 'DISPOSED', prefix: 'DSP' },
  RESERVE: { from: 'AVAILABLE', to: 'RESERVED', prefix: 'RSV' },
  RELEASE_RESERVE: { from: 'RESERVED', to: 'AVAILABLE', prefix: 'REL' }
});
const RBAC_SCREENS = new Set(['dashboard', 'sales', 'inventory', 'treasury', 'journalAccount', 'accounting', 'hr', 'reports']);
const RBAC_CAPABILITIES = new Set([
  'purchase_order_submit', 'purchase_order_commercial_approve', 'purchase_order_commercial_reject',
  'purchase_order_finance_approve', 'purchase_order_finance_reject', 'purchase_order_accounting_view',
  'treasury_receipt_post', 'treasury_payment_post', 'supplier_view', 'supplier_manage', 'product_create',
  'purchase_order_view', 'purchase_order_create', 'purchase_order_edit',
  'purchase_invoice_view', 'purchase_invoice_create', 'purchase_invoice_edit', 'purchase_invoice_submit',
  'purchase_cost_manage', 'purchase_attachment_manage', 'purchase_funding_view', 'purchase_funding_approve',
  'purchase_funding_reject', 'purchase_disbursement_view', 'purchase_disbursement_create',
  'purchase_disbursement_cancel', 'purchase_disbursement_execute', 'supplier_payment_execute', 'supplier_payment_void', 'stock_quantity_view',
  'stock_cost_view', 'goods_receipt_view', 'goods_receipt_confirm', 'goods_receipt_reject', 'inventory_transfer',
  'inventory_adjust', 'inventory_dispose', 'pricing_cost_view', 'pricing_view', 'pricing_create', 'pricing_publish',
  'pricing_override', 'sale_create', 'sale_hold', 'sale_view_own', 'sale_view_all', 'sale_reprint',
  'sale_price_increase', 'sales_return_create', 'sales_return_approve', 'sales_return_settle', 'journal_view',
  'journal_create', 'journal_post', 'accounting_tree_view', 'accounting_tree_manage', 'employee_manage',
  'payroll_prepare', 'payroll_submit', 'payroll_approve', 'payroll_payment_execute', 'financial_reports_view',
  'operational_reports_view', 'sensitive_cost_reports_view', 'hr_reports_view'
]);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$16384$8$1$${salt}$${digest}`;
}

function verifyPassword(password, encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, expected] = parts;
  const actual = crypto.scryptSync(String(password), salt, Buffer.from(expected, 'hex').length,
    { N: Number(n), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

class DatabaseService {
  constructor(database, filePath) { this.database = database; this.filePath = filePath; }

  all(sql, parameters = []) {
    const statement = this.database.prepare(sql);
    try {
      statement.bind(parameters);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally { statement.free(); }
  }

  run(sql, parameters = [], persist = true) {
    this.database.run(sql, parameters);
    if (persist) this.persist();
  }

  transaction(work) {
    this.database.run('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.run('COMMIT');
      this.persist();
      return result;
    } catch (error) {
      this.database.run('ROLLBACK');
      throw error;
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, Buffer.from(this.database.export()));
  }

  applyRoleProfile(user) {
    const profile = this.all(`SELECT profile_key FROM role_profiles WHERE display_name = ? COLLATE NOCASE AND is_active = 1 LIMIT 1`,
      [String(user.job_profile || '')])[0];
    const templatePermissions = profile ? Object.fromEntries(this.all(
      'SELECT screen_key, access_level FROM role_profile_permissions WHERE profile_key = ?', [profile.profile_key]
    ).map(row => [row.screen_key, row.access_level])) : {};
    const explicitPermissions = Object.fromEntries(this.all(
      'SELECT screen_key, access_level FROM user_permissions WHERE user_id = ?', [user.id]
    ).map(row => [row.screen_key, row.access_level]));
    const templateCapabilities = profile ? this.all(
      'SELECT capability_key FROM role_profile_capabilities WHERE profile_key = ?', [profile.profile_key]
    ).map(row => row.capability_key) : [];
    const explicitCapabilities = this.all('SELECT capability_key FROM user_capabilities WHERE user_id = ?', [user.id])
      .map(row => row.capability_key);
    user.permissions = { ...templatePermissions, ...explicitPermissions };
    user.capabilities = [...new Set([...templateCapabilities, ...explicitCapabilities])];
    return user;
  }

  authenticate(username, password) {
    const record = this.all(`SELECT id, username, role, job_profile, password, password_hash FROM users
      WHERE username = ? COLLATE NOCASE AND is_active = 1 LIMIT 1`, [username])[0] || null;
    if (!record) return null;
    const valid = record.password_hash ? verifyPassword(password, record.password_hash) : record.password === password;
    if (!valid) return null;
    if (!record.password_hash) {
      this.database.run("UPDATE users SET password_hash = ?, password = '' WHERE id = ?", [hashPassword(password), record.id]);
      this.persist();
    }
    const user = { id: record.id, username: record.username, role: record.role, job_profile: record.job_profile };
    if (!user) return null;
    return this.applyRoleProfile(user);
  }

  listUsers() {
    return this.all('SELECT id, username, role, job_profile FROM users WHERE is_active = 1 ORDER BY username COLLATE NOCASE')
      .map(user => this.applyRoleProfile(user));
  }

  addUser(user) {
    if (String(user.password || '').length < 8) throw new Error('Passwords must contain at least 8 characters.');
    const permissions = Object.entries(user.permissions || {}).filter(
      ([screen, level]) => RBAC_SCREENS.has(screen) && ['view', 'manage'].includes(level)
    );
    const capabilities = [...new Set(Array.isArray(user.capabilities) ? user.capabilities : [])]
      .filter(capability => RBAC_CAPABILITIES.has(capability));
    if (user.role !== 'System Administrator' && !permissions.length) throw new Error('Select access to at least one screen.');
    this.transaction(() => {
      this.database.run("INSERT INTO users(id, username, password, password_hash, role, job_profile, is_active) VALUES (?, ?, '', ?, ?, ?, 1)",
        [user.id, user.username, hashPassword(user.password), user.role, String(user.jobProfile || 'Staff')]);
      for (const [screen, level] of permissions) {
        this.database.run('INSERT INTO user_permissions(user_id, screen_key, access_level) VALUES (?, ?, ?)', [user.id, screen, level]);
      }
      for (const capability of capabilities) this.database.run(
        'INSERT INTO user_capabilities(user_id, capability_key) VALUES (?, ?)', [user.id, capability]);
    });
    return this.listUsers();
  }

  updateUser(userId, input) {
    const id = String(userId || '');
    const current = this.all('SELECT id, username, role FROM users WHERE id = ? AND is_active = 1', [id])[0];
    if (!current) throw new Error('User was not found.');
    if (id === 'admin' && input.role !== 'System Administrator') throw new Error('The default administrator must remain an administrator.');
    if (String(input.password || '') && String(input.password).length < 8) throw new Error('Passwords must contain at least 8 characters.');
    const permissions = Object.entries(input.permissions || {}).filter(
      ([screen, level]) => RBAC_SCREENS.has(screen) && ['view', 'manage'].includes(level));
    const capabilities = [...new Set(Array.isArray(input.capabilities) ? input.capabilities : [])]
      .filter(capability => RBAC_CAPABILITIES.has(capability));
    if (input.role !== 'System Administrator' && !permissions.length) throw new Error('Select access to at least one screen.');
    this.transaction(() => {
      const replacementHash = String(input.password || '') ? hashPassword(input.password) : null;
      this.database.run(`UPDATE users SET username = ?, role = ?, job_profile = ?,
        password_hash = coalesce(?, password_hash), password = CASE WHEN ? IS NULL THEN password ELSE '' END WHERE id = ?`,
      [String(input.username || '').trim(), input.role, String(input.jobProfile || 'Staff'), replacementHash, replacementHash, id]);
      this.database.run('DELETE FROM user_permissions WHERE user_id = ?', [id]);
      this.database.run('DELETE FROM user_capabilities WHERE user_id = ?', [id]);
      if (input.role !== 'System Administrator') {
        for (const [screen, level] of permissions) this.database.run(
          'INSERT INTO user_permissions(user_id, screen_key, access_level) VALUES (?, ?, ?)', [id, screen, level]);
        for (const capability of capabilities) this.database.run(
          'INSERT INTO user_capabilities(user_id, capability_key) VALUES (?, ?)', [id, capability]);
      }
    });
    return this.listUsers();
  }

  deactivateUser(userId) {
    this.run(`UPDATE users SET is_active = 0 WHERE id = ? AND username <> 'admin' COLLATE NOCASE`, [userId]);
    return this.listUsers();
  }

  getBusinessBranding() {
    const settings = Object.fromEntries(this.all(
      "SELECT key, value FROM app_settings WHERE key IN ('business_name', 'business_logo', 'business_address', 'business_phone', 'business_phone_secondary', 'business_email')"
    ).map(row => [row.key, row.value]));
    return { businessName: settings.business_name || 'Holool ERP Enterprise', logoDataUrl: settings.business_logo || '',
      address: settings.business_address || '', phone: settings.business_phone || '',
      secondaryPhone: settings.business_phone_secondary || '', email: settings.business_email || '' };
  }

  saveBusinessBranding(input) {
    const businessName = String(input?.businessName || '').trim();
    const logoDataUrl = String(input?.logoDataUrl || '');
    const address = String(input?.address || '').trim(); const phone = String(input?.phone || '').trim();
    const secondaryPhone = String(input?.secondaryPhone || '').trim(); const email = String(input?.email || '').trim();
    if (!businessName) throw new Error('Business name is required.');
    if (businessName.length > 120) throw new Error('Business name cannot exceed 120 characters.');
    if (logoDataUrl && !/^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(logoDataUrl)) {
      throw new Error('Choose a PNG, JPEG, or WebP logo.');
    }
    if (logoDataUrl.length > 2800000) throw new Error('The logo must be 2 MB or smaller.');
    this.transaction(() => {
      this.database.run(`INSERT INTO app_settings(key, value) VALUES ('business_name', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [businessName]);
      this.database.run(`INSERT INTO app_settings(key, value) VALUES ('business_logo', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [logoDataUrl]);
      for (const [key, value] of [['business_address', address], ['business_phone', phone],
        ['business_phone_secondary', secondaryPhone], ['business_email', email]]) {
        this.database.run(`INSERT INTO app_settings(key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
      }
    });
    return this.getBusinessBranding();
  }

  accountAllowsCurrency(accountId, currencyId) {
    const configured = this.all('SELECT currency_id FROM account_currencies WHERE account_id = ?', [Number(accountId)]);
    return !configured.length || configured.some(row => Number(row.currency_id) === Number(currencyId));
  }

  validateAccountCurrency(accountId, currencyId, label = 'account') {
    if (!this.accountAllowsCurrency(accountId, currencyId)) {
      const currency = this.all('SELECT code FROM currencies WHERE id = ?', [Number(currencyId)])[0];
      throw new Error(`The selected ${label} does not allow ${currency?.code || 'this currency'}.`);
    }
  }

  saveAccount(input) {
    const id = Number(input?.id) || null;
    const code = String(input?.code || '').trim(); const name = String(input?.name || '').trim();
    const accountType = String(input?.accountType || '').toUpperCase();
    const parentId = Number(input?.parentId) || null; const isControl = input?.isControl ? 1 : 0;
    const bankFeeAccountId = Number(input?.bankFeeAccountId) || null;
    const currencyIds = [...new Set((Array.isArray(input?.currencyIds) ? input.currencyIds : []).map(Number).filter(Boolean))];
    if (!code || !name) throw new Error('Account code and name are required.');
    if (!['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'].includes(accountType)) throw new Error('Select a valid account type.');
    if (!currencyIds.length) throw new Error('Select at least one account currency.');
    if (id && parentId === id) throw new Error('An account cannot be its own parent.');
    const normalBalance = ['ASSET', 'EXPENSE'].includes(accountType) ? 'DEBIT' : 'CREDIT';
    return this.transaction(() => {
      for (const currencyId of currencyIds) if (!this.all('SELECT id FROM currencies WHERE id = ? AND is_active = 1', [currencyId])[0]) throw new Error('One selected currency is invalid.');
      if (parentId && !this.all('SELECT id FROM accounts WHERE id = ? AND is_active = 1', [parentId])[0]) throw new Error('Select a valid parent account.');
      if (input?.isBank && !this.all(`SELECT id FROM accounts
          WHERE id = ? AND account_type = 'EXPENSE' AND is_control = 0 AND is_active = 1`, [bankFeeAccountId])[0]) {
        throw new Error("Select a posting expense account for this bank fee.");
      }
      if (id && parentId && this.all(`WITH RECURSIVE descendants(id) AS (
          SELECT id FROM accounts WHERE parent_id = ? UNION ALL
          SELECT a.id FROM accounts a JOIN descendants d ON a.parent_id = d.id)
        SELECT id FROM descendants WHERE id = ?`, [id, parentId])[0]) throw new Error('An account cannot be moved under one of its descendants.');
      let accountId = id;
      if (id) {
        if (!this.all('SELECT id FROM accounts WHERE id = ?', [id])[0]) throw new Error('Account was not found.');
        this.database.run(`UPDATE accounts SET code = ?, name = ?, account_type = ?, normal_balance = ?, parent_id = ?, is_control = ?, description = ?, is_active = 1 WHERE id = ?`,
          [code, name, accountType, normalBalance, parentId, isControl, String(input?.description || '').trim() || null, id]);
      } else {
        this.database.run(`INSERT INTO accounts(code, name, account_type, normal_balance, parent_id, is_control, description) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [code, name, accountType, normalBalance, parentId, isControl, String(input?.description || '').trim() || null]);
        accountId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      }
      this.database.run('DELETE FROM account_currencies WHERE account_id = ?', [accountId]);
      for (const currencyId of currencyIds) this.database.run('INSERT INTO account_currencies(account_id, currency_id) VALUES (?, ?)', [accountId, currencyId]);
      if (input?.isBank) {
        const payment = this.all("SELECT id FROM payment_methods WHERE account_id = ? AND method_type = 'BANK'", [accountId])[0];
        const paymentCode = String(input?.bankCode || code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
        if (payment) this.database.run('UPDATE payment_methods SET code = ?, name = ?, bank_fee_account_id = ?, is_active = 1 WHERE id = ?', [paymentCode, name, bankFeeAccountId, payment.id]);
        else this.database.run(`INSERT INTO payment_methods(code, name, method_type, account_id, bank_fee_account_id, is_active) VALUES (?, ?, 'BANK', ?, ?, 1)`, [paymentCode, name, accountId, bankFeeAccountId]);
      } else if (id) this.database.run("UPDATE payment_methods SET is_active = 0 WHERE account_id = ? AND method_type = 'BANK'", [id]);
      return accountId;
    });
  }

  normalizeAttachments(attachments = []) {
    if (!Array.isArray(attachments) || attachments.length > 10) throw new Error('Select no more than 10 attachments.');
    const allowed = new Set([
      'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel',
      'text/csv', 'text/plain', 'application/octet-stream'
    ]);
    const normalized = attachments.map(item => {
      const name = path.basename(String(item?.name || '')).slice(0, 255);
      const mimeType = String(item?.mimeType || '').toLowerCase(); const data = Buffer.from(item?.data || []);
      if (!name || !allowed.has(mimeType) || !data.length || data.length !== Number(item?.size)) throw new Error('One selected attachment is invalid.');
      if (mimeType === 'application/pdf' && data.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error(name + ' is not a valid PDF document.');
      if (data.length > 10 * 1024 * 1024) throw new Error(`${name} exceeds the 10 MB attachment limit.`);
      return { name, mimeType, data, size: data.length, checksum: crypto.createHash('sha256').update(data).digest('hex') };
    });
    if (normalized.reduce((sum, item) => sum + item.size, 0) > 25 * 1024 * 1024) throw new Error('Attachments cannot exceed 25 MB in total.');
    return normalized;
  }

  storeInvoiceAttachments(invoiceType, invoiceId, attachments, createdBy) {
    for (const item of this.normalizeAttachments(attachments)) this.database.run(`INSERT INTO invoice_attachments
      (invoice_type, invoice_id, original_name, mime_type, file_size, file_data, checksum_sha256, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [invoiceType, Number(invoiceId), item.name, item.mimeType, item.size, item.data, item.checksum, createdBy]);
  }

  storeJournalAttachments(journalId, attachments, createdBy) {
    for (const item of this.normalizeAttachments(attachments)) this.database.run(`INSERT INTO journal_attachments
      (journal_entry_id, original_name, mime_type, file_size, file_data, checksum_sha256, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [Number(journalId), item.name, item.mimeType, item.size, item.data, item.checksum, createdBy]);
  }
  listInvoiceAttachments(invoiceType, invoiceId) {
    return this.all(`SELECT id, original_name, mime_type, file_size, checksum_sha256, created_at
      FROM invoice_attachments WHERE invoice_type = ? AND invoice_id = ? ORDER BY id`, [invoiceType, Number(invoiceId)]);
  }

  getInvoiceAttachment(invoiceType, invoiceId, attachmentId) {
    return this.all(`SELECT id, invoice_type, invoice_id, original_name, mime_type, file_size, file_data, checksum_sha256
      FROM invoice_attachments WHERE invoice_type = ? AND invoice_id = ? AND id = ?`,
      [invoiceType, Number(invoiceId), Number(attachmentId)])[0] || null;
  }

  getPurchaseSetup() {
    return {
      suppliers: this.all(`SELECT id, code, name, phone_number, location, supplier_type, default_currency_id FROM suppliers WHERE is_active = 1 ORDER BY name COLLATE NOCASE`),
      products: this.all(`SELECT p.id, p.sku, p.barcode, p.name, p.category_id, p.default_unit_id, p.manual_sales_price,
          p.default_markup_percent, c.name AS category_name, u.name AS unit_name
        FROM products p JOIN item_categories c ON c.id = p.category_id JOIN units u ON u.id = p.default_unit_id
        WHERE p.is_active = 1 ORDER BY p.name COLLATE NOCASE`),
      currencies: this.all('SELECT id, code, name, symbol, is_base FROM currencies WHERE is_active = 1 ORDER BY is_base DESC, code'),
      units: this.all('SELECT id, code, name, unit_type FROM units WHERE is_active = 1 ORDER BY id'),
      categories: this.all(`SELECT id, name, parent_id FROM item_categories WHERE is_active = 1
        ORDER BY parent_id IS NOT NULL, name COLLATE NOCASE`),
      warehouses: this.all('SELECT id, code, name, location FROM warehouses WHERE is_active = 1 ORDER BY name COLLATE NOCASE'),
      costTypes: this.all('SELECT id, name FROM additional_cost_types WHERE is_active = 1 ORDER BY id')
    };
  }

  nextPartyCode(table, prefix) {
    if (!['suppliers', 'customers'].includes(table) || !['SUP', 'CUS'].includes(prefix)) throw new Error('Invalid party code type.');
    const sequence = Number(this.all(`SELECT coalesce(max(CAST(substr(code, 5) AS INTEGER)), 0) AS sequence FROM ${table}`)[0]?.sequence || 0);
    return `${prefix}-${String(sequence + 1).padStart(6, '0')}`;
  }
  addSupplier(input) {
    const name = String(input?.name || '').trim();
    if (!name) throw new Error('Supplier name is required.');
    const supplierType = input?.supplierType === 'INTERNATIONAL' ? 'INTERNATIONAL' : 'DOMESTIC';
    const code = this.nextPartyCode('suppliers', 'SUP');
    this.run(`INSERT INTO suppliers(code, name, phone_number, location, supplier_type, default_currency_id)
      VALUES (?, ?, ?, ?, ?, ?)`, [code, name, input?.phone || null, input?.location || null, supplierType, Number(input?.currencyId) || 1]);
    return this.getPurchaseSetup().suppliers;
  }

  addProduct(input, createdBy = null) {
    const name = String(input?.name || '').trim();
    if (!name) throw new Error('Product name is required.');
    const categoryId = Number(input?.categoryId);
    const category = categoryId ? this.all(
      'SELECT id, name, parent_id FROM item_categories WHERE id = ? AND is_active = 1', [categoryId]
    )[0] : null;
    if (!category || category.parent_id != null) throw new Error('Select a valid main category.');
    const unitId = Number(input?.unitId);
    if (!unitId || !this.all('SELECT id FROM units WHERE id = ? AND is_active = 1', [unitId])[0])
      throw new Error('Select a valid unit.');
    const manualPrice = input?.manualSalesPrice === '' || input?.manualSalesPrice == null ? null : Number(input.manualSalesPrice);
    const markup = input?.markupPercent === '' || input?.markupPercent == null ? null : Number(input.markupPercent);
    if (manualPrice != null && !(manualPrice >= 0)) throw new Error('Sales price cannot be negative.');
    if (markup != null && !(markup >= 0)) throw new Error('Markup cannot be negative.');
    this.transaction(() => {
      this.database.run(`INSERT INTO products(sku, name, category_id, default_unit_id, manual_sales_price, default_markup_percent)
        VALUES (?, ?, ?, ?, ?, ?)`, [String(input?.sku || '').trim() || null, name, categoryId,
        unitId, manualPrice, markup]);
      const productId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      this.database.run('UPDATE products SET barcode = ? WHERE id = ?', [this.availableProductBarcode(productId), productId]);
      this.audit(createdBy, 'CREATED', 'PRODUCT', productId, '', { name, categoryId, categoryName: category.name, unitId });
    });
    return this.getPurchaseSetup().products;
  }

  availableProductBarcode(productId) {
    for (let prefix = 20; prefix <= 29; prefix += 1) {
      const barcode = generateInternalEan13(productId, String(prefix));
      if (!this.all('SELECT id FROM products WHERE barcode = ? AND id <> ?', [barcode, Number(productId)])[0]) return barcode;
    }
    throw new Error('Unable to allocate a unique barcode for this product.');
  }

  updateProduct(productId, input) {
    const id = Number(productId);
    const product = this.all('SELECT id FROM products WHERE id = ?', [id])[0];
    if (!product) throw new Error('Product was not found.');
    const name = String(input?.name || '').trim();
    if (!name) throw new Error('Product name is required.');
    const categoryId = Number(input?.categoryId);
    if (!categoryId || !this.all('SELECT id FROM item_categories WHERE id = ? AND is_active = 1', [categoryId])[0])
      throw new Error('Select a valid category.');
    const unitId = Number(input?.unitId);
    if (!unitId || !this.all('SELECT id FROM units WHERE id = ? AND is_active = 1', [unitId])[0])
      throw new Error('Select a valid unit.');
    const manualPrice = input?.manualSalesPrice === '' || input?.manualSalesPrice == null ? null : Number(input.manualSalesPrice);
    const markup = input?.markupPercent === '' || input?.markupPercent == null ? null : Number(input.markupPercent);
    if (manualPrice != null && !(manualPrice >= 0)) throw new Error('Sales price cannot be negative.');
    if (markup != null && !(markup >= 0)) throw new Error('Markup cannot be negative.');
    this.run(`UPDATE products SET sku = ?, name = ?, category_id = ?, default_unit_id = ?,
      manual_sales_price = ?, default_markup_percent = ? WHERE id = ?`,
      [String(input?.sku || '').trim() || null, name, categoryId, unitId, manualPrice, markup, id]);
    return this.getProductDetails(id);
  }

  listCategories() {
    return this.all(`SELECT c.id, c.name, c.parent_id, c.is_active, p.name AS parent_name,
        (SELECT count(*) FROM products pr WHERE pr.category_id = c.id AND pr.is_active = 1) AS product_count,
        (SELECT count(*) FROM item_categories child WHERE child.parent_id = c.id AND child.is_active = 1) AS child_count
      FROM item_categories c
      LEFT JOIN item_categories p ON p.id = c.parent_id
      WHERE c.is_active = 1
      ORDER BY coalesce(p.name, c.name) COLLATE NOCASE, c.parent_id IS NOT NULL, c.name COLLATE NOCASE`);
  }

  saveCategory(input) {
    const id = Number(input?.id) || null;
    const name = String(input?.name || '').trim();
    if (!name) throw new Error('Category name is required.');
    const parentId = input?.parentId ? Number(input.parentId) : null;
    if (parentId) {
      const parent = this.all('SELECT id, parent_id FROM item_categories WHERE id = ? AND is_active = 1', [parentId])[0];
      if (!parent) throw new Error('Parent category was not found.');
      if (parent.parent_id) throw new Error('Only one subcategory level is supported.');
      if (id && parentId === id) throw new Error('A category cannot be its own parent.');
    }
    return this.transaction(() => {
      if (id) {
        const existing = this.all('SELECT id FROM item_categories WHERE id = ?', [id])[0];
        if (!existing) throw new Error('Category was not found.');
        if (parentId && this.all(`WITH RECURSIVE descendants(id) AS (
            SELECT id FROM item_categories WHERE parent_id = ?
            UNION ALL SELECT c.id FROM item_categories c JOIN descendants d ON c.parent_id = d.id)
          SELECT id FROM descendants WHERE id = ?`, [id, parentId])[0])
          throw new Error('A category cannot be moved under one of its descendants.');
        this.database.run('UPDATE item_categories SET name = ?, parent_id = ?, is_active = 1 WHERE id = ?', [name, parentId, id]);
        return this.listCategories().find(row => Number(row.id) === id);
      }
      this.database.run('INSERT INTO item_categories(name, parent_id, is_active) VALUES (?, ?, 1)', [name, parentId]);
      const newId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      return this.listCategories().find(row => Number(row.id) === newId);
    });
  }

  deleteCategory(categoryId) {
    const id = Number(categoryId);
    const category = this.all('SELECT id, name FROM item_categories WHERE id = ? AND is_active = 1', [id])[0];
    if (!category) throw new Error('Category was not found.');
    if (id === 1) throw new Error('The default Uncategorized category cannot be deleted.');
    if (this.all('SELECT id FROM products WHERE category_id = ? AND is_active = 1 LIMIT 1', [id])[0])
      throw new Error('Remove or reassign products before deleting this category.');
    if (this.all('SELECT id FROM item_categories WHERE parent_id = ? AND is_active = 1 LIMIT 1', [id])[0])
      throw new Error('Delete or reassign subcategories first.');
    this.run('UPDATE item_categories SET is_active = 0 WHERE id = ?', [id]);
    return this.listCategories();
  }

  normalizeInventoryKey(value) {
    return String(value || '').trim();
  }

  normalizeInventoryStatus(status, fallback = 'AVAILABLE') {
    const normalized = String(status || fallback).toUpperCase();
    if (!INVENTORY_STATUSES.includes(normalized)) throw new Error(`Invalid inventory status: ${status}`);
    return normalized;
  }

  nextInventoryReference(prefix, operationDate) {
    const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(operationDate || ''))
      ? String(operationDate) : new Date().toISOString().slice(0, 10);
    const codePrefix = `${prefix}-${normalizedDate.replaceAll('-', '')}-`;
    const lastSequence = Number(this.all(`SELECT coalesce(max(CAST(substr(reference_code, ${codePrefix.length + 1}) AS INTEGER)), 0) AS sequence
      FROM inventory_movements WHERE reference_code LIKE ?`, [`${codePrefix}%`])[0]?.sequence || 0);
    return `${codePrefix}${String(lastSequence + 1).padStart(4, '0')}`;
  }

  getBalanceRow(productId, warehouseId, status, batchCode = '', expiryDate = '') {
    return this.all(`SELECT * FROM inventory_balances
      WHERE product_id = ? AND warehouse_id = ? AND status = ? AND batch_code = ? AND expiry_date = ?`,
      [Number(productId), Number(warehouseId), this.normalizeInventoryStatus(status),
        this.normalizeInventoryKey(batchCode), this.normalizeInventoryKey(expiryDate)])[0] || null;
  }

  applyBalanceDelta(productId, warehouseId, status, batchCode, expiryDate, quantityDelta, unitCostBase = 0, options = {}) {
    const normalizedStatus = this.normalizeInventoryStatus(status);
    const batch = this.normalizeInventoryKey(batchCode);
    const expiry = this.normalizeInventoryKey(expiryDate);
    const delta = Number(quantityDelta);
    if (!delta) return null;
    const cost = Math.max(0, Number(unitCostBase) || 0);
    let row = this.getBalanceRow(productId, warehouseId, normalizedStatus, batch, expiry);
    if (!row) {
      if (delta < 0 && !options.allowCreateNegative) throw new Error(`No ${normalizedStatus.toLowerCase()} stock exists for this product location.`);
      this.database.run(`INSERT INTO inventory_balances
        (product_id, warehouse_id, status, batch_code, expiry_date, quantity, unit_cost_base, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP)`,
        [Number(productId), Number(warehouseId), normalizedStatus, batch, expiry, cost]);
      row = this.getBalanceRow(productId, warehouseId, normalizedStatus, batch, expiry);
    }
    const currentQty = Number(row.quantity);
    const currentCost = Number(row.unit_cost_base);
    const nextQty = Math.round((currentQty + delta) * 1e6) / 1e6;
    if (nextQty < -0.000001 && !options.allowNegative) {
      throw new Error(`Insufficient ${normalizedStatus.toLowerCase()} quantity. Available: ${currentQty}.`);
    }
    let nextCost = currentCost;
    if (delta > 0 && nextQty > 0) {
      nextCost = currentQty <= 0 ? cost : ((currentQty * currentCost) + (delta * cost)) / nextQty;
    } else if (nextQty <= 0) {
      nextCost = 0;
    }
    if (nextQty <= 0.0000001) {
      this.database.run('DELETE FROM inventory_balances WHERE id = ?', [row.id]);
      return null;
    }
    this.database.run(`UPDATE inventory_balances SET quantity = ?, unit_cost_base = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [nextQty, Math.round(nextCost * 1e6) / 1e6, row.id]);
    return this.getBalanceRow(productId, warehouseId, normalizedStatus, batch, expiry);
  }

  insertInventoryMovement({
    movementDate, productId, warehouseId, movementType, quantityChange, unitCostBase,
    inventoryStatus = 'AVAILABLE', batchCode = '', expiryDate = '', relatedStatus = null,
    purchaseLineId = null, salesLineId = null, referenceCode = null, notes = null, createdBy = null
  }) {
    this.database.run(`INSERT INTO inventory_movements
      (movement_date, product_id, warehouse_id, movement_type, quantity_change, unit_cost_base,
       inventory_status, batch_code, expiry_date, related_status, purchase_line_id, sales_line_id,
       reference_code, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [movementDate, Number(productId), Number(warehouseId), movementType, Number(quantityChange),
        Math.max(0, Number(unitCostBase) || 0), this.normalizeInventoryStatus(inventoryStatus),
        this.normalizeInventoryKey(batchCode), this.normalizeInventoryKey(expiryDate),
        relatedStatus ? this.normalizeInventoryStatus(relatedStatus) : null,
        purchaseLineId, salesLineId, referenceCode, notes, createdBy]);
    return Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
  }

  reverseMovements(whereSql, parameters = []) {
    const rows = this.all(`SELECT product_id, warehouse_id, quantity_change, unit_cost_base,
        coalesce(inventory_status, 'AVAILABLE') AS inventory_status,
        coalesce(batch_code, '') AS batch_code, coalesce(expiry_date, '') AS expiry_date
      FROM inventory_movements WHERE ${whereSql}`, parameters);
    for (const row of rows) {
      this.applyBalanceDelta(row.product_id, row.warehouse_id, row.inventory_status, row.batch_code, row.expiry_date,
        -Number(row.quantity_change), Number(row.unit_cost_base), { allowNegative: true, allowCreateNegative: true });
    }
    this.database.run(`DELETE FROM inventory_movements WHERE ${whereSql}`, parameters);
  }

  getStatusQuantity(productId, warehouseId, status, batchCode = '', expiryDate = '') {
    const row = this.getBalanceRow(productId, warehouseId, status, batchCode, expiryDate);
    return Number(row?.quantity || 0);
  }

  getAvailableStock(productId, warehouseId) {
    const rows = this.all(`SELECT coalesce(sum(quantity), 0) AS quantity,
        coalesce(sum(quantity * unit_cost_base), 0) AS value_base
      FROM inventory_balances
      WHERE product_id = ? AND warehouse_id = ? AND status = 'AVAILABLE'`, [Number(productId), Number(warehouseId)])[0];
    const quantity = Number(rows?.quantity || 0);
    const value = Number(rows?.value_base || 0);
    return { quantity, value_base: value, average_cost: quantity ? value / quantity : 0 };
  }

  issueAvailableStock(productId, warehouseId, quantity) {
    let remaining = Number(quantity);
    if (!(remaining > 0)) throw new Error('Sale quantity must be greater than zero.');
    const rows = this.all(`SELECT * FROM inventory_balances
      WHERE product_id = ? AND warehouse_id = ? AND status = 'AVAILABLE' AND quantity > 0
      ORDER BY CASE WHEN expiry_date = '' THEN 1 ELSE 0 END, expiry_date, id`,
      [Number(productId), Number(warehouseId)]);
    const available = rows.reduce((sum, row) => sum + Number(row.quantity), 0);
    if (remaining > available + 0.000001) {
      throw new Error(`Insufficient available stock. Available: ${available}.`);
    }
    const allocations = [];
    for (const row of rows) {
      if (remaining <= 0.000001) break;
      const issued = Math.min(remaining, Number(row.quantity));
      this.applyBalanceDelta(productId, warehouseId, 'AVAILABLE', row.batch_code, row.expiry_date,
        -issued, Number(row.unit_cost_base));
      allocations.push({
        quantity: issued, unitCostBase: Number(row.unit_cost_base),
        batchCode: row.batch_code, expiryDate: row.expiry_date
      });
      remaining = Math.round((remaining - issued) * 1e6) / 1e6;
    }
    return allocations;
  }

  postInventoryWriteDown({ productId, operationDate, writeDown, referenceCode, memo, createdBy, sourceId = null }) {
    if (!(writeDown > 0)) return null;
    const currencyId = Number(this.all('SELECT id FROM currencies WHERE is_base = 1 LIMIT 1')[0]?.id || 1);
    const inventoryAccount = Number(this.all(`SELECT account_id FROM accounting_mappings WHERE mapping_key = 'INVENTORY'`)[0]?.account_id || 1300);
    const adjustmentAccount = Number(this.all(`SELECT account_id FROM accounting_mappings WHERE mapping_key = 'INVENTORY_ADJUSTMENT'`)[0]?.account_id || 6100);
    this.database.run(`INSERT INTO journal_entries
      (entry_number, entry_date, description, source_type, source_id, currency_id, exchange_rate_to_base, status, created_by)
      VALUES (?, ?, ?, 'INVENTORY', ?, ?, 1, 'DRAFT', ?)`, [`JE-${referenceCode}`, operationDate,
      memo || `Inventory write-down ${referenceCode}`, sourceId, currencyId, createdBy]);
    const journalId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
    this.database.run(`INSERT INTO journal_lines(journal_entry_id, account_id, product_id, debit_base, memo)
      VALUES (?, ?, ?, ?, ?)`, [journalId, adjustmentAccount, productId, writeDown, memo || `Inventory loss - ${referenceCode}`]);
    this.database.run(`INSERT INTO journal_lines(journal_entry_id, account_id, product_id, credit_base, memo)
      VALUES (?, ?, ?, ?, ?)`, [journalId, inventoryAccount, productId, writeDown, `Inventory write-down - ${referenceCode}`]);
    this.database.run(`UPDATE journal_entries SET status = 'POSTED', posted_at = CURRENT_TIMESTAMP WHERE id = ?`, [journalId]);
    return journalId;
  }

  changeInventoryStatus(input, createdBy) {
    const action = String(input?.action || '').toUpperCase();
    const transition = STATUS_TRANSITIONS[action];
    if (!transition) throw new Error('Select a valid inventory status action.');
    const productId = Number(input?.productId);
    const warehouseId = Number(input?.warehouseId);
    const quantity = Number(input?.quantity);
    const operationDate = String(input?.operationDate || '');
    const batchCode = this.normalizeInventoryKey(input?.batchCode);
    const expiryDate = this.normalizeInventoryKey(input?.expiryDate);
    const notes = String(input?.notes || '').trim() || null;
    const salvageUnitValue = input?.salvageUnitValue === '' || input?.salvageUnitValue == null ? null : Number(input.salvageUnitValue);
    if (!productId || !warehouseId) throw new Error('Product and warehouse are required.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(operationDate)) throw new Error('Enter a valid operation date.');
    if (!(quantity > 0)) throw new Error('Quantity must be greater than zero.');

    return this.transaction(() => {
      const product = this.all(`SELECT p.id, p.name, w.name AS warehouse_name, u.name AS unit_name
        FROM products p CROSS JOIN warehouses w JOIN units u ON u.id = p.default_unit_id
        WHERE p.id = ? AND w.id = ? AND p.is_active = 1 AND w.is_active = 1`, [productId, warehouseId])[0];
      if (!product) throw new Error('The selected product warehouse was not found.');
      const source = this.getBalanceRow(productId, warehouseId, transition.from, batchCode, expiryDate);
      const available = Number(source?.quantity || 0);
      if (quantity > available + 0.000001) {
        throw new Error(`Only ${available} ${transition.from.toLowerCase()} units are available in this warehouse.`);
      }
      const unitCost = Number(source?.unit_cost_base || 0);
      let targetCost = unitCost;
      let writeDown = 0;
      let journalId = null;
      if (action === 'MOVE_TO_SALVAGE' && salvageUnitValue != null) {
        if (!(salvageUnitValue >= 0)) throw new Error('Salvage unit value cannot be negative.');
        if (salvageUnitValue > unitCost + 0.000001) throw new Error(`Salvage value cannot exceed the current cost of ${unitCost.toFixed(4)} SDG.`);
        targetCost = salvageUnitValue;
        writeDown = Math.round(quantity * (unitCost - salvageUnitValue) * 10000) / 10000;
      }
      if ((action === 'DISPOSE_DAMAGED' || action === 'DISPOSE_SALVAGE') && unitCost > 0) {
        writeDown = Math.round(quantity * unitCost * 10000) / 10000;
        targetCost = 0;
      }
      const referenceCode = this.nextInventoryReference(transition.prefix, operationDate);
      this.applyBalanceDelta(productId, warehouseId, transition.from, batchCode, expiryDate, -quantity, unitCost);
      this.applyBalanceDelta(productId, warehouseId, transition.to, batchCode, expiryDate, quantity, targetCost);
      this.insertInventoryMovement({
        movementDate: operationDate, productId, warehouseId, movementType: 'ADJUSTMENT_OUT',
        quantityChange: -quantity, unitCostBase: unitCost, inventoryStatus: transition.from,
        batchCode, expiryDate, relatedStatus: transition.to, referenceCode,
        notes: notes || `${transition.from} → ${transition.to}`, createdBy
      });
      this.insertInventoryMovement({
        movementDate: operationDate, productId, warehouseId, movementType: 'ADJUSTMENT_IN',
        quantityChange: quantity, unitCostBase: targetCost, inventoryStatus: transition.to,
        batchCode, expiryDate, relatedStatus: transition.from, referenceCode,
        notes: notes || `${transition.from} → ${transition.to}`, createdBy
      });
      if (writeDown > 0) {
        journalId = this.postInventoryWriteDown({
          productId, operationDate, writeDown, referenceCode, createdBy,
          memo: `${action.replaceAll('_', ' ')} write-down ${referenceCode}`
        });
        if (action === 'MOVE_TO_SALVAGE' && salvageUnitValue != null) {
          this.database.run(`INSERT INTO inventory_salvage_operations
            (reference_code, operation_date, product_id, warehouse_id, quantity, original_unit_cost_base,
             salvage_unit_value_base, write_down_base, notes, journal_entry_id, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [referenceCode, operationDate, productId, warehouseId, quantity, unitCost, salvageUnitValue,
              writeDown, notes, journalId, createdBy]);
        }
      }
      return {
        referenceCode, journalId, productName: product.name, warehouseName: product.warehouse_name,
        unitName: product.unit_name, action, fromStatus: transition.from, toStatus: transition.to,
        quantity, unitCost, targetCost, writeDown
      };
    });
  }

  adjustInventory(input, createdBy) {
    const productId = Number(input?.productId);
    const warehouseId = Number(input?.warehouseId);
    const status = this.normalizeInventoryStatus(input?.status || 'AVAILABLE');
    const quantity = Number(input?.quantity);
    const operationDate = String(input?.operationDate || '');
    const batchCode = this.normalizeInventoryKey(input?.batchCode);
    const expiryDate = this.normalizeInventoryKey(input?.expiryDate);
    const notes = String(input?.notes || '').trim();
    const unitCostInput = input?.unitCostBase === '' || input?.unitCostBase == null ? null : Number(input.unitCostBase);
    if (!productId || !warehouseId) throw new Error('Product and warehouse are required.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(operationDate)) throw new Error('Enter a valid operation date.');
    if (!(quantity > 0)) throw new Error('Quantity must be greater than zero.');
    if (!notes) throw new Error('A reason is required for inventory adjustments.');
    const direction = String(input?.direction || '').toUpperCase() === 'OUT' ? 'OUT' : 'IN';

    return this.transaction(() => {
      const product = this.all(`SELECT p.id, p.name, w.name AS warehouse_name FROM products p
        CROSS JOIN warehouses w WHERE p.id = ? AND w.id = ? AND p.is_active = 1 AND w.is_active = 1`, [productId, warehouseId])[0];
      if (!product) throw new Error('The selected product warehouse was not found.');
      const existing = this.getBalanceRow(productId, warehouseId, status, batchCode, expiryDate);
      const unitCost = unitCostInput != null ? unitCostInput : Number(existing?.unit_cost_base || 0);
      if (unitCostInput != null && !(unitCostInput >= 0)) throw new Error('Unit cost cannot be negative.');
      const referenceCode = this.nextInventoryReference(direction === 'IN' ? 'ADI' : 'ADO', operationDate);
      if (direction === 'IN') {
        this.applyBalanceDelta(productId, warehouseId, status, batchCode, expiryDate, quantity, unitCost);
        this.insertInventoryMovement({
          movementDate: operationDate, productId, warehouseId, movementType: 'ADJUSTMENT_IN',
          quantityChange: quantity, unitCostBase: unitCost, inventoryStatus: status, batchCode, expiryDate,
          referenceCode, notes, createdBy
        });
        const value = Math.round(quantity * unitCost * 10000) / 10000;
        if (value > 0) {
          const currencyId = Number(this.all('SELECT id FROM currencies WHERE is_base = 1 LIMIT 1')[0]?.id || 1);
          const inventoryAccount = Number(this.all(`SELECT account_id FROM accounting_mappings WHERE mapping_key = 'INVENTORY'`)[0]?.account_id || 1300);
          const adjustmentAccount = Number(this.all(`SELECT account_id FROM accounting_mappings WHERE mapping_key = 'INVENTORY_ADJUSTMENT'`)[0]?.account_id || 6100);
          this.database.run(`INSERT INTO journal_entries
            (entry_number, entry_date, description, source_type, currency_id, exchange_rate_to_base, status, created_by)
            VALUES (?, ?, ?, 'INVENTORY', ?, 1, 'DRAFT', ?)`,
            [`JE-${referenceCode}`, operationDate, `Inventory adjustment in ${referenceCode}`, currencyId, createdBy]);
          const journalId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
          this.database.run(`INSERT INTO journal_lines(journal_entry_id, account_id, product_id, debit_base, memo)
            VALUES (?, ?, ?, ?, ?)`, [journalId, inventoryAccount, productId, value, notes]);
          this.database.run(`INSERT INTO journal_lines(journal_entry_id, account_id, product_id, credit_base, memo)
            VALUES (?, ?, ?, ?, ?)`, [journalId, adjustmentAccount, productId, value, notes]);
          this.database.run(`UPDATE journal_entries SET status = 'POSTED', posted_at = CURRENT_TIMESTAMP WHERE id = ?`, [journalId]);
        }
      } else {
        this.applyBalanceDelta(productId, warehouseId, status, batchCode, expiryDate, -quantity, unitCost);
        this.insertInventoryMovement({
          movementDate: operationDate, productId, warehouseId, movementType: 'ADJUSTMENT_OUT',
          quantityChange: -quantity, unitCostBase: unitCost, inventoryStatus: status, batchCode, expiryDate,
          referenceCode, notes, createdBy
        });
        const value = Math.round(quantity * unitCost * 10000) / 10000;
        if (value > 0) {
          this.postInventoryWriteDown({
            productId, operationDate, writeDown: value, referenceCode, createdBy, memo: notes
          });
        }
      }
      return { referenceCode, productName: product.name, warehouseName: product.warehouse_name, direction, quantity, status, unitCost };
    });
  }

  transferInventory(input, createdBy) {
    const productId = Number(input?.productId);
    const fromWarehouseId = Number(input?.fromWarehouseId);
    const toWarehouseId = Number(input?.toWarehouseId);
    const status = this.normalizeInventoryStatus(input?.status || 'AVAILABLE');
    const quantity = Number(input?.quantity);
    const operationDate = String(input?.operationDate || '');
    const batchCode = this.normalizeInventoryKey(input?.batchCode);
    const expiryDate = this.normalizeInventoryKey(input?.expiryDate);
    const notes = String(input?.notes || '').trim() || null;
    if (!productId || !fromWarehouseId || !toWarehouseId) throw new Error('Product and both warehouses are required.');
    if (fromWarehouseId === toWarehouseId) throw new Error('Choose a different destination warehouse.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(operationDate)) throw new Error('Enter a valid operation date.');
    if (!(quantity > 0)) throw new Error('Quantity must be greater than zero.');

    return this.transaction(() => {
      const source = this.getBalanceRow(productId, fromWarehouseId, status, batchCode, expiryDate);
      const available = Number(source?.quantity || 0);
      if (quantity > available + 0.000001) throw new Error(`Only ${available} units are available to transfer.`);
      const unitCost = Number(source?.unit_cost_base || 0);
      const warehouses = this.all('SELECT id, name FROM warehouses WHERE id IN (?, ?) AND is_active = 1', [fromWarehouseId, toWarehouseId]);
      if (warehouses.length !== 2) throw new Error('One of the warehouses is invalid.');
      const referenceCode = this.nextInventoryReference('TRF', operationDate);
      this.applyBalanceDelta(productId, fromWarehouseId, status, batchCode, expiryDate, -quantity, unitCost);
      this.applyBalanceDelta(productId, toWarehouseId, status, batchCode, expiryDate, quantity, unitCost);
      this.insertInventoryMovement({
        movementDate: operationDate, productId, warehouseId: fromWarehouseId, movementType: 'TRANSFER_OUT',
        quantityChange: -quantity, unitCostBase: unitCost, inventoryStatus: status, batchCode, expiryDate,
        referenceCode, notes: notes || `Transfer to warehouse ${toWarehouseId}`, createdBy
      });
      this.insertInventoryMovement({
        movementDate: operationDate, productId, warehouseId: toWarehouseId, movementType: 'TRANSFER_IN',
        quantityChange: quantity, unitCostBase: unitCost, inventoryStatus: status, batchCode, expiryDate,
        referenceCode, notes: notes || `Transfer from warehouse ${fromWarehouseId}`, createdBy
      });
      return { referenceCode, quantity, status, unitCost, fromWarehouseId, toWarehouseId };
    });
  }

  updateInventoryBalanceMeta(input, createdBy) {
    const productId = Number(input?.productId);
    const warehouseId = Number(input?.warehouseId);
    const status = this.normalizeInventoryStatus(input?.status || 'AVAILABLE');
    const batchCode = this.normalizeInventoryKey(input?.batchCode);
    const expiryDate = this.normalizeInventoryKey(input?.expiryDate);
    const newBatchCode = this.normalizeInventoryKey(input?.newBatchCode);
    const newExpiryDate = this.normalizeInventoryKey(input?.newExpiryDate);
    const newUnitCost = input?.unitCostBase === '' || input?.unitCostBase == null ? null : Number(input.unitCostBase);
    const operationDate = String(input?.operationDate || new Date().toISOString().slice(0, 10));
    const notes = String(input?.notes || '').trim() || 'Inventory metadata update';
    if (!productId || !warehouseId) throw new Error('Product and warehouse are required.');

    return this.transaction(() => {
      const source = this.getBalanceRow(productId, warehouseId, status, batchCode, expiryDate);
      if (!source || !(Number(source.quantity) > 0)) throw new Error('No stock row was found to update.');
      const quantity = Number(source.quantity);
      const oldCost = Number(source.unit_cost_base);
      const targetBatch = input?.newBatchCode == null ? batchCode : newBatchCode;
      const targetExpiry = input?.newExpiryDate == null ? expiryDate : newExpiryDate;
      const targetCost = newUnitCost == null ? oldCost : newUnitCost;
      if (!(targetCost >= 0)) throw new Error('Unit cost cannot be negative.');
      if (targetBatch === batchCode && targetExpiry === expiryDate && Math.abs(targetCost - oldCost) < 0.0000001) {
        throw new Error('No inventory changes were provided.');
      }
      const referenceCode = this.nextInventoryReference('EDT', operationDate);
      this.applyBalanceDelta(productId, warehouseId, status, batchCode, expiryDate, -quantity, oldCost);
      this.applyBalanceDelta(productId, warehouseId, status, targetBatch, targetExpiry, quantity, targetCost);
      this.insertInventoryMovement({
        movementDate: operationDate, productId, warehouseId, movementType: 'ADJUSTMENT_OUT',
        quantityChange: -quantity, unitCostBase: oldCost, inventoryStatus: status, batchCode, expiryDate,
        referenceCode, notes, createdBy
      });
      this.insertInventoryMovement({
        movementDate: operationDate, productId, warehouseId, movementType: 'ADJUSTMENT_IN',
        quantityChange: quantity, unitCostBase: targetCost, inventoryStatus: status,
        batchCode: targetBatch, expiryDate: targetExpiry, referenceCode, notes, createdBy
      });
      const writeDown = Math.round(quantity * (oldCost - targetCost) * 10000) / 10000;
      let journalId = null;
      if (writeDown > 0.000001) {
        journalId = this.postInventoryWriteDown({
          productId, operationDate, writeDown, referenceCode, createdBy, memo: notes
        });
      } else if (writeDown < -0.000001) {
        const value = Math.abs(writeDown);
        const currencyId = Number(this.all('SELECT id FROM currencies WHERE is_base = 1 LIMIT 1')[0]?.id || 1);
        const inventoryAccount = Number(this.all(`SELECT account_id FROM accounting_mappings WHERE mapping_key = 'INVENTORY'`)[0]?.account_id || 1300);
        const adjustmentAccount = Number(this.all(`SELECT account_id FROM accounting_mappings WHERE mapping_key = 'INVENTORY_ADJUSTMENT'`)[0]?.account_id || 6100);
        this.database.run(`INSERT INTO journal_entries
          (entry_number, entry_date, description, source_type, currency_id, exchange_rate_to_base, status, created_by)
          VALUES (?, ?, ?, 'INVENTORY', ?, 1, 'DRAFT', ?)`,
          [`JE-${referenceCode}`, operationDate, `Inventory revaluation ${referenceCode}`, currencyId, createdBy]);
        journalId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
        this.database.run(`INSERT INTO journal_lines(journal_entry_id, account_id, product_id, debit_base, memo)
          VALUES (?, ?, ?, ?, ?)`, [journalId, inventoryAccount, productId, value, notes]);
        this.database.run(`INSERT INTO journal_lines(journal_entry_id, account_id, product_id, credit_base, memo)
          VALUES (?, ?, ?, ?, ?)`, [journalId, adjustmentAccount, productId, value, notes]);
        this.database.run(`UPDATE journal_entries SET status = 'POSTED', posted_at = CURRENT_TIMESTAMP WHERE id = ?`, [journalId]);
      }
      return { referenceCode, journalId, quantity, oldCost, targetCost, batchCode: targetBatch, expiryDate: targetExpiry };
    });
  }

  getProductDetails(productId) {
    const id = Number(productId);
    const product = this.all(`SELECT p.*, c.name AS category_name, pc.name AS parent_category_name,
        u.name AS unit_name
      FROM products p
      JOIN item_categories c ON c.id = p.category_id
      LEFT JOIN item_categories pc ON pc.id = c.parent_id
      JOIN units u ON u.id = p.default_unit_id
      WHERE p.id = ?`, [id])[0];
    if (!product) return null;
    const balances = this.all(`SELECT b.*, w.name AS warehouse_name,
        round(b.quantity * b.unit_cost_base, 4) AS stock_value_base
      FROM inventory_balances b
      JOIN warehouses w ON w.id = b.warehouse_id
      WHERE b.product_id = ? AND b.quantity > 0
      ORDER BY w.name COLLATE NOCASE, b.status, b.batch_code, b.expiry_date`, [id]);
    const summary = {
      available: 0, reserved: 0, damaged: 0, salvage: 0, disposed: 0, total_on_hand: 0, total_value_base: 0
    };
    for (const row of balances) {
      const qty = Number(row.quantity);
      const key = String(row.status).toLowerCase();
      if (summary[key] != null) summary[key] += qty;
      if (row.status !== 'DISPOSED') {
        summary.total_on_hand += qty;
        summary.total_value_base += Number(row.stock_value_base);
      }
    }
    const movements = this.getInventoryMovements(id);
    const warehouses = this.all('SELECT id, code, name FROM warehouses WHERE is_active = 1 ORDER BY name COLLATE NOCASE');
    return { product, balances, summary, movements, warehouses };
  }

  nextPurchaseCode(invoiceDate) {
    const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(invoiceDate || ''))
      ? String(invoiceDate)
      : new Date().toISOString().slice(0, 10);
    const prefix = `PUR-${normalizedDate.replaceAll('-', '')}-`;
    const lastSequence = Number(this.all(`SELECT coalesce(max(CAST(substr(invoice_code, 14) AS INTEGER)), 0) AS sequence
      FROM purchase_invoices WHERE invoice_code LIKE ?`, [`${prefix}%`])[0]?.sequence || 0);
    return `${prefix}${String(lastSequence + 1).padStart(4, '0')}`;
  }

  nextPurchaseOrderNumber(orderDate) {
    const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(orderDate || '')) ? String(orderDate) : new Date().toISOString().slice(0, 10);
    const prefix = `PO-${normalizedDate.replaceAll('-', '')}-`;
    const lastSequence = Number(this.all(`SELECT coalesce(max(CAST(substr(po_number, 13) AS INTEGER)), 0) AS sequence FROM purchase_orders WHERE po_number LIKE ?`, [`${prefix}%`])[0]?.sequence || 0);
    return `${prefix}${String(lastSequence + 1).padStart(4, '0')}`;
  }

  purchaseOrderReceivedBase(purchaseOrderId) {
    return Number(this.all(`SELECT coalesce(sum(pil.base_quantity), 0) AS quantity FROM purchase_invoice_lines pil JOIN purchase_order_lines pol ON pol.id = pil.purchase_order_line_id JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id WHERE pol.purchase_order_id = ? AND pi.status = 'RECEIVED'`, [Number(purchaseOrderId)])[0]?.quantity || 0);
  }

  refreshPurchaseOrderStatus(purchaseOrderId) {
    const order = this.all('SELECT id, status FROM purchase_orders WHERE id = ?', [Number(purchaseOrderId)])[0];
    if (!order || ['DRAFT', 'CANCELLED', 'CLOSED'].includes(order.status)) return order?.status || null;
    const totals = this.all(`SELECT coalesce(sum((pol.ordered_quantity - pol.cancelled_quantity) * pol.unit_quantity), 0) AS ordered_base, coalesce(sum((SELECT coalesce(sum(pil.base_quantity), 0) FROM purchase_invoice_lines pil JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id WHERE pil.purchase_order_line_id = pol.id AND pi.status = 'RECEIVED')), 0) AS received_base FROM purchase_order_lines pol WHERE pol.purchase_order_id = ?`, [Number(purchaseOrderId)])[0];
    const ordered = Number(totals?.ordered_base || 0); const received = Number(totals?.received_base || 0);
    const status = ordered > 0 && received + 0.000001 >= ordered ? 'RECEIVED' : received > 0 ? 'PARTIALLY_RECEIVED' : 'OPEN';
    this.database.run('UPDATE purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, Number(purchaseOrderId)]);
    return status;
  }

  listPurchaseOrders(scope = 'all') {
    const where = scope === 'accounting' ? "WHERE po.approval_state = 'FINANCE_APPROVED'" : '';
    return this.all(`SELECT po.id, po.po_number, po.order_date, po.expected_delivery_date, po.status, po.approval_state,
      po.submitted_by, po.submitted_at, po.commercial_approved_at, po.financial_approved_at, po.accounting_handoff_at,
      po.supplier_reference, s.name AS supplier_name, c.code AS currency_code,
      commercial.username AS commercial_approved_by_name, financial.username AS financial_approved_by_name,
      coalesce(sum(pol.line_total), 0) AS total
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN currencies c ON c.id = po.currency_id
      LEFT JOIN users commercial ON commercial.id = po.commercial_approved_by
      LEFT JOIN users financial ON financial.id = po.financial_approved_by
      LEFT JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
      ${where} GROUP BY po.id ORDER BY po.order_date DESC, po.id DESC`);
  }

  getPurchaseOrder(purchaseOrderId, scope = 'all') {
    const id = Number(purchaseOrderId); this.refreshPurchaseOrderStatus(id);
    const scopeClause = scope === 'accounting' ? " AND po.approval_state = 'FINANCE_APPROVED'" : '';
    const header = this.all(`SELECT po.*, s.name AS supplier_name, s.phone_number AS supplier_phone, s.location AS supplier_location,
      c.code AS currency_code, w.name AS warehouse_name, u.username AS created_by_name,
      cu.username AS commercial_approved_by_name, fu.username AS financial_approved_by_name,
      coalesce(sum(pol.line_total), 0) AS total
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN currencies c ON c.id = po.currency_id
      JOIN warehouses w ON w.id = po.warehouse_id LEFT JOIN users u ON u.id = po.created_by
      LEFT JOIN users cu ON cu.id = po.commercial_approved_by LEFT JOIN users fu ON fu.id = po.financial_approved_by
      LEFT JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id WHERE po.id = ?${scopeClause} GROUP BY po.id`, [id])[0];
    if (!header) return null;
    return { ...header,
      lines: this.all(`SELECT pol.*, p.name AS product_name, u.name AS unit_name, coalesce((SELECT sum(pil.base_quantity) / pol.unit_quantity FROM purchase_invoice_lines pil JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id WHERE pil.purchase_order_line_id = pol.id AND pi.status = 'RECEIVED'), 0) AS received_quantity FROM purchase_order_lines pol JOIN products p ON p.id = pol.product_id JOIN units u ON u.id = pol.unit_id WHERE pol.purchase_order_id = ? ORDER BY pol.id`, [id]),
      approvalHistory: this.all(`SELECT h.*, u.username AS acted_by_name FROM purchase_order_approval_history h
        JOIN users u ON u.id = h.acted_by WHERE h.purchase_order_id = ? ORDER BY h.id`, [id]) };
  }

  savePurchaseOrder(purchaseOrderId, input, createdBy) {
    const id = Number(purchaseOrderId) || null; const supplierId = Number(input?.supplierId); const currencyId = Number(input?.currencyId); const warehouseId = Number(input?.warehouseId); const exchangeRate = Number(input?.exchangeRate); const orderDate = String(input?.orderDate || ''); const expectedDate = String(input?.expectedDeliveryDate || '').trim() || null; const lines = Array.isArray(input?.lines) ? input.lines : [];
    if (!supplierId || !currencyId || !warehouseId) throw new Error('Supplier, currency and receiving warehouse are required.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate) || (expectedDate && !/^\d{4}-\d{2}-\d{2}$/.test(expectedDate))) throw new Error('Enter valid order and expected delivery dates.');
    if (!(exchangeRate > 0)) throw new Error('Exchange rate must be greater than zero.');
    if (!lines.length) throw new Error('Add at least one valid product line.');
    return this.transaction(() => {
      let orderId = id; let current = null;
      if (id) {
        current = this.all('SELECT * FROM purchase_orders WHERE id = ?', [id])[0];
        if (!current) throw new Error('Purchase order was not found.');
        if (!['DRAFT', 'OPEN'].includes(current.status) || this.purchaseOrderReceivedBase(id) > 0 || ['PENDING_COMMERCIAL', 'PENDING_FINANCE', 'FINANCE_APPROVED'].includes(current.approval_state))
          throw new Error('Pending or approved purchase orders cannot be edited. The current approver must reject a pending order before it can be revised.');
        this.database.run(`UPDATE purchase_orders SET supplier_id = ?, order_date = ?, expected_delivery_date = ?, currency_id = ?, exchange_rate_to_base = ?, warehouse_id = ?, supplier_reference = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [supplierId, orderDate, expectedDate, currencyId, exchangeRate, warehouseId, String(input?.supplierReference || '').trim() || null, String(input?.notes || '').trim() || null, id]);
        this.database.run('DELETE FROM purchase_order_lines WHERE purchase_order_id = ?', [id]);
      } else {
        const number = this.nextPurchaseOrderNumber(orderDate);
        this.database.run(`INSERT INTO purchase_orders(po_number, supplier_id, order_date, expected_delivery_date, currency_id, exchange_rate_to_base, warehouse_id, supplier_reference, notes, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)`, [number, supplierId, orderDate, expectedDate, currencyId, exchangeRate, warehouseId, String(input?.supplierReference || '').trim() || null, String(input?.notes || '').trim() || null, createdBy]);
        orderId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      }
      for (const line of lines) {
        const product = this.all('SELECT id, default_unit_id FROM products WHERE id = ? AND is_active = 1', [Number(line.productId)])[0]; const quantity = Number(line.quantity); const unitQuantity = Number(line.unitQuantity); const unitPrice = Number(line.unitPrice);
        if (!product || !(quantity > 0) || !(unitQuantity > 0) || !(unitPrice > 0)) throw new Error('Every purchase-order line needs a valid product, positive quantity and positive price.');
        this.database.run(`INSERT INTO purchase_order_lines(purchase_order_id, product_id, description, ordered_quantity, unit_id, unit_quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?)`, [orderId, product.id, String(line.description || '').trim() || null, quantity, Number(line.unitId) || product.default_unit_id, unitQuantity, unitPrice]);
      }
      if (input?.confirm) {
        this.database.run(`UPDATE purchase_orders SET approval_state = 'PENDING_COMMERCIAL', submitted_by = ?, submitted_at = CURRENT_TIMESTAMP,
          commercial_approved_by = NULL, commercial_approved_at = NULL, commercial_approval_comment = NULL,
          financial_approved_by = NULL, financial_approved_at = NULL, financial_approval_comment = NULL,
          accounting_handoff_at = NULL, status = 'DRAFT', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [createdBy, orderId]);
        this.database.run(`INSERT INTO purchase_order_approval_history(purchase_order_id, action, acted_by)
          VALUES (?, 'SUBMITTED_TO_COMMERCIAL', ?)`, [orderId, createdBy]);
        this.audit(createdBy, 'SUBMITTED_TO_COMMERCIAL', 'PURCHASE_ORDER', orderId);
      }
      return this.getPurchaseOrder(orderId);
    });
  }

  setPurchaseOrderStatus(purchaseOrderId, action, actedBy, comment = '') {
    const id = Number(purchaseOrderId); const normalized = String(action || '').toUpperCase();
    return this.transaction(() => {
      const order = this.all('SELECT * FROM purchase_orders WHERE id = ?', [id])[0]; if (!order) throw new Error('Purchase order was not found.'); const received = this.purchaseOrderReceivedBase(id);
      if (['CONFIRM', 'SUBMIT'].includes(normalized) && order.status === 'DRAFT' && !['PENDING_COMMERCIAL', 'PENDING_FINANCE', 'FINANCE_APPROVED'].includes(order.approval_state)) {
        this.database.run(`UPDATE purchase_orders SET approval_state = 'PENDING_COMMERCIAL', submitted_by = ?, submitted_at = CURRENT_TIMESTAMP,
          commercial_approved_by = NULL, commercial_approved_at = NULL, commercial_approval_comment = NULL,
          financial_approved_by = NULL, financial_approved_at = NULL, financial_approval_comment = NULL,
          accounting_handoff_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [actedBy, id]);
        this.database.run(`INSERT INTO purchase_order_approval_history(purchase_order_id, action, comment, acted_by)
          VALUES (?, 'SUBMITTED_TO_COMMERCIAL', ?, ?)`, [id, String(comment || '').trim() || null, actedBy]);
      } else if (normalized === 'COMMERCIAL_APPROVE' && order.status === 'DRAFT' && order.approval_state === 'PENDING_COMMERCIAL') {
        if (String(order.submitted_by) === String(actedBy)) throw new Error('The requester cannot approve their own purchase order.');
        this.database.run(`UPDATE purchase_orders SET approval_state = 'PENDING_FINANCE', commercial_approved_by = ?,
          commercial_approved_at = CURRENT_TIMESTAMP, commercial_approval_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [actedBy, String(comment || '').trim() || null, id]);
        this.database.run(`INSERT INTO purchase_order_approval_history(purchase_order_id, action, comment, acted_by)
          VALUES (?, 'COMMERCIAL_APPROVED', ?, ?)`, [id, String(comment || '').trim() || null, actedBy]);
        this.database.run(`INSERT INTO purchase_order_approval_history(purchase_order_id, action, comment, acted_by)
          VALUES (?, 'ROUTED_TO_FINANCE', 'Automatically routed after Commercial approval', ?)`, [id, actedBy]);
        this.audit(actedBy, 'ROUTED_TO_FINANCE', 'PURCHASE_ORDER', id, 'Automatically routed after Commercial approval');
      } else if (normalized === 'COMMERCIAL_REJECT' && order.status === 'DRAFT' && order.approval_state === 'PENDING_COMMERCIAL') {
        if (!String(comment || '').trim()) throw new Error('Enter a rejection reason.');
        if (String(order.submitted_by) === String(actedBy)) throw new Error('The requester cannot reject their own purchase order.');
        this.database.run(`UPDATE purchase_orders SET approval_state = 'COMMERCIAL_REJECTED', commercial_approved_by = ?, commercial_approved_at = CURRENT_TIMESTAMP,
          commercial_approval_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [actedBy, String(comment).trim(), id]);
        this.database.run(`INSERT INTO purchase_order_approval_history(purchase_order_id, action, comment, acted_by)
          VALUES (?, 'COMMERCIAL_REJECTED', ?, ?)`, [id, String(comment).trim(), actedBy]);
      } else if (normalized === 'FINANCE_APPROVE' && order.status === 'DRAFT' && order.approval_state === 'PENDING_FINANCE') {
        if (String(order.submitted_by) === String(actedBy)) throw new Error('The requester cannot approve their own purchase order.');
        if (String(order.commercial_approved_by) === String(actedBy)) throw new Error('The Commercial approver cannot perform final Financial approval.');
        this.database.run(`UPDATE purchase_orders SET approval_state = 'FINANCE_APPROVED', status = 'OPEN', financial_approved_by = ?,
          financial_approved_at = CURRENT_TIMESTAMP, financial_approval_comment = ?, accounting_handoff_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [actedBy, String(comment || '').trim() || null, id]);
        this.database.run(`INSERT INTO purchase_order_approval_history(purchase_order_id, action, comment, acted_by)
          VALUES (?, 'FINANCE_APPROVED', ?, ?)`, [id, String(comment || '').trim() || null, actedBy]);
        this.database.run(`INSERT INTO purchase_order_approval_history(purchase_order_id, action, comment, acted_by)
          VALUES (?, 'HANDED_TO_ACCOUNTING', 'Automatically handed to Accounting after Financial approval', ?)`, [id, actedBy]);
        this.audit(actedBy, 'HANDED_TO_ACCOUNTING', 'PURCHASE_ORDER', id, 'Automatically handed to Accounting after Financial approval');
      } else if (normalized === 'FINANCE_REJECT' && order.status === 'DRAFT' && order.approval_state === 'PENDING_FINANCE') {
        if (!String(comment || '').trim()) throw new Error('Enter a rejection reason.');
        if (String(order.submitted_by) === String(actedBy)) throw new Error('The requester cannot reject their own purchase order.');
        if (String(order.commercial_approved_by) === String(actedBy)) throw new Error('The Commercial approver cannot perform the Financial decision.');
        this.database.run(`UPDATE purchase_orders SET approval_state = 'FINANCE_REJECTED', financial_approved_by = ?, financial_approved_at = CURRENT_TIMESTAMP,
          financial_approval_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [actedBy, String(comment).trim(), id]);
        this.database.run(`INSERT INTO purchase_order_approval_history(purchase_order_id, action, comment, acted_by)
          VALUES (?, 'FINANCE_REJECTED', ?, ?)`, [id, String(comment).trim(), actedBy]);
      }
      else if (normalized === 'CANCEL' && ['DRAFT', 'OPEN'].includes(order.status) && !['PENDING_COMMERCIAL', 'PENDING_FINANCE'].includes(order.approval_state) && received <= 0) this.database.run("UPDATE purchase_orders SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
      else if (normalized === 'CLOSE' && ['OPEN', 'PARTIALLY_RECEIVED'].includes(order.status)) this.database.run("UPDATE purchase_orders SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
      else throw new Error('This purchase-order action is not allowed in its current status.');
      this.audit(actedBy, ['CONFIRM', 'SUBMIT'].includes(normalized) ? 'SUBMITTED_TO_COMMERCIAL' : normalized, 'PURCHASE_ORDER', id,
        String(comment || '').trim());
      return this.getPurchaseOrder(id);
    });
  }

  deletePurchaseOrder(purchaseOrderId) {
    const id = Number(purchaseOrderId); return this.transaction(() => { const order = this.all('SELECT status, approval_state FROM purchase_orders WHERE id = ?', [id])[0]; if (!order) throw new Error('Purchase order was not found.'); if (order.status !== 'DRAFT' || ['PENDING_COMMERCIAL', 'PENDING_FINANCE', 'FINANCE_APPROVED'].includes(order.approval_state) || this.purchaseOrderReceivedBase(id) > 0) throw new Error('Only an unsubmitted draft purchase order can be deleted.'); this.database.run('DELETE FROM purchase_orders WHERE id = ?', [id]); return true; });
  }

  audit(userId, action, entityType, entityId, reason = '', details = null) {
    this.database.run(`INSERT INTO audit_events(user_id, action, entity_type, entity_id, reason, details_json)
      VALUES (?, ?, ?, ?, ?, ?)`, [userId || null, String(action), String(entityType), entityId == null ? null : String(entityId),
      String(reason || '').trim() || null, details == null ? null : JSON.stringify(details)]);
  }
  nextPurchaseCostCode(invoiceDate) {
    const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(invoiceDate || ''))
      ? String(invoiceDate)
      : new Date().toISOString().slice(0, 10);
    const prefix = `CST-${normalizedDate.replaceAll('-', '')}-`;
    const lastSequence = Number(this.all(`SELECT coalesce(max(CAST(substr(reference_code, 14) AS INTEGER)), 0) AS sequence
      FROM purchase_additional_costs WHERE reference_code LIKE ?`, [`${prefix}%`])[0]?.sequence || 0);
    return `${prefix}${String(lastSequence + 1).padStart(4, '0')}`;
  }

  nextSalvageCode(operationDate) {
    const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(operationDate || ''))
      ? String(operationDate) : new Date().toISOString().slice(0, 10);
    const prefix = `SAL-${normalizedDate.replaceAll('-', '')}-`;
    const lastSequence = Number(this.all(`SELECT coalesce(max(CAST(substr(reference_code, 14) AS INTEGER)), 0) AS sequence
      FROM inventory_salvage_operations WHERE reference_code LIKE ?`, [`${prefix}%`])[0]?.sequence || 0);
    return `${prefix}${String(lastSequence + 1).padStart(4, '0')}`;
  }
  listPurchases() {
    return this.all(`SELECT pi.id, pi.invoice_code, pi.supplier_invoice_number, pi.invoice_date, pi.status, pi.workflow_state, pi.stock_posted_at,
        s.name AS supplier_name, c.code AS currency_code, po.po_number,
        coalesce(w.name, (SELECT iw.name FROM inventory_movements im
          JOIN purchase_invoice_lines pil ON pil.id = im.purchase_line_id
          JOIN warehouses iw ON iw.id = im.warehouse_id
          WHERE pil.purchase_invoice_id = pi.id LIMIT 1)) AS warehouse_name,
        pit.goods_total, pit.additional_cost_total, pit.landed_total,
        (SELECT count(*) FROM invoice_attachments ia WHERE ia.invoice_type = 'PURCHASE' AND ia.invoice_id = pi.id) AS attachment_count,
        round(pit.landed_total * pi.exchange_rate_to_base, 4) AS landed_total_base
      FROM purchase_invoices pi JOIN suppliers s ON s.id = pi.supplier_id JOIN currencies c ON c.id = pi.currency_id
      LEFT JOIN purchase_orders po ON po.id = pi.purchase_order_id
      LEFT JOIN warehouses w ON w.id = pi.stock_warehouse_id
      JOIN purchase_invoice_totals pit ON pit.purchase_invoice_id = pi.id ORDER BY pi.invoice_date DESC, pi.id DESC`);
  }

  createPurchase(input, attachments = [], createdBy, withinTransaction = false) {
    const supplierId = Number(input?.supplierId);
    const currencyId = Number(input?.currencyId);
    const warehouseId = Number(input?.warehouseId);
    const purchaseOrderId = Number(input?.purchaseOrderId) || null;
    const supplierInvoiceNumber = String(input?.supplierInvoiceNumber || '').trim() || null;
    const exchangeRate = Number(input?.exchangeRate || 1);
    const invoiceDate = String(input?.invoiceDate || '');
    const status = 'DRAFT';
    const lines = Array.isArray(input?.lines) ? input.lines : [];
    const costs = Array.isArray(input?.costs) ? input.costs : [];
    if (!supplierId || !currencyId || !warehouseId || !invoiceDate) throw new Error('Supplier, date, currency and warehouse are required.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) throw new Error('Enter a valid invoice date.');
    if (!(exchangeRate > 0)) throw new Error('Exchange rate must be greater than zero.');
    if (!lines.length) throw new Error('Add at least one product line.');
    if (!purchaseOrderId && !input?.allowDirectPurchase) throw new Error('Create purchase invoices from a finance-approved purchase order.');

    const work = () => {
      const invoiceCode = String(input?.invoiceCode || '').trim() || this.nextPurchaseCode(invoiceDate);
      if (supplierInvoiceNumber && !input?.allowDuplicateSupplierInvoice && this.all(`SELECT id FROM purchase_invoices WHERE supplier_id = ? AND supplier_invoice_number = ? COLLATE NOCASE LIMIT 1`, [supplierId, supplierInvoiceNumber])[0]) throw new Error('DUPLICATE_SUPPLIER_INVOICE: This supplier invoice number already exists for the selected supplier.');
      const order = purchaseOrderId ? this.all(`SELECT id, supplier_id, currency_id, status, approval_state FROM purchase_orders WHERE id = ?`, [purchaseOrderId])[0] : null;
      if (purchaseOrderId && (!order || order.approval_state !== 'FINANCE_APPROVED' || !['OPEN', 'PARTIALLY_RECEIVED'].includes(order.status)))
        throw new Error('The source purchase order requires Commercial and final Financial approval.');
      if (order && (Number(order.supplier_id) !== supplierId || Number(order.currency_id) !== currencyId)) throw new Error('Supplier and currency must match the source purchase order.');
      const declaredTotal = input?.declaredTotal === '' || input?.declaredTotal == null ? null : Number(input.declaredTotal);
      this.database.run(`INSERT INTO purchase_invoices
        (invoice_code, supplier_invoice_number, purchase_order_id, supplier_id, invoice_date, currency_id, exchange_rate_to_base, declared_invoice_total, status, notes, created_by, stock_warehouse_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [invoiceCode, supplierInvoiceNumber, purchaseOrderId, supplierId, invoiceDate, currencyId, exchangeRate, declaredTotal,
        status, String(input?.notes || '').trim() || null, createdBy, warehouseId]);
      const purchaseId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      const receivingByOrderLine = new Map();

      for (const line of lines) {
        const product = this.all('SELECT category_id, default_unit_id FROM products WHERE id = ? AND is_active = 1', [Number(line.productId)])[0];
        if (!product) throw new Error('One of the selected products is invalid.');
        const quantity = Number(line.quantity);
        const unitQuantity = Number(line.unitQuantity || 1);
        const unitPrice = Number(line.unitPrice);
        if (!(quantity > 0) || !(unitQuantity > 0) || !(unitPrice > 0)) throw new Error('Product quantities and prices must be greater than zero.');
        const orderLineId = Number(line.purchaseOrderLineId) || null;
        if (purchaseOrderId && !orderLineId) throw new Error('Every received line must link to its purchase-order line.');
        if (orderLineId) {
          const source = this.all(`SELECT pol.*, coalesce((SELECT sum(pil.base_quantity) FROM purchase_invoice_lines pil JOIN purchase_invoices pi ON pi.id = pil.purchase_invoice_id WHERE pil.purchase_order_line_id = pol.id AND pi.status = 'RECEIVED'), 0) AS received_base FROM purchase_order_lines pol WHERE pol.id = ? AND pol.purchase_order_id = ?`, [orderLineId, purchaseOrderId])[0];
          if (!source || Number(source.product_id) !== Number(line.productId) || Number(source.unit_id) !== (Number(line.unitId) || product.default_unit_id)) throw new Error('A received line no longer matches its source purchase-order line.');
          const receivingBase = quantity * unitQuantity; const alreadyInInput = receivingByOrderLine.get(orderLineId) || 0;
          const remainingBase = (Number(source.ordered_quantity) - Number(source.cancelled_quantity)) * Number(source.unit_quantity) - Number(source.received_base);
          if (receivingBase + alreadyInInput > remainingBase + 0.000001 && !input?.allowOverDelivery) throw new Error('OVER_DELIVERY: The receiving quantity exceeds the remaining purchase-order quantity.');
          receivingByOrderLine.set(orderLineId, receivingBase + alreadyInInput);
        }
        const pricingMethod = input?.allowPricing && line.pricingMethod === 'MARKUP' ? 'MARKUP' : 'MANUAL';
        const manualPrice = input?.allowPricing && line.manualSalesPrice !== '' && line.manualSalesPrice != null ? Number(line.manualSalesPrice) : null;
        const markup = input?.allowPricing && line.markupPercent !== '' && line.markupPercent != null ? Number(line.markupPercent) : null;
        this.database.run(`INSERT INTO purchase_invoice_lines
          (purchase_invoice_id, purchase_order_line_id, product_id, category_id, description, quantity, unit_id, unit_quantity, unit_price,
           pricing_method, manual_sales_price, markup_percent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [purchaseId, orderLineId, Number(line.productId), product.category_id, String(line.description || '').trim() || null,
          quantity, Number(line.unitId) || product.default_unit_id, unitQuantity, unitPrice, pricingMethod, manualPrice, markup]);
      }

      for (const cost of costs) {
        const amount = Number(cost.amount);
        if (!(amount >= 0)) throw new Error('Additional cost amounts are invalid.');
        if (amount === 0) continue;
        this.database.run(`INSERT INTO purchase_additional_costs
          (purchase_invoice_id, cost_type_id, description, amount, currency_id, exchange_rate_to_base, reference_code)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [purchaseId, Number(cost.costTypeId), String(cost.description || '').trim() || null,
          amount, Number(cost.currencyId) || currencyId, Number(cost.exchangeRate || exchangeRate), String(cost.referenceCode || '').trim() || null]);
      }

      this.storeInvoiceAttachments('PURCHASE', purchaseId, attachments, createdBy);
      if (purchaseOrderId) this.refreshPurchaseOrderStatus(purchaseOrderId);
      return this.getPurchase(purchaseId);
    };
    return withinTransaction ? work() : this.transaction(work);
  }

  teardownPurchase(purchaseId) {
    const id = Number(purchaseId); const purchase = this.all('SELECT id, journal_entry_id, purchase_order_id FROM purchase_invoices WHERE id = ?', [id])[0];
    if (!purchase) throw new Error('Purchase invoice was not found.');
    const journalIds = this.all('SELECT journal_entry_id AS id FROM purchase_additional_costs WHERE purchase_invoice_id = ? AND journal_entry_id IS NOT NULL', [id]).map(row => Number(row.id));
    if (purchase.journal_entry_id) journalIds.push(Number(purchase.journal_entry_id));
    this.reverseMovements('purchase_line_id IN (SELECT id FROM purchase_invoice_lines WHERE purchase_invoice_id = ?)', [id]);
    this.database.run('UPDATE purchase_additional_costs SET journal_entry_id = NULL WHERE purchase_invoice_id = ?', [id]);
    this.database.run('UPDATE purchase_invoices SET journal_entry_id = NULL WHERE id = ?', [id]);
    this.database.run("DELETE FROM invoice_attachments WHERE invoice_type = 'PURCHASE' AND invoice_id = ?", [id]);
    for (const journalId of [...new Set(journalIds)]) {
      this.database.run("UPDATE journal_entries SET status = 'VOID' WHERE id = ?", [journalId]);
      this.database.run('DELETE FROM journal_entries WHERE id = ?', [journalId]);
    }
    this.database.run('DELETE FROM purchase_invoices WHERE id = ?', [id]);
    if (purchase.purchase_order_id) this.refreshPurchaseOrderStatus(purchase.purchase_order_id);
  }

  updatePurchase(purchaseId, input, attachments, createdBy) {
    return this.transaction(() => {
      const original = this.all('SELECT invoice_code FROM purchase_invoices WHERE id = ?', [Number(purchaseId)])[0];
      if (!original) throw new Error('Purchase invoice was not found.');
      if (this.all('SELECT id FROM purchase_additional_costs WHERE purchase_invoice_id = ? AND supplier_id IS NOT NULL LIMIT 1', [Number(purchaseId)])[0])
        throw new Error('Remove or recreate separately attached cost invoices before editing this purchase invoice.');
      const existingAttachments = this.all(`SELECT original_name AS name, mime_type AS mimeType, file_size AS size, file_data AS data
        FROM invoice_attachments WHERE invoice_type = 'PURCHASE' AND invoice_id = ?`, [Number(purchaseId)]);
      const savedAttachments = [...existingAttachments, ...attachments];
      this.teardownPurchase(purchaseId);
      return this.createPurchase({ ...input, invoiceCode: original.invoice_code }, savedAttachments, createdBy, true);
    });
  }

  deletePurchase(purchaseId) {
    const invoice = this.all('SELECT status, workflow_state FROM purchase_invoices WHERE id = ?', [Number(purchaseId)])[0];
    if (!invoice) throw new Error('Purchase invoice was not found.');
    if (invoice.status !== 'DRAFT' || invoice.workflow_state !== 'DRAFT') throw new Error('Only an unsubmitted draft purchase invoice can be deleted.');
    return this.transaction(() => { this.teardownPurchase(purchaseId); return true; });
  }

  submitPurchaseInvoice(purchaseId, submittedBy) {
    const id = Number(purchaseId);
    return this.transaction(() => {
      const invoice = this.all(`SELECT pi.*, pit.landed_total FROM purchase_invoices pi
        JOIN purchase_invoice_totals pit ON pit.purchase_invoice_id = pi.id WHERE pi.id = ?`, [id])[0];
      if (!invoice) throw new Error('Purchase invoice was not found.');
      if (invoice.status !== 'DRAFT' || invoice.workflow_state !== 'DRAFT') throw new Error('Only a draft purchase invoice can be submitted.');
      if (!invoice.purchase_order_id) throw new Error('A finance-approved purchase order is required before submitting this invoice.');
      const order = this.all('SELECT approval_state, status FROM purchase_orders WHERE id = ?', [invoice.purchase_order_id])[0];
      if (!order || order.approval_state !== 'FINANCE_APPROVED' || !['OPEN', 'PARTIALLY_RECEIVED'].includes(order.status))
        throw new Error('The related purchase order requires Commercial and final Financial approval and must be open.');
      this.database.run(`UPDATE purchase_invoices SET workflow_state = 'SUBMITTED', submitted_by = ?, submitted_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [submittedBy, id]);
      this.database.run(`INSERT INTO purchase_invoice_approval_history(purchase_invoice_id, action, acted_by)
        VALUES (?, 'SUBMITTED', ?)`, [id, submittedBy]);
      this.database.run(`INSERT INTO purchase_funding_requests
        (purchase_invoice_id, requested_amount, currency_id, exchange_rate_to_base, requested_by)
        VALUES (?, ?, ?, ?, ?)`, [id, Number(invoice.landed_total), invoice.currency_id, invoice.exchange_rate_to_base, submittedBy]);
      this.audit(submittedBy, 'SUBMITTED', 'PURCHASE_INVOICE', id, '', { amount: Number(invoice.landed_total) });
      return this.getPurchase(id);
    });
  }

  listPurchaseFunding() {
    return this.all(`SELECT fr.id, fr.purchase_invoice_id, fr.requested_amount, fr.status, fr.requested_at,
        fr.decided_at, fr.decision_comment, pi.invoice_code, pi.workflow_state, pi.invoice_date,
        s.id AS supplier_id, s.name AS supplier_name, c.code AS currency_code,
        requester.username AS requested_by_name, decider.username AS decided_by_name,
        (SELECT sp.payment_mode FROM supplier_payments sp WHERE sp.funding_request_id = fr.id ORDER BY sp.id DESC LIMIT 1) AS last_payment_mode,
        (SELECT u.username FROM supplier_payments sp JOIN users u ON u.id = sp.recipient_user_id
          WHERE sp.funding_request_id = fr.id ORDER BY sp.id DESC LIMIT 1) AS advance_recipient_name,
        (SELECT pdo.id FROM purchase_disbursement_orders pdo WHERE pdo.funding_request_id = fr.id
          AND pdo.status IN ('PENDING_TREASURY', 'PARTIALLY_EXECUTED') ORDER BY pdo.id DESC LIMIT 1) AS pending_disbursement_id,
        (SELECT pdo.order_number FROM purchase_disbursement_orders pdo WHERE pdo.funding_request_id = fr.id
          AND pdo.status IN ('PENDING_TREASURY', 'PARTIALLY_EXECUTED') ORDER BY pdo.id DESC LIMIT 1) AS pending_disbursement_number,
        coalesce((SELECT sum(pdo.amount) FROM purchase_disbursement_orders pdo WHERE pdo.funding_request_id = fr.id
          AND pdo.status IN ('PENDING_TREASURY', 'PARTIALLY_EXECUTED')), 0) AS ordered_amount,
        coalesce((SELECT sum(spa.allocated_amount) FROM supplier_payment_allocations spa
          JOIN supplier_payments sp ON sp.id = spa.supplier_payment_id WHERE sp.funding_request_id = fr.id), 0) AS paid_amount
      FROM purchase_funding_requests fr
      JOIN purchase_invoices pi ON pi.id = fr.purchase_invoice_id
      JOIN suppliers s ON s.id = pi.supplier_id JOIN currencies c ON c.id = fr.currency_id
      JOIN users requester ON requester.id = fr.requested_by LEFT JOIN users decider ON decider.id = fr.decided_by
      ORDER BY fr.requested_at DESC, fr.id DESC`);
  }

  decidePurchaseFunding(requestId, action, comment, decidedBy) {
    const id = Number(requestId); const decision = String(action || '').toUpperCase(); const reason = String(comment || '').trim();
    if (!['AUTHORIZE', 'REJECT'].includes(decision)) throw new Error('Choose authorize or reject.');
    if (decision === 'REJECT' && !reason) throw new Error('Enter a rejection reason.');
    return this.transaction(() => {
      const request = this.all('SELECT * FROM purchase_funding_requests WHERE id = ?', [id])[0];
      if (!request || request.status !== 'PENDING') throw new Error('This funding request is no longer pending.');
      if (String(request.requested_by) === String(decidedBy)) throw new Error('The requester cannot authorize their own funding request.');
      const authorized = decision === 'AUTHORIZE';
      this.database.run(`UPDATE purchase_funding_requests SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP,
        decision_comment = ? WHERE id = ?`, [authorized ? 'AUTHORIZED' : 'REJECTED', decidedBy, reason || null, id]);
      this.database.run('UPDATE purchase_invoices SET workflow_state = ? WHERE id = ?',
        [authorized ? 'FUNDING_AUTHORIZED' : 'REJECTED', request.purchase_invoice_id]);
      this.database.run(`INSERT INTO purchase_invoice_approval_history(purchase_invoice_id, action, comment, acted_by)
        VALUES (?, ?, ?, ?)`, [request.purchase_invoice_id, authorized ? 'AUTHORIZED' : 'REJECTED', reason || null, decidedBy]);
      this.audit(decidedBy, authorized ? 'AUTHORIZED' : 'REJECTED', 'PURCHASE_FUNDING', id, reason);
      return this.listPurchaseFunding().find(row => Number(row.id) === id);
    });
  }

  nextSupplierPaymentNumber(entryDate) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(entryDate || '')) ? String(entryDate) : new Date().toISOString().slice(0, 10);
    const prefix = `PV-PUR-${date.replaceAll('-', '')}-`;
    const count = Number(this.all('SELECT count(*) AS total FROM supplier_payments WHERE payment_number LIKE ?', [`${prefix}%`])[0]?.total || 0);
    return `${prefix}${String(count + 1).padStart(4, '0')}`;
  }

  nextDisbursementOrderNumber() {
    const prefix = `DO-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-`;
    const count = Number(this.all('SELECT count(*) AS total FROM purchase_disbursement_orders WHERE order_number LIKE ?', [`${prefix}%`])[0]?.total || 0);
    return `${prefix}${String(count + 1).padStart(4, '0')}`;
  }

  createPurchaseDisbursement(requestId, input, instructedBy) {
    const id = Number(requestId); const amount = Math.round(Number(input?.amount || 0) * 10000) / 10000;
    const paymentMode = input?.paymentMode === 'PURCHASING_ADVANCE' ? 'PURCHASING_ADVANCE' : 'SUPPLIER';
    if (!(amount > 0)) throw new Error('Enter a valid disbursement amount.');
    return this.transaction(() => {
      const request = this.all(`SELECT fr.*, pi.supplier_id, pi.invoice_code FROM purchase_funding_requests fr
        JOIN purchase_invoices pi ON pi.id = fr.purchase_invoice_id WHERE fr.id = ?`, [id])[0];
      if (!request || !['AUTHORIZED', 'PARTIALLY_PAID'].includes(request.status)) throw new Error('Only financially authorized funding can be sent to Treasury.');
      if (String(request.decided_by) === String(instructedBy)) throw new Error('The financial approver cannot issue the disbursement order.');
      const paid = Number(this.all(`SELECT coalesce(sum(allocated_amount), 0) AS total FROM supplier_payment_allocations spa
        JOIN supplier_payments sp ON sp.id = spa.supplier_payment_id WHERE sp.funding_request_id = ?`, [id])[0]?.total || 0);
      const ordered = Number(this.all(`SELECT coalesce(sum(amount), 0) AS total FROM purchase_disbursement_orders
        WHERE funding_request_id = ? AND status IN ('PENDING_TREASURY', 'PARTIALLY_EXECUTED')`, [id])[0]?.total || 0);
      if (amount > Number(request.requested_amount) - paid - ordered + 0.000001) throw new Error('Disbursement exceeds the authorized unallocated amount.');
      const debitAccountId = paymentMode === 'PURCHASING_ADVANCE' ? 1250
        : Number(this.all('SELECT payable_account_id FROM suppliers WHERE id = ?', [request.supplier_id])[0]?.payable_account_id || 2100);
      this.validateAccountCurrency(debitAccountId, request.currency_id, 'disbursement debit account');
      const orderNumber = this.nextDisbursementOrderNumber();
      this.database.run(`INSERT INTO purchase_disbursement_orders
        (order_number, funding_request_id, amount, currency_id, payment_mode, debit_account_id, instructed_by, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [orderNumber, id, amount, request.currency_id, paymentMode, debitAccountId,
          instructedBy, String(input?.notes || '').trim() || null]);
      const orderId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      this.audit(instructedBy, 'INSTRUCTED', 'PURCHASE_DISBURSEMENT', orderId, '', { orderNumber, requestId: id, amount, paymentMode });
      return this.getPurchaseDisbursement(orderId);
    });
  }

  getPurchaseDisbursement(orderId) {
    return this.all(`SELECT pdo.*, fr.purchase_invoice_id, fr.exchange_rate_to_base, pi.invoice_code,
        s.id AS supplier_id, s.name AS supplier_name, c.code AS currency_code, a.code AS debit_account_code,
        a.name AS debit_account_name, u.username AS instructed_by_name,
        coalesce((SELECT sum(sp.amount) FROM supplier_payments sp WHERE sp.disbursement_order_id = pdo.id), 0) AS executed_amount,
        (SELECT sp.payment_number FROM supplier_payments sp WHERE sp.disbursement_order_id = pdo.id ORDER BY sp.id DESC LIMIT 1) AS payment_number,
        (SELECT pm.name FROM supplier_payments sp JOIN payment_methods pm ON pm.id = sp.payment_method_id
          WHERE sp.disbursement_order_id = pdo.id ORDER BY sp.id DESC LIMIT 1) AS payment_account_name,
        (SELECT ex.username FROM supplier_payments sp JOIN users ex ON ex.id = sp.executed_by
          WHERE sp.disbursement_order_id = pdo.id ORDER BY sp.id DESC LIMIT 1) AS executed_by_name,
        (SELECT sp.executed_at FROM supplier_payments sp WHERE sp.disbursement_order_id = pdo.id ORDER BY sp.id DESC LIMIT 1) AS executed_at
      FROM purchase_disbursement_orders pdo JOIN purchase_funding_requests fr ON fr.id = pdo.funding_request_id
      JOIN purchase_invoices pi ON pi.id = fr.purchase_invoice_id JOIN suppliers s ON s.id = pi.supplier_id
      JOIN currencies c ON c.id = pdo.currency_id JOIN accounts a ON a.id = pdo.debit_account_id
      JOIN users u ON u.id = pdo.instructed_by WHERE pdo.id = ?`, [Number(orderId)])[0] || null;
  }

  listPurchaseDisbursements() {
    return this.all(`SELECT pdo.*, fr.purchase_invoice_id, pi.invoice_code, s.name AS supplier_name,
        c.code AS currency_code, a.code AS debit_account_code, a.name AS debit_account_name,
        u.username AS instructed_by_name,
        coalesce((SELECT sum(sp.amount) FROM supplier_payments sp WHERE sp.disbursement_order_id = pdo.id), 0) AS executed_amount,
        (SELECT sp.payment_number FROM supplier_payments sp WHERE sp.disbursement_order_id = pdo.id ORDER BY sp.id DESC LIMIT 1) AS payment_number,
        (SELECT pm.name FROM supplier_payments sp JOIN payment_methods pm ON pm.id = sp.payment_method_id
          WHERE sp.disbursement_order_id = pdo.id ORDER BY sp.id DESC LIMIT 1) AS payment_account_name
      FROM purchase_disbursement_orders pdo JOIN purchase_funding_requests fr ON fr.id = pdo.funding_request_id
      JOIN purchase_invoices pi ON pi.id = fr.purchase_invoice_id JOIN suppliers s ON s.id = pi.supplier_id
      JOIN currencies c ON c.id = pdo.currency_id JOIN accounts a ON a.id = pdo.debit_account_id
      JOIN users u ON u.id = pdo.instructed_by ORDER BY pdo.id DESC`);
  }

  executeSupplierPayment(orderId, input, executedBy) {
    const disbursementId = Number(orderId); const amount = Math.round(Number(input?.amount || 0) * 10000) / 10000;
    const paymentMethodId = Number(input?.paymentMethodId); const entryDate = String(input?.entryDate || '');
    if (!(amount > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) throw new Error('Enter a valid payment amount and date.');
    return this.transaction(() => {
      const order = this.all(`SELECT pdo.*, fr.purchase_invoice_id, fr.requested_amount, fr.exchange_rate_to_base, fr.requested_by,
          fr.status AS funding_status, fr.decided_by, pi.supplier_id, pi.invoice_code
        FROM purchase_disbursement_orders pdo JOIN purchase_funding_requests fr ON fr.id = pdo.funding_request_id
        JOIN purchase_invoices pi ON pi.id = fr.purchase_invoice_id WHERE pdo.id = ?`, [disbursementId])[0];
      if (!order || !['PENDING_TREASURY', 'PARTIALLY_EXECUTED'].includes(order.status)) throw new Error('Only a pending Accountant disbursement order can be paid.');
      const request = { ...order, id: order.funding_request_id, currency_id: order.currency_id };
      const paymentMode = order.payment_mode;
      if (String(request.decided_by) === String(executedBy)) throw new Error('The financial approver cannot execute the same payment.');
      if (String(order.instructed_by) === String(executedBy)) throw new Error('The Accountant who issued the order cannot execute it.');
      const paid = Number(this.all(`SELECT coalesce(sum(allocated_amount), 0) AS total FROM supplier_payment_allocations spa
        JOIN supplier_payments sp ON sp.id = spa.supplier_payment_id WHERE sp.funding_request_id = ?`, [request.id])[0]?.total || 0);
      const orderPaid = Number(this.all('SELECT coalesce(sum(amount), 0) AS total FROM supplier_payments WHERE disbursement_order_id = ?', [disbursementId])[0]?.total || 0);
      if (amount > Number(order.amount) - orderPaid + 0.000001) throw new Error('Payment exceeds the Accountant disbursement order.');
      if (amount + 0.000001 < Number(order.amount) - orderPaid) throw new Error('The Treasury voucher must execute the complete disbursement order amount.');
      const payment = this.all(`SELECT pm.*, a.name AS account_name FROM payment_methods pm JOIN accounts a ON a.id = pm.account_id
        WHERE pm.id = ? AND pm.is_active = 1 AND pm.method_type IN ('CASH', 'BANK')`, [paymentMethodId])[0];
      if (!payment) throw new Error('Select an active cash or bank payment method.');
      const payable = Number(order.debit_account_id);
      this.validateAccountCurrency(payable, request.currency_id, 'disbursement debit account');
      this.validateAccountCurrency(payment.account_id, request.currency_id, 'payment account');
      const baseAmount = Math.round(amount * Number(request.exchange_rate_to_base) * 10000) / 10000;
      const paymentNumber = this.nextSupplierPaymentNumber(entryDate);
      const recipientUserId = paymentMode === 'PURCHASING_ADVANCE' ? request.requested_by : null;
      this.database.run(`INSERT INTO journal_entries(entry_number, entry_date, description, source_type, source_id,
        currency_id, exchange_rate_to_base, status, created_by) VALUES (?, ?, ?, 'PAYMENT', ?, ?, ?, 'DRAFT', ?)`,
        [`JE-${paymentNumber}`, entryDate, `${paymentMode === 'PURCHASING_ADVANCE' ? 'Purchasing advance' : 'Supplier payment'} ${request.invoice_code}`, request.purchase_invoice_id,
          request.currency_id, request.exchange_rate_to_base, executedBy]);
      const journalId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      if (paymentMode === 'SUPPLIER') this.database.run(`INSERT INTO journal_lines(journal_entry_id, account_id, supplier_id, debit_base, transaction_amount,
        currency_id, exchange_rate_to_base, memo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [journalId, payable, request.supplier_id, baseAmount, amount, request.currency_id, request.exchange_rate_to_base, request.invoice_code]);
      else this.database.run(`INSERT INTO journal_lines(journal_entry_id, account_id, debit_base, transaction_amount,
        currency_id, exchange_rate_to_base, memo) VALUES (?, 1250, ?, ?, ?, ?, ?)`,
        [journalId, baseAmount, amount, request.currency_id, request.exchange_rate_to_base, `Advance to ${recipientUserId} - ${request.invoice_code}`]);
      this.database.run(`INSERT INTO journal_lines(journal_entry_id, account_id, credit_base, transaction_amount,
        currency_id, exchange_rate_to_base, memo) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [journalId, payment.account_id, baseAmount, -amount, request.currency_id, request.exchange_rate_to_base, request.invoice_code]);
      this.database.run("UPDATE journal_entries SET status = 'POSTED', posted_at = CURRENT_TIMESTAMP WHERE id = ?", [journalId]);
      this.database.run(`INSERT INTO supplier_payments(payment_number, funding_request_id, disbursement_order_id, supplier_id, payment_method_id,
        currency_id, amount, payment_mode, recipient_user_id, exchange_rate_to_base, journal_entry_id, executed_by, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [paymentNumber, request.id, disbursementId, request.supplier_id, paymentMethodId, request.currency_id,
        amount, paymentMode, recipientUserId, request.exchange_rate_to_base, journalId, executedBy, String(input?.notes || '').trim() || null]);
      const paymentId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      this.database.run(`INSERT INTO supplier_payment_allocations(supplier_payment_id, purchase_invoice_id, allocated_amount)
        VALUES (?, ?, ?)`, [paymentId, request.purchase_invoice_id, amount]);
      const fullyPaid = amount + paid + 0.000001 >= Number(request.requested_amount);
      const orderComplete = amount + orderPaid + 0.000001 >= Number(order.amount);
      this.database.run('UPDATE purchase_disbursement_orders SET status = ? WHERE id = ?', [orderComplete ? 'EXECUTED' : 'PARTIALLY_EXECUTED', disbursementId]);
      this.database.run('UPDATE purchase_funding_requests SET status = ? WHERE id = ?', [fullyPaid ? 'PAID' : 'PARTIALLY_PAID', request.id]);
      this.database.run('UPDATE purchase_invoices SET workflow_state = ? WHERE id = ?', [fullyPaid ? 'PAID' : 'PARTIALLY_PAID', request.purchase_invoice_id]);
      this.audit(executedBy, 'PAID', 'PURCHASE_DISBURSEMENT', disbursementId, '', { paymentNumber, amount, paymentMode, recipientUserId, paymentAccount: payment.account_name });
      return { id: paymentId, paymentNumber, journalId, amount, paymentMode, recipientUserId, fullyPaid, orderComplete };
    });
  }

  listGoodsReceiptQueue() {
    return this.all(`SELECT pi.id AS purchase_invoice_id, pi.invoice_code, pi.invoice_date, pi.workflow_state,
        pi.stock_warehouse_id AS warehouse_id, w.name AS warehouse_name,
        pil.id AS purchase_invoice_line_id, p.name AS product_name, u.name AS unit_name,
        pil.base_quantity AS expected_quantity,
        coalesce((SELECT sum(grl.accepted_quantity + grl.damaged_quantity) FROM goods_receipt_lines grl
          JOIN goods_receipts gr ON gr.id = grl.goods_receipt_id
          WHERE grl.purchase_invoice_line_id = pil.id AND gr.status = 'CONFIRMED'), 0) AS received_quantity
      FROM purchase_invoices pi JOIN purchase_invoice_lines pil ON pil.purchase_invoice_id = pi.id
      JOIN products p ON p.id = pil.product_id JOIN units u ON u.id = pil.unit_id
      JOIN warehouses w ON w.id = pi.stock_warehouse_id
      WHERE pi.workflow_state IN ('FUNDING_AUTHORIZED', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_RECEIVED')
      ORDER BY pi.invoice_date, pi.id, pil.id`);
  }

  nextGoodsReceiptNumber(receiptDate) {
    const prefix = `GR-${String(receiptDate).replaceAll('-', '')}-`;
    const count = Number(this.all('SELECT count(*) AS total FROM goods_receipts WHERE receipt_number LIKE ?', [`${prefix}%`])[0]?.total || 0);
    return `${prefix}${String(count + 1).padStart(4, '0')}`;
  }

  confirmGoodsReceipt(input, receivedBy) {
    const purchaseId = Number(input?.purchaseInvoiceId); const receiptDate = String(input?.receiptDate || '');
    const lines = Array.isArray(input?.lines) ? input.lines : [];
    if (!purchaseId || !/^\d{4}-\d{2}-\d{2}$/.test(receiptDate) || !lines.length) throw new Error('Invoice, date and receipt lines are required.');
    return this.transaction(() => {
      const invoice = this.all('SELECT * FROM purchase_invoices WHERE id = ?', [purchaseId])[0];
      if (!invoice || !['FUNDING_AUTHORIZED', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_RECEIVED'].includes(invoice.workflow_state))
        throw new Error('The invoice must have authorized funding before warehouse receipt.');
      const receiptNumber = this.nextGoodsReceiptNumber(receiptDate);
      this.database.run(`INSERT INTO goods_receipts(receipt_number, purchase_invoice_id, warehouse_id, receipt_date,
        delivery_note_number, status, received_by, confirmed_at, notes) VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?, CURRENT_TIMESTAMP, ?)`,
        [receiptNumber, purchaseId, invoice.stock_warehouse_id, receiptDate, String(input?.deliveryNoteNumber || '').trim() || null,
          receivedBy, String(input?.notes || '').trim() || null]);
      const receiptId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      let inventoryBase = 0;
      for (const line of lines) {
        const invoiceLineId = Number(line.purchaseInvoiceLineId);
        const accepted = Math.round(Number(line.acceptedQuantity || 0) * 1000000) / 1000000;
        const damaged = Math.round(Number(line.damagedQuantity || 0) * 1000000) / 1000000;
        const rejected = Math.round(Number(line.rejectedQuantity || 0) * 1000000) / 1000000;
        if ([accepted, damaged, rejected].some(value => value < 0) || accepted + damaged + rejected <= 0) throw new Error('Receipt quantities are invalid.');
        const source = this.all(`SELECT pil.id, pil.product_id, pil.base_quantity, plc.landed_cost_per_unit_base
          FROM purchase_invoice_lines pil JOIN purchase_line_costs plc ON plc.purchase_line_id = pil.id
          WHERE pil.id = ? AND pil.purchase_invoice_id = ?`, [invoiceLineId, purchaseId])[0];
        if (!source) throw new Error('A receipt line does not belong to this invoice.');
        const previouslyReceived = Number(this.all(`SELECT coalesce(sum(grl.accepted_quantity + grl.damaged_quantity), 0) AS total
          FROM goods_receipt_lines grl JOIN goods_receipts gr ON gr.id = grl.goods_receipt_id
          WHERE grl.purchase_invoice_line_id = ? AND gr.status = 'CONFIRMED'`, [invoiceLineId])[0]?.total || 0);
        if (accepted + damaged > Number(source.base_quantity) - previouslyReceived + 0.000001) throw new Error('Receipt exceeds the remaining invoice quantity.');
        const batch = String(line.batchCode || ''); const expiry = String(line.expiryDate || '');
        this.database.run(`INSERT INTO goods_receipt_lines(goods_receipt_id, purchase_invoice_line_id, accepted_quantity,
          rejected_quantity, damaged_quantity, batch_code, expiry_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [receiptId, invoiceLineId, accepted, rejected, damaged, batch, expiry, String(line.notes || '').trim() || null]);
        for (const [quantity, status] of [[accepted, 'AVAILABLE'], [damaged, 'DAMAGED']]) {
          if (!(quantity > 0)) continue;
          const unitCost = Number(source.landed_cost_per_unit_base);
          inventoryBase += quantity * unitCost;
          this.applyBalanceDelta(source.product_id, invoice.stock_warehouse_id, status, batch, expiry, quantity, unitCost);
          this.insertInventoryMovement({ movementDate: receiptDate, productId: source.product_id, warehouseId: invoice.stock_warehouse_id,
            movementType: 'PURCHASE', quantityChange: quantity, unitCostBase: unitCost, inventoryStatus: status,
            batchCode: batch, expiryDate: expiry, purchaseLineId: invoiceLineId, referenceCode: receiptNumber,
            notes: `Goods receipt ${receiptNumber}`, createdBy: receivedBy });
        }
      }
      if (inventoryBase > 0) {
        const payable = Number(this.all('SELECT payable_account_id FROM suppliers WHERE id = ?', [invoice.supplier_id])[0]?.payable_account_id || 2100);
        this.database.run(`INSERT INTO journal_entries(entry_number, entry_date, description, source_type, source_id,
          currency_id, exchange_rate_to_base, status, created_by) VALUES (?, ?, ?, 'PURCHASE', ?, ?, ?, 'DRAFT', ?)`,
          [`JE-${receiptNumber}`, receiptDate, `Goods receipt ${receiptNumber}`, purchaseId, invoice.currency_id, invoice.exchange_rate_to_base, receivedBy]);
        const journalId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
        this.database.run('INSERT INTO journal_lines(journal_entry_id, account_id, debit_base, memo) VALUES (?, 1300, ?, ?)', [journalId, inventoryBase, receiptNumber]);
        this.database.run('INSERT INTO journal_lines(journal_entry_id, account_id, supplier_id, credit_base, memo) VALUES (?, ?, ?, ?, ?)', [journalId, payable, invoice.supplier_id, inventoryBase, receiptNumber]);
        const advances = this.all(`SELECT sp.id, sp.amount, sp.advance_applied_amount, sp.exchange_rate_to_base
          FROM supplier_payments sp WHERE sp.funding_request_id IN
            (SELECT id FROM purchase_funding_requests WHERE purchase_invoice_id = ?)
            AND sp.payment_mode = 'PURCHASING_ADVANCE' AND sp.advance_applied_amount < sp.amount ORDER BY sp.id`, [purchaseId]);
        let unappliedReceiptBase = inventoryBase;
        let advanceAppliedBase = 0;
        for (const advance of advances) {
          if (unappliedReceiptBase <= 0.000001) break;
          const rate = Number(advance.exchange_rate_to_base);
          const availableTransaction = Number(advance.amount) - Number(advance.advance_applied_amount);
          const appliedTransaction = Math.min(availableTransaction, unappliedReceiptBase / rate);
          const appliedBase = Math.round(appliedTransaction * rate * 10000) / 10000;
          this.database.run('UPDATE supplier_payments SET advance_applied_amount = advance_applied_amount + ? WHERE id = ?', [appliedTransaction, advance.id]);
          unappliedReceiptBase -= appliedBase; advanceAppliedBase += appliedBase;
        }
        if (advanceAppliedBase > 0.000001) {
          this.database.run('INSERT INTO journal_lines(journal_entry_id, account_id, supplier_id, debit_base, memo) VALUES (?, ?, ?, ?, ?)', [journalId, payable, invoice.supplier_id, advanceAppliedBase, `Apply purchasing advance - ${receiptNumber}`]);
          this.database.run('INSERT INTO journal_lines(journal_entry_id, account_id, credit_base, memo) VALUES (?, 1250, ?, ?)', [journalId, advanceAppliedBase, `Clear purchasing advance - ${receiptNumber}`]);
        }
        this.database.run("UPDATE journal_entries SET status = 'POSTED', posted_at = CURRENT_TIMESTAMP WHERE id = ?", [journalId]);
        if (!invoice.journal_entry_id) this.database.run('UPDATE purchase_invoices SET journal_entry_id = ? WHERE id = ?', [journalId, purchaseId]);
      }
      const remaining = Number(this.all(`SELECT coalesce(sum(pil.base_quantity),0) - coalesce(sum((SELECT coalesce(sum(grl.accepted_quantity + grl.damaged_quantity),0)
        FROM goods_receipt_lines grl JOIN goods_receipts gr ON gr.id = grl.goods_receipt_id WHERE grl.purchase_invoice_line_id = pil.id AND gr.status = 'CONFIRMED')),0) AS remaining
        FROM purchase_invoice_lines pil WHERE pil.purchase_invoice_id = ?`, [purchaseId])[0]?.remaining || 0);
      const complete = remaining <= 0.000001;
      const funding = this.all('SELECT status FROM purchase_funding_requests WHERE purchase_invoice_id = ? ORDER BY id DESC LIMIT 1', [purchaseId])[0];
      const workflow = complete ? (funding?.status === 'PAID' ? 'SETTLED' : 'RECEIVED') : 'PARTIALLY_RECEIVED';
      this.database.run(`UPDATE purchase_invoices SET workflow_state = ?, status = ?, stock_posted_by = ?,
        stock_posted_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE stock_posted_at END WHERE id = ?`,
        [workflow, complete ? 'RECEIVED' : 'DRAFT', receivedBy, complete ? 1 : 0, purchaseId]);
      if (invoice.purchase_order_id) this.refreshPurchaseOrderStatus(invoice.purchase_order_id);
      this.audit(receivedBy, 'CONFIRMED', 'GOODS_RECEIPT', receiptId, '', { receiptNumber, purchaseId });
      return { id: receiptId, receiptNumber, complete, workflow };
    });
  }

  getPricingWorkspace() {
    return this.all(`SELECT p.id AS product_id, p.name AS product_name, p.sku, w.id AS warehouse_id, w.name AS warehouse_name,
        stock.quantity_available, CASE WHEN stock.quantity_available > 0 THEN stock.available_value_base / stock.quantity_available ELSE 0 END AS landed_cost_base,
        active.id AS price_version_id, active.pricing_method, active.markup_percent, active.published_price,
        active.minimum_sale_price, active.effective_from, active.published_at
      FROM products p CROSS JOIN warehouses w JOIN inventory_stock stock ON stock.product_id = p.id AND stock.warehouse_id = w.id
      LEFT JOIN product_price_versions active ON active.id = (SELECT ppv.id FROM product_price_versions ppv
        WHERE ppv.product_id = p.id AND ppv.status = 'PUBLISHED' AND (ppv.warehouse_id = w.id OR ppv.warehouse_id IS NULL)
        ORDER BY ppv.warehouse_id IS NOT NULL DESC, ppv.published_at DESC, ppv.id DESC LIMIT 1)
      WHERE p.is_active = 1 AND w.is_active = 1 AND stock.quantity_on_hand > 0
      ORDER BY p.name COLLATE NOCASE, w.name COLLATE NOCASE`);
  }

  publishProductPrice(input, publishedBy) {
    const productId = Number(input?.productId); const warehouseId = Number(input?.warehouseId) || null;
    const method = input?.pricingMethod === 'MARKUP' ? 'MARKUP' : 'MANUAL'; const manual = Number(input?.manualPrice);
    const markup = Number(input?.markupPercent || 0); const effectiveFrom = String(input?.effectiveFrom || new Date().toISOString().slice(0, 10));
    if (!productId || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw new Error('Product and effective date are required.');
    return this.transaction(() => {
      const product = this.all('SELECT id FROM products WHERE id = ? AND is_active = 1', [productId])[0];
      if (!product) throw new Error('Product was not found.');
      const stock = this.all(`SELECT quantity_available, available_value_base FROM inventory_stock
        WHERE product_id = ? AND warehouse_id = ?`, [productId, warehouseId || 1])[0];
      const cost = Number(stock?.quantity_available || 0) > 0 ? Number(stock.available_value_base) / Number(stock.quantity_available) : 0;
      const price = method === 'MARKUP' ? Math.round(cost * (1 + markup / 100) * 10000) / 10000 : Math.round(manual * 10000) / 10000;
      if (!(price > 0) || (method === 'MARKUP' && !(markup >= 0))) throw new Error('Published selling price must be greater than zero.');
      this.database.run(`UPDATE product_price_versions SET status = 'EXPIRED', effective_to = ?
        WHERE product_id = ? AND status = 'PUBLISHED' AND coalesce(warehouse_id, 0) = coalesce(?, 0)`, [effectiveFrom, productId, warehouseId]);
      this.database.run(`INSERT INTO product_price_versions(product_id, warehouse_id, currency_id, cost_snapshot_base,
        pricing_method, markup_percent, published_price, minimum_sale_price, status, effective_from, notes,
        created_by, published_by, published_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'PUBLISHED', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [productId, warehouseId, cost, method, method === 'MARKUP' ? markup : null, price, price, effectiveFrom,
          String(input?.notes || '').trim() || null, publishedBy, publishedBy]);
      const id = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      this.audit(publishedBy, 'PUBLISHED', 'PRODUCT_PRICE', id, String(input?.notes || ''), { productId, warehouseId, cost, price, method, markup });
      return this.all('SELECT * FROM product_price_versions WHERE id = ?', [id])[0];
    });
  }

  getPurchase(purchaseId) {
    const header = this.all(`SELECT pi.*, coalesce((SELECT im.warehouse_id FROM inventory_movements im JOIN purchase_invoice_lines x ON x.id = im.purchase_line_id WHERE x.purchase_invoice_id = pi.id LIMIT 1), pi.stock_warehouse_id) AS warehouse_id, s.name AS supplier_name, c.code AS currency_code, po.po_number,
        pit.goods_total, pit.additional_cost_total, pit.landed_total
      FROM purchase_invoices pi JOIN suppliers s ON s.id = pi.supplier_id JOIN currencies c ON c.id = pi.currency_id
      LEFT JOIN purchase_orders po ON po.id = pi.purchase_order_id
      JOIN purchase_invoice_totals pit ON pit.purchase_invoice_id = pi.id WHERE pi.id = ?`, [purchaseId])[0];
    if (!header) return null;
    return {
      ...header,
      lines: this.all(`SELECT plc.*, p.name AS product_name, u.name AS unit_name, pl.quantity, pl.unit_quantity,
          pl.pricing_method, pl.manual_sales_price, pl.markup_percent, pl.purchase_order_line_id
        FROM purchase_line_costs plc JOIN purchase_invoice_lines pl ON pl.id = plc.purchase_line_id
        JOIN products p ON p.id = pl.product_id JOIN units u ON u.id = pl.unit_id
        WHERE plc.purchase_invoice_id = ? ORDER BY pl.id`, [purchaseId]),
      costs: this.all(`SELECT pac.*, act.name AS cost_type_name, c.code AS currency_code,
          coalesce(cs.name, s.name) AS cost_supplier_name, je.entry_number AS journal_entry_number
        FROM purchase_additional_costs pac JOIN additional_cost_types act ON act.id = pac.cost_type_id
        JOIN currencies c ON c.id = pac.currency_id
        JOIN purchase_invoices pi ON pi.id = pac.purchase_invoice_id
        JOIN suppliers s ON s.id = pi.supplier_id
        LEFT JOIN suppliers cs ON cs.id = pac.supplier_id
        LEFT JOIN journal_entries je ON je.id = pac.journal_entry_id
        WHERE pac.purchase_invoice_id = ? ORDER BY pac.id`, [purchaseId]),
      attachments: this.listInvoiceAttachments('PURCHASE', purchaseId)
    };
  }

  addPurchaseAdditionalCost(purchaseId, input, createdBy) {
    const id = Number(purchaseId);
    const invoiceDate = String(input?.invoiceDate || '');
    const costTypeId = Number(input?.costTypeId);
    const supplierId = Number(input?.supplierId);
    const currencyId = Number(input?.currencyId);
    const amount = Number(input?.amount);
    const exchangeRate = Number(input?.exchangeRate);
    if (!id || !costTypeId || !supplierId || !currencyId) throw new Error('Cost supplier, cost type and currency are required.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) throw new Error('Enter a valid additional-cost invoice date.');
    if (!(amount > 0)) throw new Error('Additional-cost amount must be greater than zero.');
    if (!(exchangeRate > 0)) throw new Error('Exchange rate must be greater than zero.');

    return this.transaction(() => {
      const purchase = this.all(`SELECT pi.id, pi.invoice_code, pi.status, pi.supplier_id
        FROM purchase_invoices pi WHERE pi.id = ?`, [id])[0];
      if (!purchase) throw new Error('Purchase invoice was not found.');
      if (purchase.status === 'VOID') throw new Error('Additional costs cannot be added to a void purchase invoice.');
      const invoiceNumber = this.nextPurchaseCostCode(invoiceDate);
      const costType = this.all('SELECT id, inventory_account_id FROM additional_cost_types WHERE id = ? AND is_active = 1', [costTypeId])[0];
      const supplier = this.all('SELECT id, payable_account_id FROM suppliers WHERE id = ? AND is_active = 1', [supplierId])[0];
      const currency = this.all('SELECT id FROM currencies WHERE id = ? AND is_active = 1', [currencyId])[0];
      if (!costType || !supplier || !currency) throw new Error('The selected cost type, supplier or currency is invalid.');

      this.database.run(`INSERT INTO purchase_additional_costs
        (purchase_invoice_id, cost_type_id, description, amount, currency_id, exchange_rate_to_base,
         reference_code, cost_invoice_date, supplier_id, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, [id, costTypeId,
        String(input?.description || '').trim() || null, amount, currencyId, exchangeRate,
        invoiceNumber, invoiceDate, supplierId, createdBy]);
      const costId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);

      if (purchase.status === 'RECEIVED') {
        const amountBase = amount * exchangeRate;
        const entryNumber = `JE-COST-${purchase.invoice_code}-${costId}`;
        this.database.run(`INSERT INTO journal_entries
          (entry_number, entry_date, description, source_type, source_id, currency_id, exchange_rate_to_base, status, created_by)
          VALUES (?, ?, ?, 'PURCHASE', ?, ?, ?, 'DRAFT', ?)`, [entryNumber, invoiceDate,
          `Additional cost ${invoiceNumber} for ${purchase.invoice_code}`, id, currencyId, exchangeRate, createdBy]);
        const journalId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
        this.database.run(`INSERT INTO journal_lines
          (journal_entry_id, account_id, debit_base, transaction_amount, currency_id, exchange_rate_to_base, memo)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [journalId, Number(costType.inventory_account_id || 1300), amountBase,
          amount, currencyId, exchangeRate, `Additional cost ${invoiceNumber} - ${purchase.invoice_code}`]);
        this.database.run(`INSERT INTO journal_lines
          (journal_entry_id, account_id, credit_base, transaction_amount, currency_id, exchange_rate_to_base, memo)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [journalId, Number(supplier.payable_account_id || 2100), amountBase,
          -amount, currencyId, exchangeRate, `Cost supplier payable - ${invoiceNumber}`]);
        this.database.run(`UPDATE journal_entries SET status = 'POSTED', posted_at = CURRENT_TIMESTAMP WHERE id = ?`, [journalId]);
        this.database.run('UPDATE purchase_additional_costs SET journal_entry_id = ? WHERE id = ?', [journalId, costId]);
        this.database.run(`UPDATE inventory_movements
          SET unit_cost_base = coalesce((SELECT plc.landed_cost_per_unit_base FROM purchase_line_costs plc
              WHERE plc.purchase_line_id = inventory_movements.purchase_line_id), unit_cost_base)
          WHERE movement_type = 'PURCHASE' AND purchase_line_id IN
            (SELECT id FROM purchase_invoice_lines WHERE purchase_invoice_id = ?)`, [id]);
        const affected = this.all(`SELECT DISTINCT product_id, warehouse_id FROM inventory_movements
          WHERE movement_type = 'PURCHASE' AND purchase_line_id IN
            (SELECT id FROM purchase_invoice_lines WHERE purchase_invoice_id = ?)`, [id]);
        for (const row of affected) this.rebuildBalancesFor(row.product_id, row.warehouse_id);
      }
      return this.getPurchase(id);
    });
  }

  rebuildBalancesFor(productId, warehouseId) {
    this.database.run('DELETE FROM inventory_balances WHERE product_id = ? AND warehouse_id = ?',
      [Number(productId), Number(warehouseId)]);
    const movements = this.all(`SELECT product_id, warehouse_id, quantity_change, unit_cost_base,
        coalesce(inventory_status, 'AVAILABLE') AS inventory_status,
        coalesce(batch_code, '') AS batch_code, coalesce(expiry_date, '') AS expiry_date
      FROM inventory_movements WHERE product_id = ? AND warehouse_id = ? ORDER BY id`,
      [Number(productId), Number(warehouseId)]);
    for (const movement of movements) {
      this.applyBalanceDelta(movement.product_id, movement.warehouse_id, movement.inventory_status,
        movement.batch_code, movement.expiry_date, Number(movement.quantity_change), Number(movement.unit_cost_base),
        { allowNegative: true, allowCreateNegative: true });
    }
  }

  getPurchaseReport() { return this.listPurchases(); }

  getReport(reportId, filters = {}) {
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(filters.fromDate || '')) ? String(filters.fromDate) : null;
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(filters.toDate || '')) ? String(filters.toDate) : null;
    const accountId = Number(filters.accountId) || null;
    const requestedStatus = filters.accountStatus == null ? 'POSTED' : String(filters.accountStatus).toUpperCase();
    const accountFilters = {
      search: String(filters.accountSearch || '').trim(),
      sourceType: ['MANUAL', 'RECEIPT', 'PAYMENT', 'PURCHASE', 'SALE', 'INVENTORY', 'OPENING'].includes(String(filters.accountSourceType || '').toUpperCase()) ? String(filters.accountSourceType).toUpperCase() : '',
      status: ['POSTED', 'DRAFT', 'VOID'].includes(requestedStatus) ? requestedStatus : '',
      movement: ['debit', 'credit'].includes(String(filters.accountMovement || '').toLowerCase()) ? String(filters.accountMovement).toLowerCase() : '',
      currencyId: Number(filters.accountCurrencyId) || null,
      partyType: ['customer', 'supplier'].includes(String(filters.accountPartyType || '').toLowerCase()) ? String(filters.accountPartyType).toLowerCase() : '',
      partyId: Number(filters.accountPartyId) || null,
      scope: filters.accountScope === 'direct' ? 'direct' : 'descendants',
      amountBasis: filters.accountAmountBasis === 'transaction' ? 'transaction' : 'base',
      sort: filters.accountSort === 'desc' ? 'desc' : 'asc',
      minAmount: filters.accountMinAmount === '' || filters.accountMinAmount == null ? null : Number(filters.accountMinAmount),
      maxAmount: filters.accountMaxAmount === '' || filters.accountMaxAmount == null ? null : Number(filters.accountMaxAmount)
    };
    if (accountFilters.minAmount != null && (!Number.isFinite(accountFilters.minAmount) || accountFilters.minAmount < 0)) throw new Error('Minimum statement amount must be zero or greater.');
    if (accountFilters.maxAmount != null && (!Number.isFinite(accountFilters.maxAmount) || accountFilters.maxAmount < 0)) throw new Error('Maximum statement amount must be zero or greater.');
    if (accountFilters.minAmount != null && accountFilters.maxAmount != null && accountFilters.minAmount > accountFilters.maxAmount) throw new Error('Minimum statement amount cannot exceed maximum amount.');
    const inventoryFilters = {
      search: String(filters.search || '').trim(),
      warehouseId: Number(filters.warehouseId) || null,
      category: String(filters.category || '').trim(),
      stockStatus: ['in_stock', 'low_stock', 'out_of_stock'].includes(filters.stockStatus) ? filters.stockStatus : '',
      minQuantity: filters.minQuantity === '' || filters.minQuantity == null ? null : Number(filters.minQuantity),
      maxQuantity: filters.maxQuantity === '' || filters.maxQuantity == null ? null : Number(filters.maxQuantity),
      minValue: filters.minValue === '' || filters.minValue == null ? null : Number(filters.minValue),
      maxValue: filters.maxValue === '' || filters.maxValue == null ? null : Number(filters.maxValue),
      hasSalvage: filters.hasSalvage === true || filters.hasSalvage === 'true'
    };
    for (const key of ['minQuantity', 'maxQuantity', 'minValue', 'maxValue']) {
      if (inventoryFilters[key] != null && !Number.isFinite(inventoryFilters[key])) throw new Error('Inventory range filters must be valid numbers.');
    }
    if (inventoryFilters.minQuantity != null && inventoryFilters.maxQuantity != null && inventoryFilters.minQuantity > inventoryFilters.maxQuantity) throw new Error('Minimum quantity cannot exceed maximum quantity.');
    if (inventoryFilters.minValue != null && inventoryFilters.maxValue != null && inventoryFilters.minValue > inventoryFilters.maxValue) throw new Error('Minimum value cannot exceed maximum value.');
    if (fromDate && toDate && fromDate > toDate) throw new Error('The report start date cannot be after the end date.');
    const period = fromDate || toDate ? `${fromDate || 'Beginning'} to ${toDate || 'Today'}` : 'All available dates';
    const builders = {
      journal_account: () => this.buildJournalAccount(fromDate, toDate, accountId, accountFilters),
      trial_balance: () => this.buildTrialBalance(toDate),
      profit_loss: () => this.buildProfitAndLoss(fromDate, toDate),
      balance_sheet: () => this.buildBalanceSheet(toDate),
      cash_flow: () => this.buildCashFlow(fromDate, toDate),
      owners_equity: () => this.buildOwnersEquity(fromDate, toDate),
      sales_register: () => this.buildSalesRegister(fromDate, toDate),
      purchase_register: () => this.buildPurchaseRegister(fromDate, toDate),
      inventory_valuation: () => this.buildInventoryValuation(inventoryFilters),
      operational_workflow: () => this.buildOperationalWorkflow(fromDate, toDate)
    };
    if (!builders[reportId]) throw new Error('Unknown report type.');
    const report = builders[reportId]();
    return { ...report, id: reportId, filterDescription: report.filterDescription || (['trial_balance', 'balance_sheet', 'inventory_valuation'].includes(reportId)
      ? (toDate ? `As of ${toDate}` : 'As of today') : period), filters: { fromDate, toDate, accountId, ...accountFilters, ...inventoryFilters } };
  }

  buildTrialBalance(toDate) {
    const rows = this.all(`SELECT a.code, a.name AS account, a.account_type,
        round(coalesce(sum(CASE WHEN je.status = 'POSTED' THEN jl.debit_base ELSE 0 END), 0), 4) AS debit,
        round(coalesce(sum(CASE WHEN je.status = 'POSTED' THEN jl.credit_base ELSE 0 END), 0), 4) AS credit
      FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id = a.id
      LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id AND (? IS NULL OR je.entry_date <= ?)
      WHERE a.is_active = 1 AND a.is_control = 0 GROUP BY a.id ORDER BY a.code`, [toDate, toDate]);
    const totalDebit = rows.reduce((sum, row) => sum + Number(row.debit), 0);
    const totalCredit = rows.reduce((sum, row) => sum + Number(row.credit), 0);
    return { title: 'Trial Balance', subtitle: 'Posted debit and credit balances by account', orientation: 'portrait',
      columns: [{ key: 'code', label: 'Code' }, { key: 'account', label: 'Account' }, { key: 'account_type', label: 'Type' }, { key: 'debit', label: 'Debit SDG', type: 'money' }, { key: 'credit', label: 'Credit SDG', type: 'money' }], rows,
      summary: [{ label: 'Total debit', value: totalDebit, type: 'money', suffix: 'SDG' }, { label: 'Total credit', value: totalCredit, type: 'money', suffix: 'SDG' }, { label: 'Difference', value: totalDebit - totalCredit, type: 'money', suffix: 'SDG' }] };
  }

  incomeStatementValues(fromDate, toDate, exclusiveToDate = null) {
    const periodClauses = []; const periodParameters = [];
    if (fromDate) { periodClauses.push('movement_date >= ?'); periodParameters.push(fromDate); }
    if (exclusiveToDate) { periodClauses.push('movement_date < ?'); periodParameters.push(exclusiveToDate); }
    else if (toDate) { periodClauses.push('movement_date <= ?'); periodParameters.push(toDate); }
    const movementPeriod = periodClauses.length ? `WHERE ${periodClauses.join(' AND ')}` : '';
    const openingInventory = fromDate ? Number(this.all(`SELECT round(coalesce(sum(CASE WHEN quantity_change > 0 THEN total_cost_base ELSE -total_cost_base END), 0), 4) AS value
      FROM inventory_movements WHERE movement_date < ?`, [fromDate])[0]?.value || 0) : 0;
    const endingClauses = []; const endingParameters = [];
    if (exclusiveToDate) { endingClauses.push('movement_date < ?'); endingParameters.push(exclusiveToDate); }
    else if (toDate) { endingClauses.push('movement_date <= ?'); endingParameters.push(toDate); }
    const endingWhere = endingClauses.length ? `WHERE ${endingClauses.join(' AND ')}` : '';
    const endingInventory = Number(this.all(`SELECT round(coalesce(sum(CASE WHEN quantity_change > 0 THEN total_cost_base ELSE -total_cost_base END), 0), 4) AS value
      FROM inventory_movements ${endingWhere}`, endingParameters)[0]?.value || 0);
    const purchaseWhere = movementPeriod ? `${movementPeriod} AND movement_type = 'PURCHASE'` : `WHERE movement_type = 'PURCHASE'`;
    const purchases = Number(this.all(`SELECT round(coalesce(sum(total_cost_base), 0), 4) AS value FROM inventory_movements ${purchaseWhere}`, periodParameters)[0]?.value || 0);

    const journalClauses = [`je.status = 'POSTED'`]; const journalParameters = [];
    if (fromDate) { journalClauses.push('je.entry_date >= ?'); journalParameters.push(fromDate); }
    if (exclusiveToDate) { journalClauses.push('je.entry_date < ?'); journalParameters.push(exclusiveToDate); }
    else if (toDate) { journalClauses.push('je.entry_date <= ?'); journalParameters.push(toDate); }
    const revenue = Number(this.all(`SELECT round(coalesce(sum(jl.credit_base - jl.debit_base), 0), 4) AS value
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
      JOIN accounts a ON a.id = jl.account_id WHERE ${journalClauses.join(' AND ')} AND a.account_type = 'REVENUE'`, journalParameters)[0]?.value || 0);
    const operatingExpenses = Number(this.all(`SELECT round(coalesce(sum(jl.debit_base - jl.credit_base), 0), 4) AS value
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
      JOIN accounts a ON a.id = jl.account_id WHERE ${journalClauses.join(' AND ')} AND a.account_type = 'EXPENSE' AND a.code <> '5100'`, journalParameters)[0]?.value || 0);
    const costOfGoodsSold = openingInventory + purchases - endingInventory;
    const grossProfit = revenue - costOfGoodsSold;
    return { openingInventory, purchases, endingInventory, costOfGoodsSold, revenue, operatingExpenses,
      grossProfit, netIncome: grossProfit - operatingExpenses };
  }

  buildProfitAndLoss(fromDate, toDate) {
    const values = this.incomeStatementValues(fromDate, toDate);
    const rows = [
      { section: 'Revenue', calculation: 'Sales and other revenue', amount: values.revenue },
      { section: 'Beginning inventory', calculation: fromDate ? `Inventory before ${fromDate}` : 'Beginning of available records', amount: values.openingInventory },
      { section: 'New purchases', calculation: 'Received inventory during the period', amount: values.purchases },
      { section: 'Goods available', calculation: 'Beginning inventory + New purchases', amount: values.openingInventory + values.purchases },
      { section: 'Ending inventory', calculation: 'Inventory at the end of the period', amount: values.endingInventory },
      { section: 'Cost of goods sold', calculation: 'Beginning inventory + New purchases - Ending inventory', amount: values.costOfGoodsSold },
      { section: 'Gross profit', calculation: 'Revenue - Cost of goods sold', amount: values.grossProfit },
      { section: 'Operating expenses', calculation: 'Posted expenses excluding cost of goods sold', amount: values.operatingExpenses },
      { section: 'Net income', calculation: 'Gross profit - Operating expenses', amount: values.netIncome }
    ];
    return { title: 'Income Statement', subtitle: 'Revenue, inventory-based cost of goods sold, expenses and net income', orientation: 'portrait',
      columns: [{ key: 'section', label: 'Section' }, { key: 'calculation', label: 'Calculation' }, { key: 'amount', label: 'Amount SDG', type: 'money' }], rows,
      summary: [{ label: 'Revenue', value: values.revenue, type: 'money', suffix: 'SDG' }, { label: 'Cost of goods sold', value: values.costOfGoodsSold, type: 'money', suffix: 'SDG' },
        { label: 'Gross profit', value: values.grossProfit, type: 'money', suffix: 'SDG' }, { label: 'Operating expenses', value: values.operatingExpenses, type: 'money', suffix: 'SDG' },
        { label: 'Net income', value: values.netIncome, type: 'money', suffix: 'SDG' }] };
  }

  buildBalanceSheet(toDate) {
    const rows = this.all(`SELECT a.code, a.name AS account, a.account_type AS section,
        round(CASE WHEN a.normal_balance = 'DEBIT'
          THEN coalesce(sum(CASE WHEN je.status = 'POSTED' THEN jl.debit_base - jl.credit_base ELSE 0 END), 0)
          ELSE coalesce(sum(CASE WHEN je.status = 'POSTED' THEN jl.credit_base - jl.debit_base ELSE 0 END), 0) END, 4) AS amount
      FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id = a.id
      LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id AND (? IS NULL OR je.entry_date <= ?)
      WHERE a.is_active = 1 AND a.is_control = 0 AND a.account_type IN ('ASSET', 'LIABILITY', 'EQUITY')
      GROUP BY a.id ORDER BY CASE a.account_type WHEN 'ASSET' THEN 1 WHEN 'LIABILITY' THEN 2 ELSE 3 END, a.code`, [toDate, toDate]);
    const earnings = this.incomeStatementValues(null, toDate).netIncome;
    rows.push({ code: 'CURRENT', account: 'Current Earnings', section: 'EQUITY', amount: earnings });
    const assets = rows.filter(row => row.section === 'ASSET').reduce((sum, row) => sum + Number(row.amount), 0);
    const liabilities = rows.filter(row => row.section === 'LIABILITY').reduce((sum, row) => sum + Number(row.amount), 0);
    const equity = rows.filter(row => row.section === 'EQUITY').reduce((sum, row) => sum + Number(row.amount), 0);
    return { title: 'Statement of Financial Position', subtitle: 'Assets, liabilities and equity at the reporting date', orientation: 'portrait',
      columns: [{ key: 'section', label: 'Section' }, { key: 'code', label: 'Code' }, { key: 'account', label: 'Account' }, { key: 'amount', label: 'Balance SDG', type: 'money' }], rows,
      summary: [{ label: 'Assets', value: assets, type: 'money', suffix: 'SDG' }, { label: 'Liabilities', value: liabilities, type: 'money', suffix: 'SDG' }, { label: 'Equity and earnings', value: equity, type: 'money', suffix: 'SDG' }, { label: 'Difference', value: assets - liabilities - equity, type: 'money', suffix: 'SDG' }] };
  }

  buildJournalAccount(fromDate, toDate, accountId, filters = {}) {
    const account = this.all('SELECT id, code, name, normal_balance, is_control FROM accounts WHERE id = ? AND is_active = 1', [accountId])[0];
    if (!account) throw new Error('Select an account for this statement.');
    if (filters.partyId && !filters.partyType) throw new Error('Select a party type before selecting a party.');
    const useDescendants = filters.scope !== 'direct';
    const accountPredicate = useDescendants ? 'jl.account_id IN (SELECT id FROM descendants)' : 'jl.account_id = ?';
    const statusPredicate = filters.status ? 'je.status = ?' : '1 = 1';
    const openingParameters = [account.id, account.normal_balance];
    if (!useDescendants) openingParameters.push(account.id);
    if (filters.status) openingParameters.push(filters.status);
    openingParameters.push(fromDate);
    const opening = fromDate ? Number(this.all(`WITH RECURSIVE descendants(id) AS (
        SELECT id FROM accounts WHERE id = ?
        UNION ALL SELECT a.id FROM accounts a JOIN descendants d ON a.parent_id = d.id WHERE a.is_active = 1
      ) SELECT round(coalesce(sum(CASE WHEN ? = 'DEBIT' THEN jl.debit_base - jl.credit_base ELSE jl.credit_base - jl.debit_base END), 0), 4) AS value
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE ${accountPredicate} AND ${statusPredicate} AND je.entry_date < ?`, openingParameters)[0]?.value || 0) : 0;

    const clauses = [accountPredicate, statusPredicate, '(? IS NULL OR je.entry_date >= ?)', '(? IS NULL OR je.entry_date <= ?)'];
    const parameters = [account.id];
    if (!useDescendants) parameters.push(account.id);
    if (filters.status) parameters.push(filters.status);
    parameters.push(fromDate, fromDate, toDate, toDate);
    if (filters.sourceType) { clauses.push('je.source_type = ?'); parameters.push(filters.sourceType); }
    if (filters.movement === 'debit') clauses.push('jl.debit_base > 0');
    if (filters.movement === 'credit') clauses.push('jl.credit_base > 0');
    if (filters.currencyId) {
      clauses.push(`coalesce(jl.currency_id, (SELECT id FROM currencies WHERE is_base = 1 LIMIT 1)) = ?`);
      parameters.push(filters.currencyId);
    }
    if (filters.partyType === 'customer') {
      clauses.push(filters.partyId
        ? 'EXISTS (SELECT 1 FROM journal_lines party_line WHERE party_line.journal_entry_id = je.id AND party_line.customer_id = ?)'
        : 'EXISTS (SELECT 1 FROM journal_lines party_line WHERE party_line.journal_entry_id = je.id AND party_line.customer_id IS NOT NULL)');
      if (filters.partyId) parameters.push(filters.partyId);
    }
    if (filters.partyType === 'supplier') {
      clauses.push(filters.partyId
        ? 'EXISTS (SELECT 1 FROM journal_lines party_line WHERE party_line.journal_entry_id = je.id AND party_line.supplier_id = ?)'
        : 'EXISTS (SELECT 1 FROM journal_lines party_line WHERE party_line.journal_entry_id = je.id AND party_line.supplier_id IS NOT NULL)');
      if (filters.partyId) parameters.push(filters.partyId);
    }
    const amountExpression = filters.amountBasis === 'transaction'
      ? `abs(coalesce(jl.transaction_amount, CASE WHEN jl.debit_base > 0 THEN jl.debit_base ELSE jl.credit_base END))`
      : `CASE WHEN jl.debit_base > 0 THEN jl.debit_base ELSE jl.credit_base END`;
    if (filters.minAmount != null) { clauses.push(`${amountExpression} >= ?`); parameters.push(filters.minAmount); }
    if (filters.maxAmount != null) { clauses.push(`${amountExpression} <= ?`); parameters.push(filters.maxAmount); }
    if (filters.search) {
      clauses.push(`lower(je.entry_number || ' ' || je.description || ' ' || coalesce(jl.memo, '') || ' ' ||
        a.code || ' ' || a.name || ' ' || coalesce(p.name, '') || ' ' ||
        coalesce(cu.code || ' ' || cu.name, '') || ' ' || coalesce(su.code || ' ' || su.name, '') || ' ' ||
        coalesce((SELECT group_concat(coalesce(pcu.code || ' ' || pcu.name, psu.code || ' ' || psu.name), ' ')
          FROM journal_lines pjl LEFT JOIN customers pcu ON pcu.id = pjl.customer_id
          LEFT JOIN suppliers psu ON psu.id = pjl.supplier_id
          WHERE pjl.journal_entry_id = je.id AND (pjl.customer_id IS NOT NULL OR pjl.supplier_id IS NOT NULL)), '') || ' ' ||
        coalesce((SELECT group_concat(oa.code || ' ' || oa.name, ' ') FROM journal_lines ojl
          JOIN accounts oa ON oa.id = ojl.account_id WHERE ojl.journal_entry_id = je.id AND ojl.id <> jl.id), '')) LIKE ?`);
      parameters.push(`%${filters.search.toLowerCase()}%`);
    }
    const lines = this.all(`WITH RECURSIVE descendants(id) AS (
        SELECT id FROM accounts WHERE id = ?
        UNION ALL SELECT a.id FROM accounts a JOIN descendants d ON a.parent_id = d.id WHERE a.is_active = 1
      ) SELECT je.entry_date, je.entry_number, je.description AS entry_description, je.source_type,
        je.source_id, je.status AS entry_status, creator.username AS created_by_name,
        a.code AS account_code, a.name AS account_name, jl.memo, jl.debit_base, jl.credit_base,
        jl.transaction_amount, jl.exchange_rate_to_base,
        coalesce(currency.code, base_currency.code) AS transaction_currency,
        CASE WHEN jl.debit_base > 0 THEN abs(coalesce(jl.transaction_amount, jl.debit_base)) ELSE 0 END AS transaction_debit,
        CASE WHEN jl.credit_base > 0 THEN abs(coalesce(jl.transaction_amount, jl.credit_base)) ELSE 0 END AS transaction_credit,
        coalesce(cu.code || ' - ' || cu.name, su.code || ' - ' || su.name,
          (SELECT coalesce(pcu.code || ' - ' || pcu.name, psu.code || ' - ' || psu.name)
           FROM journal_lines pjl LEFT JOIN customers pcu ON pcu.id = pjl.customer_id
           LEFT JOIN suppliers psu ON psu.id = pjl.supplier_id
           WHERE pjl.journal_entry_id = je.id AND (pjl.customer_id IS NOT NULL OR pjl.supplier_id IS NOT NULL)
           ORDER BY pjl.id LIMIT 1), '-') AS party,
        CASE WHEN EXISTS (SELECT 1 FROM journal_lines pjl WHERE pjl.journal_entry_id = je.id AND pjl.customer_id IS NOT NULL) THEN 'Customer'
             WHEN EXISTS (SELECT 1 FROM journal_lines pjl WHERE pjl.journal_entry_id = je.id AND pjl.supplier_id IS NOT NULL) THEN 'Supplier'
             ELSE '-' END AS party_type,
        coalesce(p.name, (SELECT product.name FROM journal_lines product_line JOIN products product ON product.id = product_line.product_id
          WHERE product_line.journal_entry_id = je.id LIMIT 1), '-') AS product,
        coalesce((SELECT group_concat(oa.code || ' - ' || oa.name, '; ') FROM journal_lines ojl
          JOIN accounts oa ON oa.id = ojl.account_id WHERE ojl.journal_entry_id = je.id AND ojl.id <> jl.id), '-') AS counter_accounts
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id JOIN accounts a ON a.id = jl.account_id
      LEFT JOIN currencies currency ON currency.id = jl.currency_id
      LEFT JOIN currencies base_currency ON base_currency.is_base = 1
      LEFT JOIN customers cu ON cu.id = jl.customer_id LEFT JOIN suppliers su ON su.id = jl.supplier_id
      LEFT JOIN products p ON p.id = jl.product_id LEFT JOIN users creator ON creator.id = je.created_by
      WHERE ${clauses.join(' AND ')}
      ORDER BY je.entry_date, je.id, jl.id`, parameters);
    let running = opening;
    const chronologicalRows = lines.map(line => {
      running += account.normal_balance === 'DEBIT' ? Number(line.debit_base) - Number(line.credit_base) : Number(line.credit_base) - Number(line.debit_base);
      return { ...line, description: line.memo || line.entry_description, running_balance: Math.round(running * 10000) / 10000 };
    });
    const rows = filters.sort === 'desc' ? [...chronologicalRows].reverse() : chronologicalRows;
    const debit = chronologicalRows.reduce((sum, row) => sum + Number(row.debit_base), 0);
    const credit = chronologicalRows.reduce((sum, row) => sum + Number(row.credit_base), 0);
    const descriptions = [`${fromDate || 'Beginning'} to ${toDate || 'Today'}`,
      filters.status ? `status: ${filters.status}` : 'all entry statuses',
      useDescendants ? 'including sub-accounts' : 'direct account only'];
    if (filters.sourceType) descriptions.push(`source: ${filters.sourceType}`);
    if (filters.movement) descriptions.push(`${filters.movement} entries only`);
    if (filters.currencyId) descriptions.push(`currency ID: ${filters.currencyId}`);
    if (filters.partyType) descriptions.push(`${filters.partyType}${filters.partyId ? ` ID: ${filters.partyId}` : 's only'}`);
    if (filters.minAmount != null || filters.maxAmount != null) descriptions.push(`${filters.amountBasis} amount ${filters.minAmount ?? 0} to ${filters.maxAmount ?? 'unlimited'}`);
    if (filters.search) descriptions.push(`search: ${filters.search}`);
    if (filters.sort === 'desc') descriptions.push('newest first');
    return { title: 'Account Statement', subtitle: `${account.code} - ${account.name}`, orientation: 'landscape',
      filterDescription: descriptions.join(' | '),
      columns: [{ key: 'entry_date', label: 'Date' }, { key: 'entry_number', label: 'Reference' },
        { key: 'entry_status', label: 'Status' }, { key: 'source_type', label: 'Source' },
        { key: 'account_code', label: 'Account' }, { key: 'counter_accounts', label: 'Counter account(s)' },
        { key: 'party', label: 'Customer / Supplier' }, { key: 'product', label: 'Product' },
        { key: 'description', label: 'Description' },
        { key: 'transaction_debit', label: 'Debit (transaction)', type: 'money' },
        { key: 'transaction_credit', label: 'Credit (transaction)', type: 'money' },
        { key: 'transaction_currency', label: 'Currency' }, { key: 'exchange_rate_to_base', label: 'Rate to SDG' },
        { key: 'debit_base', label: 'Debit SDG', type: 'money' }, { key: 'credit_base', label: 'Credit SDG', type: 'money' },
        { key: 'running_balance', label: 'Running balance', type: 'money' }], rows,
      summary: [{ label: 'Opening balance', value: opening, type: 'money', suffix: 'SDG' },
        { label: 'Transactions', value: chronologicalRows.length },
        { label: 'Total debit', value: debit, type: 'money', suffix: 'SDG' },
        { label: 'Total credit', value: credit, type: 'money', suffix: 'SDG' },
        { label: 'Net movement', value: account.normal_balance === 'DEBIT' ? debit - credit : credit - debit, type: 'money', suffix: 'SDG' },
        { label: 'Closing balance', value: running, type: 'money', suffix: 'SDG' }] };
  }
  buildCashFlow(fromDate, toDate) {
    const opening = fromDate ? Number(this.all(`WITH RECURSIVE cash_accounts(id) AS (SELECT id FROM accounts WHERE code = '1100' UNION ALL SELECT a.id FROM accounts a JOIN cash_accounts c ON a.parent_id = c.id)
      SELECT round(coalesce(sum(jl.debit_base - jl.credit_base), 0), 4) AS value FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id IN (SELECT id FROM cash_accounts) AND je.status = 'POSTED' AND je.entry_date < ?`, [fromDate])[0]?.value || 0) : 0;
    const lines = this.all(`WITH RECURSIVE cash_accounts(id) AS (SELECT id FROM accounts WHERE code = '1100' UNION ALL SELECT a.id FROM accounts a JOIN cash_accounts c ON a.parent_id = c.id)
      SELECT je.entry_date, je.entry_number, je.description, je.source_type, a.name AS cash_account,
        round(CASE WHEN jl.debit_base > jl.credit_base THEN jl.debit_base - jl.credit_base ELSE 0 END, 4) AS cash_inflow,
        round(CASE WHEN jl.credit_base > jl.debit_base THEN jl.credit_base - jl.debit_base ELSE 0 END, 4) AS cash_outflow
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id JOIN accounts a ON a.id = jl.account_id
      WHERE jl.account_id IN (SELECT id FROM cash_accounts) AND je.status = 'POSTED'
        AND (? IS NULL OR je.entry_date >= ?) AND (? IS NULL OR je.entry_date <= ?) ORDER BY je.entry_date, je.id, jl.id`, [fromDate, fromDate, toDate, toDate]);
    const rows = lines.map(line => ({ ...line, activity: ['OPENING'].includes(line.source_type) ? 'Financing' : ['INVENTORY'].includes(line.source_type) ? 'Investing' : 'Operating' }));
    const inflow = rows.reduce((sum, row) => sum + Number(row.cash_inflow), 0); const outflow = rows.reduce((sum, row) => sum + Number(row.cash_outflow), 0);
    return { title: 'Cash Flow Statement', subtitle: 'Posted cash and bank movements during the selected period', orientation: 'landscape',
      columns: [{ key: 'entry_date', label: 'Date' }, { key: 'entry_number', label: 'Entry' }, { key: 'activity', label: 'Activity' }, { key: 'cash_account', label: 'Cash account' },
        { key: 'description', label: 'Description' }, { key: 'cash_inflow', label: 'Inflow SDG', type: 'money' }, { key: 'cash_outflow', label: 'Outflow SDG', type: 'money' }], rows,
      summary: [{ label: 'Opening cash', value: opening, type: 'money', suffix: 'SDG' }, { label: 'Cash inflows', value: inflow, type: 'money', suffix: 'SDG' },
        { label: 'Cash outflows', value: outflow, type: 'money', suffix: 'SDG' }, { label: 'Net cash flow', value: inflow - outflow, type: 'money', suffix: 'SDG' },
        { label: 'Closing cash', value: opening + inflow - outflow, type: 'money', suffix: 'SDG' }] };
  }

  buildOwnersEquity(fromDate, toDate) {
    const openingLedgerEquity = fromDate ? Number(this.all(`SELECT round(coalesce(sum(jl.credit_base - jl.debit_base), 0), 4) AS value
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id JOIN accounts a ON a.id = jl.account_id
      WHERE a.account_type = 'EQUITY' AND a.is_control = 0 AND je.status = 'POSTED' AND je.entry_date < ?`, [fromDate])[0]?.value || 0) : 0;
    const accumulatedEarnings = fromDate ? this.incomeStatementValues(null, null, fromDate).netIncome : 0;
    const equityAccounts = this.all(`SELECT a.code, a.name AS account,
        round(coalesce(sum(CASE WHEN je.status = 'POSTED' AND (? IS NULL OR je.entry_date >= ?) AND (? IS NULL OR je.entry_date <= ?) THEN jl.credit_base - jl.debit_base ELSE 0 END), 0), 4) AS period_change
      FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id = a.id LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE a.account_type = 'EQUITY' AND a.is_control = 0 GROUP BY a.id ORDER BY a.code`, [fromDate, fromDate, toDate, toDate]);
    const directChanges = equityAccounts.reduce((sum, row) => sum + Number(row.period_change), 0);
    const netIncome = this.incomeStatementValues(fromDate, toDate).netIncome;
    const opening = openingLedgerEquity + accumulatedEarnings; const ending = opening + directChanges + netIncome;
    const rows = [{ component: 'Opening equity', calculation: 'Ledger equity + accumulated earnings before the period', amount: opening },
      ...equityAccounts.map(row => ({ component: `${row.code} - ${row.account}`, calculation: 'Owner contribution / withdrawal and direct equity movement', amount: row.period_change })),
      { component: 'Net income', calculation: 'Income Statement for the selected period', amount: netIncome },
      { component: 'Ending equity', calculation: 'Opening equity + Direct equity changes + Net income', amount: ending }];
    return { title: "Statement of Owner's Equity", subtitle: 'Changes in owner capital, accumulated earnings and current-period income', orientation: 'portrait',
      columns: [{ key: 'component', label: 'Component' }, { key: 'calculation', label: 'Calculation' }, { key: 'amount', label: 'Amount SDG', type: 'money' }], rows,
      summary: [{ label: 'Opening equity', value: opening, type: 'money', suffix: 'SDG' }, { label: 'Direct equity changes', value: directChanges, type: 'money', suffix: 'SDG' },
        { label: 'Net income', value: netIncome, type: 'money', suffix: 'SDG' }, { label: 'Ending equity', value: ending, type: 'money', suffix: 'SDG' }] };
  }

  buildSalesRegister(fromDate, toDate) {
    const rows = this.all(`SELECT si.invoice_number, si.invoice_date, coalesce(cu.name, 'Walk-in customer') AS customer,
        pm.name AS payment_method, si.status, c.code AS currency, sit.invoice_total,
        sit.invoice_total_base
      FROM sales_invoices si LEFT JOIN customers cu ON cu.id = si.customer_id
      JOIN payment_methods pm ON pm.id = si.payment_method_id JOIN currencies c ON c.id = si.currency_id
      JOIN sales_invoice_totals sit ON sit.sales_invoice_id = si.id
      WHERE (? IS NULL OR si.invoice_date >= ?) AND (? IS NULL OR si.invoice_date <= ?)
      ORDER BY si.invoice_date, si.id`, [fromDate, fromDate, toDate, toDate]);
    const completed = rows.filter(row => row.status === 'COMPLETED');
    return { title: 'Sales Register', subtitle: 'Sales invoices, customers and payment methods', orientation: 'landscape',
      columns: [{ key: 'invoice_number', label: 'Invoice' }, { key: 'invoice_date', label: 'Date' }, { key: 'customer', label: 'Customer' }, { key: 'payment_method', label: 'Payment' }, { key: 'status', label: 'Status' }, { key: 'currency', label: 'Currency' }, { key: 'invoice_total', label: 'Invoice total', type: 'money' }, { key: 'invoice_total_base', label: 'Base total SDG', type: 'money' }], rows,
      summary: [{ label: 'Invoices', value: rows.length }, { label: 'Completed sales', value: completed.reduce((sum, row) => sum + Number(row.invoice_total_base), 0), type: 'money', suffix: 'SDG' }] };
  }

  buildPurchaseRegister(fromDate, toDate) {
    const rows = this.all(`SELECT pi.invoice_code, pi.invoice_date, s.name AS supplier, pi.status,
        c.code AS currency, pit.goods_total, pit.additional_cost_total, pit.landed_total,
        round(pit.landed_total * pi.exchange_rate_to_base, 4) AS landed_total_base
      FROM purchase_invoices pi JOIN suppliers s ON s.id = pi.supplier_id
      JOIN currencies c ON c.id = pi.currency_id JOIN purchase_invoice_totals pit ON pit.purchase_invoice_id = pi.id
      WHERE (? IS NULL OR pi.invoice_date >= ?) AND (? IS NULL OR pi.invoice_date <= ?)
      ORDER BY pi.invoice_date, pi.id`, [fromDate, fromDate, toDate, toDate]);
    const received = rows.filter(row => row.status === 'RECEIVED');
    return { title: 'Purchase Register', subtitle: 'Purchase invoices and allocated landed costs', orientation: 'landscape',
      columns: [{ key: 'invoice_code', label: 'Invoice' }, { key: 'invoice_date', label: 'Date' }, { key: 'supplier', label: 'Supplier' }, { key: 'status', label: 'Status' }, { key: 'currency', label: 'Currency' }, { key: 'goods_total', label: 'Goods', type: 'money' }, { key: 'additional_cost_total', label: 'Additional costs', type: 'money' }, { key: 'landed_total', label: 'Landed total', type: 'money' }, { key: 'landed_total_base', label: 'Base total SDG', type: 'money' }], rows,
      summary: [{ label: 'Invoices', value: rows.length }, { label: 'Received purchases', value: received.reduce((sum, row) => sum + Number(row.landed_total_base), 0), type: 'money', suffix: 'SDG' }] };
  }

  buildInventoryValuation(filters = {}) {
    const query = String(filters.search || '').toLowerCase();
    const filtered = this.getInventorySummary().filter(row => (!filters.warehouseId || Number(row.warehouse_id) === filters.warehouseId)
      && (!filters.category || row.category_name === filters.category)
      && (!query || `${row.product_name} ${row.sku || ''} ${row.category_name}`.toLowerCase().includes(query))
      && (filters.minQuantity == null || Number(row.quantity_on_hand) >= filters.minQuantity)
      && (filters.maxQuantity == null || Number(row.quantity_on_hand) <= filters.maxQuantity)
      && (filters.minValue == null || Number(row.movement_value_base) >= filters.minValue)
      && (filters.maxValue == null || Number(row.movement_value_base) <= filters.maxValue)
      && (!filters.hasSalvage || Number(row.salvage_operation_count) > 0)
      && (!filters.stockStatus || (filters.stockStatus === 'in_stock' && Number(row.quantity_on_hand) > 5)
        || (filters.stockStatus === 'low_stock' && Number(row.quantity_on_hand) > 0 && Number(row.quantity_on_hand) <= 5)
        || (filters.stockStatus === 'out_of_stock' && Number(row.quantity_on_hand) <= 0)
        || (filters.stockStatus === 'has_available' && Number(row.quantity_available) > 0)
        || (filters.stockStatus === 'has_reserved' && Number(row.quantity_reserved) > 0)
        || (filters.stockStatus === 'has_damaged' && Number(row.quantity_damaged) > 0)
        || (filters.stockStatus === 'has_salvage' && Number(row.quantity_salvage) > 0)
        || (filters.stockStatus === 'has_disposed' && Number(row.quantity_disposed) > 0)));
    const rows = filtered.map(row => ({ product: row.product_name, sku: row.sku || '', category: row.category_name,
      warehouse: row.warehouse_name, unit: row.unit_name, available: row.quantity_available,
      reserved: row.quantity_reserved, damaged: row.quantity_damaged, salvage: row.quantity_salvage,
      disposed: row.quantity_disposed, quantity: row.quantity_on_hand,
      average_cost: row.average_on_hand_cost_base, salvage_write_down: row.salvage_write_down_base,
      stock_value: row.movement_value_base }));
    const descriptions = ['Current valuation'];
    if (filters.search) descriptions.push(`search: ${filters.search}`);
    if (filters.category) descriptions.push(`category: ${filters.category}`);
    if (filters.warehouseId) descriptions.push(`warehouse ID: ${filters.warehouseId}`);
    if (filters.stockStatus) descriptions.push(filters.stockStatus.replaceAll('_', ' '));
    if (filters.hasSalvage) descriptions.push('salvage operations only');
    if (filters.minQuantity != null || filters.maxQuantity != null) descriptions.push(`quantity ${filters.minQuantity ?? '-infinity'} to ${filters.maxQuantity ?? 'infinity'}`);
    if (filters.minValue != null || filters.maxValue != null) descriptions.push(`value ${filters.minValue ?? '-infinity'} to ${filters.maxValue ?? 'infinity'} SDG`);
    return { title: 'Inventory Valuation', subtitle: 'Current stock value after auditable salvage write-downs', orientation: 'landscape',
      filterDescription: descriptions.join(' | '),
      columns: [{ key: 'product', label: 'Product' }, { key: 'category', label: 'Category' }, { key: 'warehouse', label: 'Warehouse' }, { key: 'available', label: 'Available', type: 'quantity' }, { key: 'reserved', label: 'Reserved', type: 'quantity' }, { key: 'damaged', label: 'Damaged', type: 'quantity' }, { key: 'salvage', label: 'Salvage', type: 'quantity' }, { key: 'disposed', label: 'Disposed', type: 'quantity' }, { key: 'quantity', label: 'Total on-hand', type: 'quantity' }, { key: 'average_cost', label: 'Avg cost SDG', type: 'money' }, { key: 'stock_value', label: 'Inventory value SDG', type: 'money' }], rows,
      summary: [{ label: 'Products', value: new Set(rows.map(row => row.product)).size }, { label: 'Units on hand', value: rows.reduce((sum, row) => sum + Number(row.quantity), 0), type: 'quantity' }, { label: 'Salvage write-downs', value: rows.reduce((sum, row) => sum + Number(row.salvage_write_down), 0), type: 'money', suffix: 'SDG' }, { label: 'Inventory value', value: rows.reduce((sum, row) => sum + Number(row.stock_value), 0), type: 'money', suffix: 'SDG' }] };
  }

  getSalesSetup() {
    return {
      customers: this.all(`SELECT id, code, name, phone_number, location FROM customers WHERE is_active = 1 ORDER BY name COLLATE NOCASE`),
      paymentMethods: this.all(`SELECT id, code, name, method_type FROM payment_methods WHERE is_active = 1 ORDER BY id`),
      currencies: this.all('SELECT id, code, name, symbol, is_base FROM currencies WHERE is_active = 1 ORDER BY is_base DESC, code'),
      warehouses: this.all('SELECT id, code, name FROM warehouses WHERE is_active = 1 ORDER BY name COLLATE NOCASE'),
       products: this.all(`SELECT p.id, p.sku, p.barcode, p.name, p.category_id, p.default_unit_id,
           c.name AS category_name, u.name AS unit_name, w.id AS warehouse_id, w.name AS warehouse_name,
           stock.quantity_available AS quantity_on_hand, stock.quantity_available,
           stock.quantity_on_hand AS quantity_total_on_hand,
           CASE WHEN stock.quantity_available = 0 THEN 0
                ELSE stock.available_value_base / stock.quantity_available END AS average_unit_cost_base,
           price.id AS price_version_id, price.published_price AS sales_price_base,
           price.minimum_sale_price AS minimum_sale_price_base
         FROM products p
         JOIN item_categories c ON c.id = p.category_id
         JOIN units u ON u.id = p.default_unit_id
         CROSS JOIN warehouses w
         JOIN inventory_stock stock ON stock.product_id = p.id AND stock.warehouse_id = w.id
         JOIN product_price_versions price ON price.id = (SELECT ppv.id FROM product_price_versions ppv
           WHERE ppv.product_id = p.id AND ppv.status = 'PUBLISHED'
             AND (ppv.warehouse_id = w.id OR ppv.warehouse_id IS NULL)
             AND (ppv.effective_from IS NULL OR ppv.effective_from <= date('now'))
             AND (ppv.effective_to IS NULL OR ppv.effective_to > date('now'))
           ORDER BY ppv.warehouse_id IS NOT NULL DESC, ppv.published_at DESC, ppv.id DESC LIMIT 1)
         WHERE p.is_active = 1 AND w.is_active = 1 AND stock.quantity_available > 0 AND price.published_price > 0
         ORDER BY p.name COLLATE NOCASE, w.name COLLATE NOCASE`)
    };
  }

  addCustomer(input) {
    const name = String(input?.name || '').trim();
    if (!name) throw new Error('Customer name is required.');
    const code = this.nextPartyCode('customers', 'CUS');
    this.run('INSERT INTO customers(code, name, phone_number, location) VALUES (?, ?, ?, ?)',
      [code, name, String(input?.phone || '').trim() || null, String(input?.location || '').trim() || null]);
    return this.all('SELECT id, code, name, phone_number, location FROM customers WHERE id = last_insert_rowid()')[0];
  }

  nextSalesNumber() {
    const datePart = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const count = Number(this.all('SELECT count(*) AS count FROM sales_invoices WHERE invoice_number LIKE ?', [`SAL-${datePart}-%`])[0]?.count || 0);
    return `SAL-${datePart}-${String(count + 1).padStart(4, '0')}`;
  }

  listSales(createdBy = null) {
    return this.all(`SELECT si.id, si.invoice_number, si.invoice_date, si.status,
        coalesce(si.customer_name_snapshot, cu.name, 'Walk-in customer') AS customer_name, pm.name AS payment_method,
        c.code AS currency_code, sit.invoice_total, sit.invoice_total_base,
        (SELECT count(*) FROM invoice_attachments ia WHERE ia.invoice_type = 'SALE' AND ia.invoice_id = si.id) AS attachment_count
      FROM sales_invoices si
      LEFT JOIN customers cu ON cu.id = si.customer_id
      JOIN payment_methods pm ON pm.id = si.payment_method_id
      JOIN currencies c ON c.id = si.currency_id
      JOIN sales_invoice_totals sit ON sit.sales_invoice_id = si.id
      WHERE (? IS NULL OR si.created_by = ?)
      ORDER BY si.invoice_date DESC, si.id DESC`, [createdBy, createdBy]);
  }

  createSale(input, attachments = [], createdBy, withinTransaction = false) {
    const customerId = input?.customerId ? Number(input.customerId) : null;
    const paymentMethodId = Number(input?.paymentMethodId);
    const currencyId = Number(input?.currencyId);
    const warehouseId = Number(input?.warehouseId);
    const exchangeRate = Number(input?.exchangeRate || 1);
    const invoiceDate = String(input?.invoiceDate || '');
    const status = input?.status === 'COMPLETED' ? 'COMPLETED' : 'DRAFT';
    const lines = Array.isArray(input?.lines) ? input.lines : [];
    if (!paymentMethodId || !currencyId || !warehouseId || !invoiceDate) throw new Error('Date, payment method, currency and warehouse are required.');
    if (!(exchangeRate > 0)) throw new Error('Exchange rate must be greater than zero.');
    if (!lines.length) throw new Error('Add at least one product to the sale.');
    const paymentMethod = this.all('SELECT id, code, method_type, account_id FROM payment_methods WHERE id = ? AND is_active = 1', [paymentMethodId])[0];
    if (!paymentMethod) throw new Error('The selected payment method is invalid.');
    if (paymentMethod.method_type === 'CREDIT' && !customerId) throw new Error('Select a customer for a credit sale.');

    const work = () => {
      const customer = customerId ? this.all('SELECT id, name FROM customers WHERE id = ? AND is_active = 1', [customerId])[0] : null;
      if (customerId && !customer) throw new Error('The selected customer is no longer available. Select the customer again.');
      const invoiceNumber = String(input?.invoiceNumber || '').trim() || this.nextSalesNumber();
      const requestedByProduct = new Map();
      const preparedLines = lines.map(line => {
        const product = this.all(`SELECT p.id, p.category_id, p.default_unit_id, ppv.id AS price_version_id,
            ppv.published_price, ppv.minimum_sale_price
          FROM products p JOIN product_price_versions ppv ON ppv.id = (SELECT active.id FROM product_price_versions active
            WHERE active.product_id = p.id AND active.status = 'PUBLISHED'
              AND (active.warehouse_id = ? OR active.warehouse_id IS NULL)
              AND (active.effective_from IS NULL OR active.effective_from <= ?)
              AND (active.effective_to IS NULL OR active.effective_to > ?)
            ORDER BY active.warehouse_id IS NOT NULL DESC, active.published_at DESC, active.id DESC LIMIT 1)
          WHERE p.id = ? AND p.is_active = 1`, [warehouseId, invoiceDate, invoiceDate, Number(line.productId)])[0];
        if (!product) throw new Error('One of the selected products is invalid.');
        const quantity = Number(line.quantity);
        const unitPrice = Number(line.unitPrice);
        if (!(quantity > 0) || !(unitPrice >= 0)) throw new Error('Sale quantities and prices are invalid.');
        const actualBasePrice = Math.round(unitPrice * exchangeRate * 10000) / 10000;
        const floorBasePrice = Number(product.minimum_sale_price);
        if (actualBasePrice + 0.000001 < floorBasePrice) throw new Error(`PRICE_BELOW_FLOOR: Product ${product.id} cannot be sold below ${floorBasePrice.toFixed(2)} SDG.`);
        if (actualBasePrice > floorBasePrice + 0.000001 && !input?.allowPriceIncrease) throw new Error('Permission is required to increase the published selling price.');
        const stock = this.getAvailableStock(product.id, warehouseId);
        const requested = (requestedByProduct.get(product.id) || 0) + quantity;
        requestedByProduct.set(product.id, requested);
        if (status === 'COMPLETED' && Number(stock.quantity || 0) + 0.000001 < requested) {
          throw new Error(`Insufficient available stock for product ${product.id}. Available: ${Number(stock.quantity || 0)}.`);
        }
        return { ...product, quantity, unitPrice, averageCost: Number(stock.average_cost || 0) };
      });

      this.database.run(`INSERT INTO sales_invoices
        (invoice_number, invoice_date, customer_id, customer_name_snapshot, payment_method_id, currency_id, exchange_rate_to_base, status, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [invoiceNumber, invoiceDate, customerId, customer?.name || null, paymentMethodId, currencyId,
        exchangeRate, status, String(input?.notes || '').trim() || null, createdBy]);
      const saleId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      const savedLines = [];
      for (const line of preparedLines) {
        this.database.run(`INSERT INTO sales_invoice_lines
          (sales_invoice_id, product_id, category_id, quantity, unit_id, unit_quantity, unit_price, published_unit_price, price_version_id)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`, [saleId, line.id, line.category_id, line.quantity, line.default_unit_id,
          line.unitPrice, Number(line.published_price) / exchangeRate, line.price_version_id]);
        savedLines.push({ ...line, productId: line.id, salesLineId: Number(this.all('SELECT last_insert_rowid() AS id')[0].id) });
      }
      this.storeInvoiceAttachments('SALE', saleId, attachments, createdBy);
      if (status === 'COMPLETED') this.postCompletedSale({ saleId, invoiceNumber, invoiceDate, customerId, paymentMethod,
        currencyId, exchangeRate, warehouseId, lines: savedLines, createdBy });
      return this.getSale(saleId);
    };
    return withinTransaction ? work() : this.transaction(work);
  }

  teardownSale(saleId) {
    const id = Number(saleId); const sale = this.all('SELECT id, journal_entry_id FROM sales_invoices WHERE id = ?', [id])[0];
    if (!sale) throw new Error('Sales invoice was not found.');
    this.reverseMovements('sales_line_id IN (SELECT id FROM sales_invoice_lines WHERE sales_invoice_id = ?)', [id]);
    this.database.run('UPDATE sales_invoices SET journal_entry_id = NULL WHERE id = ?', [id]);
    this.database.run("DELETE FROM invoice_attachments WHERE invoice_type = 'SALE' AND invoice_id = ?", [id]);
    if (sale.journal_entry_id) {
      this.database.run("UPDATE journal_entries SET status = 'VOID' WHERE id = ?", [sale.journal_entry_id]);
      this.database.run('DELETE FROM journal_entries WHERE id = ?', [sale.journal_entry_id]);
    }
    this.database.run('DELETE FROM sales_invoice_lines WHERE sales_invoice_id = ?', [id]);
    this.database.run('DELETE FROM sales_invoices WHERE id = ?', [id]);
  }

  updateSale(saleId, input, attachments, createdBy, allowAll = false) {
    return this.transaction(() => {
      const original = this.all('SELECT invoice_number, status, created_by FROM sales_invoices WHERE id = ?', [Number(saleId)])[0];
      if (!original) throw new Error('Sales invoice was not found.');
      if (!allowAll && String(original.created_by) !== String(createdBy)) throw new Error('You can only edit your own draft sales invoices.');
      if (original.status !== 'DRAFT') throw new Error('Completed sales are immutable. Create a return instead.');
      const existingAttachments = this.all(`SELECT original_name AS name, mime_type AS mimeType, file_size AS size, file_data AS data
        FROM invoice_attachments WHERE invoice_type = 'SALE' AND invoice_id = ?`, [Number(saleId)]);
      const savedAttachments = [...existingAttachments, ...attachments];
      this.teardownSale(saleId);
      return this.createSale({ ...input, invoiceNumber: original.invoice_number }, savedAttachments, createdBy, true);
    });
  }

  deleteSale(saleId, deletedBy, allowAll = false) {
    const sale = this.all('SELECT status, created_by FROM sales_invoices WHERE id = ?', [Number(saleId)])[0];
    if (!sale) throw new Error('Sales invoice was not found.');
    if (!allowAll && String(sale.created_by) !== String(deletedBy)) throw new Error('You can only delete your own draft sales invoices.');
    if (sale.status !== 'DRAFT') throw new Error('Completed sales are immutable. Create a return instead.');
    return this.transaction(() => { this.teardownSale(saleId); return true; });
  }

  postCompletedSale(context) {
    const totals = this.all('SELECT invoice_total, invoice_total_base FROM sales_invoice_totals WHERE sales_invoice_id = ?', [context.saleId])[0];
    const salesBase = Math.round(Number(totals.invoice_total_base) * 10000) / 10000;
    let cogsBase = 0;
    for (const line of context.lines) {
      const allocations = this.issueAvailableStock(line.productId, context.warehouseId, line.quantity);
      for (const allocation of allocations) {
        cogsBase += allocation.quantity * allocation.unitCostBase;
        this.insertInventoryMovement({
          movementDate: context.invoiceDate, productId: line.productId, warehouseId: context.warehouseId,
          movementType: 'SALE', quantityChange: -allocation.quantity, unitCostBase: allocation.unitCostBase,
          inventoryStatus: 'AVAILABLE', batchCode: allocation.batchCode, expiryDate: allocation.expiryDate,
          salesLineId: line.salesLineId, referenceCode: context.invoiceNumber,
          notes: 'Sale issue', createdBy: context.createdBy
        });
      }
    }
    cogsBase = Math.round(cogsBase * 10000) / 10000;
    this.validateAccountCurrency(context.paymentMethod.account_id, context.currencyId, 'payment account');
    this.validateAccountCurrency(4100, context.currencyId, 'sales account');
    this.database.run(`INSERT INTO journal_entries
      (entry_number, entry_date, description, source_type, source_id, currency_id, exchange_rate_to_base, status, created_by)
      VALUES (?, ?, ?, 'SALE', ?, ?, ?, 'DRAFT', ?)`, [`JE-${context.invoiceNumber}`, context.invoiceDate,
      `Sale ${context.invoiceNumber}`, context.saleId, context.currencyId, context.exchangeRate, context.createdBy]);
    const journalId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
    this.database.run(`INSERT INTO journal_lines(journal_entry_id, account_id, debit_base, transaction_amount, currency_id, exchange_rate_to_base, memo)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [journalId, context.paymentMethod.account_id, salesBase, Number(totals.invoice_total),
      context.currencyId, context.exchangeRate, `${context.paymentMethod.code} receipt - ${context.invoiceNumber}`]);
    this.database.run(`INSERT INTO journal_lines(journal_entry_id, account_id, credit_base, transaction_amount, currency_id, exchange_rate_to_base, memo)
      VALUES (?, 4100, ?, ?, ?, ?, ?)`, [journalId, salesBase, -Number(totals.invoice_total), context.currencyId, context.exchangeRate, `Sales revenue - ${context.invoiceNumber}`]);
    if (cogsBase > 0) {
      this.database.run(`INSERT INTO journal_lines(journal_entry_id, account_id, debit_base, memo) VALUES (?, 5100, ?, ?)`, [journalId, cogsBase, `Cost of goods sold - ${context.invoiceNumber}`]);
      this.database.run(`INSERT INTO journal_lines(journal_entry_id, account_id, credit_base, memo) VALUES (?, 1300, ?, ?)`, [journalId, cogsBase, `Inventory issued - ${context.invoiceNumber}`]);
    }
    this.database.run(`UPDATE journal_entries SET status = 'POSTED', posted_at = CURRENT_TIMESTAMP WHERE id = ?`, [journalId]);
    this.database.run('UPDATE sales_invoices SET journal_entry_id = ? WHERE id = ?', [journalId, context.saleId]);
  }

  getSale(saleId, createdBy = null) {
    const header = this.all(`SELECT si.*, (SELECT im.warehouse_id FROM inventory_movements im JOIN sales_invoice_lines x ON x.id = im.sales_line_id WHERE x.sales_invoice_id = si.id LIMIT 1) AS warehouse_id, coalesce(si.customer_name_snapshot, cu.name, 'Walk-in customer') AS customer_name,
        pm.name AS payment_method, c.code AS currency_code, sit.invoice_total, sit.invoice_total_base
      FROM sales_invoices si LEFT JOIN customers cu ON cu.id = si.customer_id
      JOIN payment_methods pm ON pm.id = si.payment_method_id JOIN currencies c ON c.id = si.currency_id
       JOIN sales_invoice_totals sit ON sit.sales_invoice_id = si.id WHERE si.id = ? AND (? IS NULL OR si.created_by = ?)`, [saleId, createdBy, createdBy])[0];
    if (!header) return null;
    return { ...header, lines: this.all(`SELECT sil.*, p.name AS product_name, u.name AS unit_name
      FROM sales_invoice_lines sil JOIN products p ON p.id = sil.product_id JOIN units u ON u.id = sil.unit_id
      WHERE sil.sales_invoice_id = ? ORDER BY sil.id`, [saleId]),
      attachments: this.listInvoiceAttachments('SALE', saleId) };
  }

  nextManualJournalNumber(entryDate) {
    const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(entryDate || '')) ? String(entryDate) : new Date().toISOString().slice(0, 10);
    const prefix = `MJE-${normalizedDate.replaceAll('-', '')}-`;
    const sequence = Number(this.all(`SELECT coalesce(max(CAST(substr(entry_number, 14) AS INTEGER)), 0) AS sequence
      FROM journal_entries WHERE entry_number LIKE ?`, [`${prefix}%`])[0]?.sequence || 0);
    return `${prefix}${String(sequence + 1).padStart(4, '0')}`;
  }

  nextCashVoucherNumber(voucherType, entryDate) {
    const sourceType = voucherType === 'receipt' ? 'RECEIPT' : voucherType === 'payment' ? 'PAYMENT' : null;
    if (!sourceType) throw new Error('Select a valid voucher type.');
    const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(entryDate || '')) ? String(entryDate) : new Date().toISOString().slice(0, 10);
    const prefix = `${sourceType === 'RECEIPT' ? 'RV' : 'PV'}-${normalizedDate.replaceAll('-', '')}-`;
    const sequence = Number(this.all(`SELECT coalesce(max(CAST(substr(entry_number, ?) AS INTEGER)), 0) AS sequence
      FROM journal_entries WHERE source_type = ? AND entry_number LIKE ?`, [prefix.length + 1, sourceType, `${prefix}%`])[0]?.sequence || 0);
    return `${prefix}${String(sequence + 1).padStart(4, '0')}`;
  }

  createCashVoucher(voucherType, input, attachments, createdBy) {
    const sourceType = voucherType === 'receipt' ? 'RECEIPT' : voucherType === 'payment' ? 'PAYMENT' : null;
    if (!sourceType) throw new Error('Select a valid voucher type.');
    const entryDate = String(input?.entryDate || ''); const description = String(input?.description || '').trim();
    const paymentMethodId = Number(input?.paymentMethodId); const counterAccountId = Number(input?.accountId);
    const currencyId = Number(input?.currencyId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) throw new Error('Enter a valid voucher date.');
    if (!description) throw new Error('Voucher narration is required.');
    const paymentMethod = this.all(`SELECT pm.id, pm.code, pm.name, pm.method_type, pm.account_id,
        pm.bank_fee_account_id, fee.name AS bank_fee_account_name
      FROM payment_methods pm JOIN accounts a ON a.id = pm.account_id
      LEFT JOIN accounts fee ON fee.id = pm.bank_fee_account_id AND fee.account_type = 'EXPENSE' AND fee.is_control = 0 AND fee.is_active = 1
      WHERE pm.id = ? AND pm.is_active = 1 AND pm.method_type IN ('CASH', 'BANK') AND a.is_active = 1`, [paymentMethodId])[0];
    if (!paymentMethod) throw new Error('Select a valid cash or bank account.');
    const mappings = Object.fromEntries(this.all(`SELECT mapping_key, account_id FROM accounting_mappings
      WHERE mapping_key IN ('ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE')`).map(row => [row.mapping_key, Number(row.account_id)]));
    if (sourceType === 'PAYMENT' && counterAccountId === mappings.ACCOUNTS_PAYABLE)
      throw new Error('Supplier purchase payments require an Accountant disbursement order and Treasury execution.');
    const account = this.all('SELECT id, code, name, is_control FROM accounts WHERE id = ? AND is_active = 1', [counterAccountId])[0];
    if (!account || (Number(account.is_control) && ![mappings.ACCOUNTS_RECEIVABLE, mappings.ACCOUNTS_PAYABLE].includes(counterAccountId))) throw new Error('Select a valid counter account.');
    if (Number(paymentMethod.account_id) === counterAccountId) throw new Error('Cash or bank account and counter account must be different.');
    const currency = this.all('SELECT id, code, is_base FROM currencies WHERE id = ? AND is_active = 1', [currencyId])[0];
    if (!currency) throw new Error('Select a valid currency.');
    this.validateAccountCurrency(paymentMethod.account_id, currencyId, 'cash or bank account');
    this.validateAccountCurrency(counterAccountId, currencyId, 'counter account');
    const exchangeRateToBase = Math.round(Number(input?.exchangeRateToBase) * 1000000) / 1000000;
    if (!Number.isFinite(exchangeRateToBase) || exchangeRateToBase <= 0) throw new Error('Enter a valid exchange rate.');
    if (Number(currency.is_base) && exchangeRateToBase !== 1) throw new Error('The base currency rate must be 1.');
    const transactionUnits = Math.round(Number(input?.amount || 0) * 10000);
    const baseUnits = Math.round((transactionUnits / 10000) * exchangeRateToBase * 10000);
    const feeTransactionUnits = Math.round(Number(input?.bankFeeAmount || 0) * 10000);
    const feeBaseUnits = Math.round((feeTransactionUnits / 10000) * exchangeRateToBase * 10000);
    if (!Number.isSafeInteger(transactionUnits) || !Number.isSafeInteger(baseUnits) || transactionUnits <= 0 || baseUnits <= 0) throw new Error('Enter a valid voucher amount.');
    if (!Number.isSafeInteger(feeTransactionUnits) || !Number.isSafeInteger(feeBaseUnits) || feeTransactionUnits < 0 || feeBaseUnits < 0
      || (feeTransactionUnits > 0 && feeBaseUnits === 0)) throw new Error('Enter a valid bank fee amount.');
    let customerId = null; let supplierId = null;
    if (counterAccountId === mappings.ACCOUNTS_RECEIVABLE) {
      customerId = Number(input?.customerId) || null;
      if (!customerId || !this.all('SELECT id FROM customers WHERE id = ? AND is_active = 1', [customerId])[0]) throw new Error('Select a customer for Accounts Receivable.');
    } else if (counterAccountId === mappings.ACCOUNTS_PAYABLE) {
      supplierId = Number(input?.supplierId) || null;
      if (!supplierId || !this.all('SELECT id FROM suppliers WHERE id = ? AND is_active = 1', [supplierId])[0]) throw new Error('Select a supplier for Accounts Payable.');
    }
    if (feeTransactionUnits > 0) {
      if (sourceType !== 'PAYMENT' || paymentMethod.method_type !== 'BANK' || counterAccountId !== mappings.ACCOUNTS_PAYABLE || !supplierId) {
        throw new Error('Bank fees can only be added to a supplier payment made from a bank account.');
      }
      if (!paymentMethod.bank_fee_account_id || !paymentMethod.bank_fee_account_name) throw new Error('Configure a Bank Fees expense account for the selected bank first.');
      this.validateAccountCurrency(paymentMethod.bank_fee_account_id, currencyId, 'bank fee expense account');
    }
    const amount = transactionUnits / 10000; const baseAmount = baseUnits / 10000;
    const feeAmount = feeTransactionUnits / 10000; const feeBaseAmount = feeBaseUnits / 10000;
    const totalBankAmount = (transactionUnits + feeTransactionUnits) / 10000;
    const totalBankBaseAmount = (baseUnits + feeBaseUnits) / 10000;
    return this.transaction(() => {
      const entryNumber = this.nextCashVoucherNumber(voucherType, entryDate);
      this.database.run(`INSERT INTO journal_entries
        (entry_number, entry_date, description, source_type, currency_id, exchange_rate_to_base, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?)`, [entryNumber, entryDate, description, sourceType, currencyId, exchangeRateToBase, createdBy]);
      const journalId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      this.database.run('UPDATE journal_entries SET source_id = ? WHERE id = ?', [journalId, journalId]);
      const debitAccountId = sourceType === 'RECEIPT' ? Number(paymentMethod.account_id) : counterAccountId;
      const creditAccountId = sourceType === 'RECEIPT' ? counterAccountId : Number(paymentMethod.account_id);
      this.database.run(`INSERT INTO journal_lines
        (journal_entry_id, account_id, customer_id, supplier_id, debit_base, transaction_amount, currency_id, exchange_rate_to_base, memo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [journalId, debitAccountId,
        debitAccountId === counterAccountId ? customerId : null, debitAccountId === counterAccountId ? supplierId : null,
        baseAmount, amount, currencyId, exchangeRateToBase, description]);
      if (feeTransactionUnits > 0) {
        this.database.run(`INSERT INTO journal_lines
          (journal_entry_id, account_id, debit_base, transaction_amount, currency_id, exchange_rate_to_base, memo)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [journalId, Number(paymentMethod.bank_fee_account_id), feeBaseAmount,
          feeAmount, currencyId, exchangeRateToBase, `${paymentMethod.name} bank fees`]);
      }
      this.database.run(`INSERT INTO journal_lines
        (journal_entry_id, account_id, customer_id, supplier_id, credit_base, transaction_amount, currency_id, exchange_rate_to_base, memo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [journalId, creditAccountId,
        creditAccountId === counterAccountId ? customerId : null, creditAccountId === counterAccountId ? supplierId : null,
        totalBankBaseAmount, -totalBankAmount, currencyId, exchangeRateToBase, description]);
      this.storeJournalAttachments(journalId, attachments, createdBy);
      this.database.run(`UPDATE journal_entries SET status = 'POSTED', posted_at = CURRENT_TIMESTAMP WHERE id = ?`, [journalId]);
      return this.getJournalDetails(journalId);
    });
  }
  createManualJournal(input, attachments = [], createdBy, withinTransaction = false) {
    const entryDate = String(input?.entryDate || '');
    const description = String(input?.description || '').trim();
    const lines = Array.isArray(input?.lines) ? input.lines : [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) throw new Error('Enter a valid journal date.');
    if (!description) throw new Error('Journal narration is required.');
    if (lines.length < 2) throw new Error('A journal entry requires at least two lines.');
    if (!Array.isArray(attachments) || attachments.length > 10) throw new Error('A journal entry can contain up to 10 attachments.');
    const totalAttachmentSize = attachments.reduce((sum, item) => sum + Number(item.size || 0), 0);
    if (totalAttachmentSize > 25 * 1024 * 1024) throw new Error('Journal attachments cannot exceed 25 MB in total.');

    const mappings = Object.fromEntries(this.all(`SELECT mapping_key, account_id FROM accounting_mappings
      WHERE mapping_key IN ('ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE')`).map(row => [row.mapping_key, Number(row.account_id)]));
    let totalDebitUnits = 0; let totalCreditUnits = 0;
    const normalizedLines = lines.map((line, index) => {
      const accountId = Number(line?.accountId);
      const account = this.all('SELECT id, code, name, is_control FROM accounts WHERE id = ? AND is_active = 1', [accountId])[0];
      if (!account || (Number(account.is_control) && ![mappings.ACCOUNTS_RECEIVABLE, mappings.ACCOUNTS_PAYABLE].includes(accountId))) throw new Error(`Select a valid posting account on line ${index + 1}.`);
      const currencyId = Number(line?.currencyId);
      const currency = this.all('SELECT id, code, is_base FROM currencies WHERE id = ? AND is_active = 1', [currencyId])[0];
      if (!currency) throw new Error(`Select a valid currency on line ${index + 1}.`);
      this.validateAccountCurrency(accountId, currencyId, `account on line ${index + 1}`);
      const exchangeRateToBase = Math.round(Number(line?.exchangeRateToBase) * 1000000) / 1000000;
      if (!Number.isFinite(exchangeRateToBase) || exchangeRateToBase <= 0) throw new Error(`Enter a valid currency rate on line ${index + 1}.`);
      if (Number(currency.is_base) && exchangeRateToBase !== 1) throw new Error(`The base currency rate must be 1 on line ${index + 1}.`);
      const debitTransactionUnits = Math.round(Number(line?.debit || 0) * 10000);
      const creditTransactionUnits = Math.round(Number(line?.credit || 0) * 10000);
      if (!Number.isSafeInteger(debitTransactionUnits) || !Number.isSafeInteger(creditTransactionUnits)
        || debitTransactionUnits < 0 || creditTransactionUnits < 0) throw new Error(`Enter valid amounts on line ${index + 1}.`);
      if ((debitTransactionUnits > 0) === (creditTransactionUnits > 0)) throw new Error(`Line ${index + 1} must contain either a debit or a credit amount.`);
      const debitUnits = Math.round((debitTransactionUnits / 10000) * exchangeRateToBase * 10000);
      const creditUnits = Math.round((creditTransactionUnits / 10000) * exchangeRateToBase * 10000);
      if (!Number.isSafeInteger(debitUnits) || !Number.isSafeInteger(creditUnits)) throw new Error('The converted amount on line ' + (index + 1) + ' is too large.');
      if ((debitUnits > 0) === (creditUnits > 0)) throw new Error(`The converted amount on line ${index + 1} is too small.`);
      let customerId = null; let supplierId = null;
      if (accountId === mappings.ACCOUNTS_RECEIVABLE) {
        customerId = Number(line?.customerId) || null;
        if (!customerId || !this.all('SELECT id FROM customers WHERE id = ? AND is_active = 1', [customerId])[0]) throw new Error(`Select a customer on line ${index + 1}.`);
      } else if (accountId === mappings.ACCOUNTS_PAYABLE) {
        supplierId = Number(line?.supplierId) || null;
        if (!supplierId || !this.all('SELECT id FROM suppliers WHERE id = ? AND is_active = 1', [supplierId])[0]) throw new Error(`Select a supplier on line ${index + 1}.`);
      }
      totalDebitUnits += debitUnits; totalCreditUnits += creditUnits;
      return { accountId, customerId, supplierId, currencyId, exchangeRateToBase,
        debit: debitTransactionUnits / 10000, credit: creditTransactionUnits / 10000,
        debitBase: debitUnits / 10000, creditBase: creditUnits / 10000,
        memo: String(line?.memo || '').trim() || null };
    });
    if (totalDebitUnits !== totalCreditUnits) throw new Error('Converted debit and credit totals must exactly balance in SDG.');
    if (totalDebitUnits <= 0) throw new Error('Journal total must be greater than zero.');

    const work = () => {
      const entryNumber = this.nextManualJournalNumber(entryDate);
      const currencyId = Number(this.all('SELECT id FROM currencies WHERE is_base = 1 LIMIT 1')[0]?.id || 1);
      this.database.run(`INSERT INTO journal_entries
        (entry_number, entry_date, description, source_type, currency_id, exchange_rate_to_base, status, created_by)
        VALUES (?, ?, ?, 'MANUAL', ?, 1, 'DRAFT', ?)`, [entryNumber, entryDate, description, currencyId, createdBy]);
      const journalId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      this.database.run('UPDATE journal_entries SET source_id = ? WHERE id = ?', [journalId, journalId]);
      for (const line of normalizedLines) {
        this.database.run(`INSERT INTO journal_lines
          (journal_entry_id, account_id, customer_id, supplier_id, debit_base, credit_base, transaction_amount, currency_id, exchange_rate_to_base, memo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [journalId, line.accountId, line.customerId, line.supplierId,
          line.debitBase, line.creditBase, line.debit || -line.credit, line.currencyId, line.exchangeRateToBase, line.memo]);
      }
      for (const attachment of attachments) {
        const name = path.basename(String(attachment.name || '')).slice(0, 255);
        const data = Buffer.from(attachment.data || []);
        if (!name || !data.length || data.length !== Number(attachment.size)) throw new Error('One of the selected attachments is invalid.');
        if (data.length > 10 * 1024 * 1024) throw new Error(`${name} exceeds the 10 MB attachment limit.`);
        const checksum = crypto.createHash('sha256').update(data).digest('hex');
        this.database.run(`INSERT INTO journal_attachments
          (journal_entry_id, original_name, mime_type, file_size, file_data, checksum_sha256, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, [journalId, name, String(attachment.mimeType || 'application/octet-stream'), data.length, data, checksum, createdBy]);
      }
      this.database.run(`UPDATE journal_entries SET status = 'POSTED', posted_at = CURRENT_TIMESTAMP WHERE id = ?`, [journalId]);
      return this.getJournalDetails(journalId);
    };
    return withinTransaction ? work() : this.transaction(work);
  }

  teardownJournal(journalId) {
    const journal = this.all('SELECT id, source_type FROM journal_entries WHERE id = ?', [Number(journalId)])[0];
    if (!journal) throw new Error('Journal entry was not found.');
    if (!['MANUAL', 'RECEIPT', 'PAYMENT'].includes(journal.source_type)) throw new Error('Edit or delete this entry from its source invoice history.');
    this.database.run("UPDATE journal_entries SET status = 'VOID' WHERE id = ?", [journal.id]);
    this.database.run('DELETE FROM journal_entries WHERE id = ?', [journal.id]);
  }

  updateManualJournal(journalId, input, attachments, createdBy) {
    return this.transaction(() => {
      const journal = this.all("SELECT id FROM journal_entries WHERE id = ? AND source_type = 'MANUAL'", [Number(journalId)])[0];
      if (!journal) throw new Error('Only manual journal entries can be edited here.');
      let savedAttachments = attachments;
      if (!savedAttachments.length) savedAttachments = this.all(`SELECT original_name AS name, mime_type AS mimeType, file_size AS size, file_data AS data
        FROM journal_attachments WHERE journal_entry_id = ?`, [journal.id]);
      this.teardownJournal(journal.id);
      return this.createManualJournal(input, savedAttachments, createdBy, true);
    });
  }

  deleteJournal(journalId) {
    return this.transaction(() => { this.teardownJournal(journalId); return true; });
  }

  getJournalAttachment(journalId, attachmentId) {
    return this.all(`SELECT id, journal_entry_id, original_name, mime_type, file_size, file_data, checksum_sha256
      FROM journal_attachments WHERE id = ? AND journal_entry_id = ?`, [Number(attachmentId), Number(journalId)])[0] || null;
  }
  getAccountingOverview() {
    return {
      accounts: this.all(`SELECT a.id, a.code, a.name, a.account_type, a.normal_balance, a.parent_id,
          a.is_control, a.is_active, a.description, ab.total_debit, ab.total_credit, ab.balance,
          coalesce((SELECT group_concat(ac.currency_id) FROM account_currencies ac WHERE ac.account_id = a.id), '') AS currency_ids,
          EXISTS(SELECT 1 FROM payment_methods pm WHERE pm.account_id = a.id AND pm.method_type = 'BANK' AND pm.is_active = 1) AS is_bank,
          (SELECT pm.bank_fee_account_id FROM payment_methods pm WHERE pm.account_id = a.id AND pm.method_type = 'BANK' AND pm.is_active = 1 LIMIT 1) AS bank_fee_account_id
        FROM accounts a JOIN account_balances ab ON ab.account_id = a.id
        WHERE a.is_active = 1 ORDER BY a.code`),
      customers: this.all('SELECT id, code, name FROM customers WHERE is_active = 1 ORDER BY code'),
      suppliers: this.all('SELECT id, code, name FROM suppliers WHERE is_active = 1 ORDER BY code'),
      currencies: this.all('SELECT id, code, name, symbol, is_base FROM currencies WHERE is_active = 1 ORDER BY is_base DESC, code'),
      paymentMethods: this.all(`SELECT pm.id, pm.code, pm.name, pm.method_type, pm.account_id, pm.bank_fee_account_id,
          fee.code AS bank_fee_account_code, fee.name AS bank_fee_account_name
        FROM payment_methods pm LEFT JOIN accounts fee ON fee.id = pm.bank_fee_account_id
        WHERE pm.is_active = 1 AND pm.method_type IN ('CASH', 'BANK') ORDER BY pm.id`),
      mappings: Object.fromEntries(this.all(`SELECT mapping_key, account_id FROM accounting_mappings
        WHERE mapping_key IN ('ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE')`).map(row => [row.mapping_key, Number(row.account_id)])),
      journals: this.listJournalEntries()
    };
  }

  listJournalEntries() {
    return this.all(`SELECT je.id, je.entry_number, je.entry_date, je.description, je.source_type,
        je.source_id, je.status, c.code AS currency_code, je.exchange_rate_to_base,
        coalesce(u.username, 'System') AS created_by_name, jeb.total_debit, jeb.total_credit, jeb.difference,
        (SELECT count(*) FROM journal_attachments ja WHERE ja.journal_entry_id = je.id) AS attachment_count,
        coalesce((SELECT group_concat(a.code || ' ' || a.name || ' ' || coalesce(cu.code || ' ' || cu.name, '') || ' ' || coalesce(su.code || ' ' || su.name, ''), ' ')
          FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
          LEFT JOIN customers cu ON cu.id = jl.customer_id LEFT JOIN suppliers su ON su.id = jl.supplier_id
          WHERE jl.journal_entry_id = je.id), '') AS search_text
      FROM journal_entries je
      JOIN currencies c ON c.id = je.currency_id
      LEFT JOIN users u ON u.id = je.created_by
      JOIN journal_entry_balances jeb ON jeb.journal_entry_id = je.id
      ORDER BY je.entry_date DESC, je.id DESC`);
  }

  getJournalDetails(journalId) {
    const header = this.all(`SELECT je.id, je.entry_number, je.entry_date, je.description, je.source_type,
        je.source_id, je.status, je.posted_at, c.code AS currency_code, je.exchange_rate_to_base,
        coalesce(u.username, 'System') AS created_by_name, jeb.total_debit, jeb.total_credit, jeb.difference
      FROM journal_entries je JOIN currencies c ON c.id = je.currency_id
      LEFT JOIN users u ON u.id = je.created_by
      JOIN journal_entry_balances jeb ON jeb.journal_entry_id = je.id WHERE je.id = ?`, [Number(journalId)])[0];
    if (!header) return null;
    return { ...header, lines: this.all(`SELECT jl.id, jl.account_id, jl.currency_id, a.code AS account_code, a.name AS account_name,
        p.name AS product_name, cu.id AS customer_id, cu.code AS customer_code, cu.name AS customer_name,
        su.id AS supplier_id, su.code AS supplier_code, su.name AS supplier_name,
        jl.debit_base, jl.credit_base, jl.transaction_amount, coalesce(c.code, (SELECT code FROM currencies WHERE is_base = 1 LIMIT 1)) AS transaction_currency, jl.exchange_rate_to_base, jl.memo
      FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
      LEFT JOIN products p ON p.id = jl.product_id LEFT JOIN currencies c ON c.id = jl.currency_id
      LEFT JOIN customers cu ON cu.id = jl.customer_id LEFT JOIN suppliers su ON su.id = jl.supplier_id
      WHERE jl.journal_entry_id = ? ORDER BY jl.id`, [Number(journalId)]),
      attachments: this.all(`SELECT id, original_name, mime_type, file_size, checksum_sha256, created_at
        FROM journal_attachments WHERE journal_entry_id = ? ORDER BY id`, [Number(journalId)]) };
  }

  getAccountLedger(accountId) {
    const account = this.all(`SELECT a.id, a.code, a.name, a.account_type, a.normal_balance,
        a.parent_id, a.is_control, ab.total_debit, ab.total_credit, ab.balance
      FROM accounts a JOIN account_balances ab ON ab.account_id = a.id WHERE a.id = ?`, [Number(accountId)])[0];
    if (!account) return null;
    const lines = this.all(`WITH RECURSIVE descendants(id) AS (
        SELECT id FROM accounts WHERE id = ?
        UNION ALL SELECT a.id FROM accounts a JOIN descendants d ON a.parent_id = d.id
      )
      SELECT jl.id, je.id AS journal_id, je.entry_number, je.entry_date, je.description,
        je.source_type, je.source_id, a.code AS account_code, a.name AS account_name,
        jl.debit_base, jl.credit_base, jl.transaction_amount, coalesce(c.code, (SELECT code FROM currencies WHERE is_base = 1 LIMIT 1)) AS transaction_currency, jl.exchange_rate_to_base, jl.memo
      FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
      JOIN accounts a ON a.id = jl.account_id LEFT JOIN currencies c ON c.id = jl.currency_id
      WHERE jl.account_id IN (SELECT id FROM descendants) AND je.status = 'POSTED'
      ORDER BY je.entry_date, je.id, jl.id`, [Number(accountId)]);
    return { account, lines };
  }

  createInventorySalvage(input, createdBy) {
    // Legacy entry point: mark available stock as salvage with optional write-down.
    // Prefer changeInventoryStatus for Damaged → Salvage workflow.
    const fromStatus = String(input?.fromStatus || 'AVAILABLE').toUpperCase();
    if (fromStatus === 'DAMAGED') {
      return this.changeInventoryStatus({
        action: 'MOVE_TO_SALVAGE',
        productId: input?.productId,
        warehouseId: input?.warehouseId,
        quantity: input?.quantity,
        operationDate: input?.operationDate,
        batchCode: input?.batchCode,
        expiryDate: input?.expiryDate,
        salvageUnitValue: input?.salvageUnitValue,
        notes: input?.notes
      }, createdBy);
    }
    const productId = Number(input?.productId);
    const warehouseId = Number(input?.warehouseId);
    const operationDate = String(input?.operationDate || '');
    const quantity = Number(input?.quantity);
    const salvageUnitValue = Number(input?.salvageUnitValue);
    const batchCode = this.normalizeInventoryKey(input?.batchCode);
    const expiryDate = this.normalizeInventoryKey(input?.expiryDate);
    if (!productId || !warehouseId) throw new Error('Product and warehouse are required.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(operationDate)) throw new Error('Enter a valid salvage date.');
    if (!(quantity > 0)) throw new Error('Salvage quantity must be greater than zero.');
    if (!(salvageUnitValue >= 0)) throw new Error('Salvage unit value cannot be negative.');

    return this.transaction(() => {
      const source = this.getBalanceRow(productId, warehouseId, 'AVAILABLE', batchCode, expiryDate);
      const product = this.all(`SELECT p.name AS product_name, w.name AS warehouse_name
        FROM products p CROSS JOIN warehouses w
        WHERE p.id = ? AND w.id = ? AND p.is_active = 1 AND w.is_active = 1`, [productId, warehouseId])[0];
      if (!product) throw new Error('The selected product warehouse was not found.');
      const available = Number(source?.quantity || 0);
      if (quantity > available + 0.000001) throw new Error(`Only ${available} available units are in this warehouse.`);
      const originalUnitCost = Number(source?.unit_cost_base || 0);
      if (!(originalUnitCost > 0)) throw new Error('This stock has no positive carrying cost to write down.');
      if (salvageUnitValue >= originalUnitCost) throw new Error(`Salvage value must be below the current average cost of ${originalUnitCost.toFixed(2)} SDG.`);
      const writeDown = Math.round(quantity * (originalUnitCost - salvageUnitValue) * 10000) / 10000;
      if (!(writeDown > 0)) throw new Error('The salvage write-down is too small to post.');
      const referenceCode = this.nextSalvageCode(operationDate);
      const notes = String(input?.notes || '').trim() || null;

      this.applyBalanceDelta(productId, warehouseId, 'AVAILABLE', batchCode, expiryDate, -quantity, originalUnitCost);
      this.applyBalanceDelta(productId, warehouseId, 'SALVAGE', batchCode, expiryDate, quantity, salvageUnitValue);
      this.insertInventoryMovement({
        movementDate: operationDate, productId, warehouseId, movementType: 'ADJUSTMENT_OUT',
        quantityChange: -quantity, unitCostBase: originalUnitCost, inventoryStatus: 'AVAILABLE',
        relatedStatus: 'SALVAGE', batchCode, expiryDate, referenceCode,
        notes: notes || 'Available → Salvage', createdBy
      });
      this.insertInventoryMovement({
        movementDate: operationDate, productId, warehouseId, movementType: 'ADJUSTMENT_IN',
        quantityChange: quantity, unitCostBase: salvageUnitValue, inventoryStatus: 'SALVAGE',
        relatedStatus: 'AVAILABLE', batchCode, expiryDate, referenceCode,
        notes: notes || 'Available → Salvage', createdBy
      });
      this.database.run(`INSERT INTO inventory_salvage_operations
        (reference_code, operation_date, product_id, warehouse_id, quantity, original_unit_cost_base,
         salvage_unit_value_base, write_down_base, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [referenceCode, operationDate, productId, warehouseId,
        quantity, originalUnitCost, salvageUnitValue, writeDown, notes, createdBy]);
      const operationId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      const journalId = this.postInventoryWriteDown({
        productId, operationDate, writeDown, referenceCode, createdBy, sourceId: operationId,
        memo: `Salvage write-down ${referenceCode}`
      });
      this.database.run(`UPDATE inventory_salvage_operations SET journal_entry_id = ? WHERE id = ?`, [journalId, operationId]);
      return { id: operationId, referenceCode, journalId, productName: product.product_name,
        warehouseName: product.warehouse_name, quantity, originalUnitCost, salvageUnitValue, writeDown,
        fromStatus: 'AVAILABLE', toStatus: 'SALVAGE' };
    });
  }

  getInventorySummary() {
    return this.all(`SELECT p.id AS product_id, p.sku, p.barcode, p.name AS product_name,
        c.name AS category_name, c.id AS category_id, u.name AS unit_name, w.id AS warehouse_id,
        w.name AS warehouse_name,
        stock.quantity_on_hand, stock.quantity_available, stock.quantity_reserved,
        stock.quantity_damaged, stock.quantity_salvage, stock.quantity_disposed,
        stock.movement_value_base, stock.available_value_base,
        CASE WHEN stock.quantity_available = 0 THEN 0
             ELSE round(stock.available_value_base / stock.quantity_available, 6) END AS average_unit_cost_base,
        CASE WHEN stock.quantity_on_hand = 0 THEN 0
             ELSE round(stock.movement_value_base / stock.quantity_on_hand, 6) END AS average_on_hand_cost_base,
        p.manual_sales_price, p.default_markup_percent,
        coalesce(salvage.operation_count, 0) AS salvage_operation_count,
        coalesce(salvage.salvage_quantity, 0) AS salvage_quantity,
        coalesce(salvage.salvage_value_base, 0) AS salvage_value_base,
        coalesce(salvage.write_down_base, 0) AS salvage_write_down_base
      FROM products p
      JOIN item_categories c ON c.id = p.category_id
      JOIN units u ON u.id = p.default_unit_id
      CROSS JOIN warehouses w
      JOIN inventory_stock stock ON stock.product_id = p.id AND stock.warehouse_id = w.id
      LEFT JOIN (SELECT product_id, warehouse_id, count(*) AS operation_count,
          round(sum(quantity), 6) AS salvage_quantity,
          round(sum(quantity * salvage_unit_value_base), 4) AS salvage_value_base,
          round(sum(write_down_base), 4) AS write_down_base
        FROM inventory_salvage_operations GROUP BY product_id, warehouse_id) salvage
        ON salvage.product_id = p.id AND salvage.warehouse_id = w.id
      WHERE p.is_active = 1 AND w.is_active = 1
      ORDER BY p.name COLLATE NOCASE, w.name COLLATE NOCASE`);
  }

  getInventoryMovements(productId) {
    return this.all(`SELECT im.id, im.movement_date, im.movement_type, im.quantity_change,
        im.unit_cost_base, im.total_cost_base, im.reference_code, im.notes,
        coalesce(im.inventory_status, 'AVAILABLE') AS inventory_status,
        im.related_status, coalesce(im.batch_code, '') AS batch_code,
        coalesce(im.expiry_date, '') AS expiry_date,
        w.name AS warehouse_name, p.name AS product_name, u.name AS unit_name
      FROM inventory_movements im
      JOIN products p ON p.id = im.product_id
      JOIN units u ON u.id = p.default_unit_id
      JOIN warehouses w ON w.id = im.warehouse_id
      WHERE im.product_id = ?
      ORDER BY im.movement_date DESC, im.id DESC`, [Number(productId)]);
  }

  getHrData() {
    return {
      employees: this.all(`SELECT e.*, coalesce(sum(CASE WHEN sc.type = 'allowance' AND sc.is_active = 1 THEN sc.amount ELSE 0 END), 0) AS recurring_allowances,
          coalesce(sum(CASE WHEN sc.type = 'deduction' AND sc.is_active = 1 THEN sc.amount ELSE 0 END), 0) AS recurring_deductions
        FROM employees e LEFT JOIN salary_components sc ON sc.employee_id = e.id GROUP BY e.id ORDER BY e.full_name COLLATE NOCASE`),
      salaryComponents: this.all('SELECT * FROM salary_components ORDER BY employee_id, type, name COLLATE NOCASE'),
      leaveTypes: this.all('SELECT * FROM leave_types ORDER BY id'),
      leaveBalances: this.all(`SELECT lb.*, e.employee_code, e.full_name, lt.name AS leave_type,
          round(lb.allocated_days - lb.used_days, 2) AS remaining_days
        FROM leave_balances lb JOIN employees e ON e.id = lb.employee_id JOIN leave_types lt ON lt.id = lb.leave_type_id
        ORDER BY lb.year DESC, e.full_name COLLATE NOCASE, lt.name COLLATE NOCASE`),
      leaveEntries: this.all(`SELECT le.*, e.employee_code, e.full_name, lt.name AS leave_type
        FROM leave_entries le JOIN employees e ON e.id = le.employee_id JOIN leave_types lt ON lt.id = le.leave_type_id
        ORDER BY le.date_from DESC, le.id DESC`),
      attendance: this.all(`SELECT ar.*, e.employee_code, e.full_name FROM attendance_records ar
        JOIN employees e ON e.id = ar.employee_id ORDER BY ar.date DESC, e.full_name COLLATE NOCASE`),
      payrollRuns: this.all('SELECT * FROM payroll_runs ORDER BY period_year DESC, period_month DESC, id DESC'),
      paymentMethods: this.all(`SELECT pm.id, pm.code, pm.name, pm.account_id FROM payment_methods pm JOIN accounts a ON a.id = pm.account_id
        WHERE pm.is_active = 1 AND pm.method_type IN ('CASH', 'BANK') AND a.is_active = 1 ORDER BY pm.id`),
      salaryGrades: this.all('SELECT * FROM salary_grades WHERE is_active = 1 ORDER BY code COLLATE NOCASE'),
      workingDays: Number(this.all("SELECT value FROM app_settings WHERE key = 'payroll_working_days'")[0]?.value || 30)
    };
  }

  saveEmployee(input) {
    const id = Number(input?.id) || null; const fullName = String(input?.fullName || '').trim();
    const employmentType = String(input?.employmentType || 'full_time'); const hireDate = String(input?.hireDate || '');
    const baseSalary = Math.round(Number(input?.baseSalary || 0) * 100) / 100;
    if (!fullName) throw new Error('Employee name is required.');
    if (!['full_time', 'part_time', 'contractor'].includes(employmentType)) throw new Error('Select a valid employment type.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) throw new Error('Enter a valid hire date.');
    if (!Number.isFinite(baseSalary) || baseSalary < 0) throw new Error('Enter a valid base salary.');
    const components = Array.isArray(input?.components) ? input.components : []; const salaryGradeId = Number(input?.salaryGradeId) || null;
    const grade = salaryGradeId ? this.all('SELECT * FROM salary_grades WHERE id = ? AND is_active = 1', [salaryGradeId])[0] : null;
    if (salaryGradeId && !grade) throw new Error('Select a valid salary grade.');
    if (grade && (baseSalary < Number(grade.minimum_salary) || (grade.maximum_salary != null && baseSalary > Number(grade.maximum_salary))))
      throw new Error(`Base salary must be within the ${grade.code} grade range.`);
    return this.transaction(() => {
      let employeeId = id;
      if (id) {
        const employee = this.all('SELECT id FROM employees WHERE id = ?', [id])[0];
        if (!employee) throw new Error('Employee was not found.');
        this.database.run(`UPDATE employees SET full_name = ?, phone = ?, email = ?, department = ?, job_title = ?, employment_type = ?,
          hire_date = ?, base_salary = ?, salary_grade_id = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [fullName, String(input?.phone || '').trim() || null, String(input?.email || '').trim() || null,
          String(input?.department || '').trim() || null, String(input?.jobTitle || '').trim() || null, employmentType,
          hireDate, baseSalary, salaryGradeId, String(input?.notes || '').trim() || null, id]);
      } else {
        const next = Number(this.all("SELECT coalesce(max(CAST(substr(employee_code, 5) AS INTEGER)), 0) + 1 AS n FROM employees")[0].n);
        const code = `EMP-${String(next).padStart(4, '0')}`;
        this.database.run(`INSERT INTO employees(employee_code, full_name, phone, email, department, job_title, employment_type, hire_date, base_salary, salary_grade_id, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [code, fullName, String(input?.phone || '').trim() || null,
          String(input?.email || '').trim() || null, String(input?.department || '').trim() || null,
          String(input?.jobTitle || '').trim() || null, employmentType, hireDate, baseSalary, salaryGradeId, String(input?.notes || '').trim() || null]);
        employeeId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      }
      this.database.run('DELETE FROM salary_components WHERE employee_id = ?', [employeeId]);
      for (const component of components) {
        const type = String(component?.type || ''); const name = String(component?.name || '').trim();
        const amount = Math.round(Number(component?.amount || 0) * 100) / 100;
        if (!['allowance', 'deduction'].includes(type) || !name || !Number.isFinite(amount) || amount < 0) throw new Error('Complete every salary component with a valid type, name, and amount.');
        this.database.run('INSERT INTO salary_components(employee_id, type, name, amount, is_active) VALUES (?, ?, ?, ?, 1)', [employeeId, type, name, amount]);
      }
      return employeeId;
    });
  }

  deactivateEmployee(employeeId) {
    if (!this.all('SELECT id FROM employees WHERE id = ?', [Number(employeeId)])[0]) throw new Error('Employee was not found.');
    this.run("UPDATE employees SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [Number(employeeId)]);
    return true;
  }

  saveAttendance(input, enteredBy) {
    const employeeId = Number(input?.employeeId); const date = String(input?.date || ''); const status = String(input?.status || '');
    if (!this.all('SELECT id FROM employees WHERE id = ?', [employeeId])[0]) throw new Error('Select a valid employee.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['present', 'absent', 'half_day', 'on_leave'].includes(status)) throw new Error('Enter a valid date and attendance status.');
    this.run(`INSERT INTO attendance_records(employee_id, date, status, notes, entered_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(employee_id, date) DO UPDATE SET status = excluded.status, notes = excluded.notes, entered_by = excluded.entered_by`,
      [employeeId, date, status, String(input?.notes || '').trim() || null, enteredBy || null]);
    return true;
  }

  deleteAttendance(id) { this.run('DELETE FROM attendance_records WHERE id = ?', [Number(id)]); return true; }

  saveLeaveBalance(input) {
    const employeeId = Number(input?.employeeId); const leaveTypeId = Number(input?.leaveTypeId); const year = Number(input?.year);
    const allocated = Math.round(Number(input?.allocatedDays || 0) * 100) / 100; const used = Math.round(Number(input?.usedDays || 0) * 100) / 100;
    if (!this.all('SELECT id FROM employees WHERE id = ?', [employeeId])[0] || !this.all('SELECT id FROM leave_types WHERE id = ?', [leaveTypeId])[0]) throw new Error('Select a valid employee and leave type.');
    if (!Number.isInteger(year) || year < 1900 || !Number.isFinite(allocated) || allocated < 0 || !Number.isFinite(used) || used < 0) throw new Error('Enter a valid year and leave balance.');
    this.run(`INSERT INTO leave_balances(employee_id, leave_type_id, year, allocated_days, used_days) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(employee_id, leave_type_id, year) DO UPDATE SET allocated_days = excluded.allocated_days, used_days = excluded.used_days`,
      [employeeId, leaveTypeId, year, allocated, used]); return true;
  }

  addLeaveEntry(input) {
    const employeeId = Number(input?.employeeId); const leaveTypeId = Number(input?.leaveTypeId);
    const from = String(input?.dateFrom || ''); const to = String(input?.dateTo || ''); const days = Math.round(Number(input?.daysCount || 0) * 100) / 100;
    if (!this.all('SELECT id FROM employees WHERE id = ?', [employeeId])[0] || !this.all('SELECT id FROM leave_types WHERE id = ?', [leaveTypeId])[0]) throw new Error('Select a valid employee and leave type.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from || !Number.isFinite(days) || days <= 0) throw new Error('Enter a valid leave period and day count.');
    return this.transaction(() => {
      this.database.run('INSERT INTO leave_entries(employee_id, leave_type_id, date_from, date_to, days_count, reason) VALUES (?, ?, ?, ?, ?, ?)',
        [employeeId, leaveTypeId, from, to, days, String(input?.reason || '').trim() || null]);
      const year = Number(from.slice(0, 4));
      this.database.run(`INSERT INTO leave_balances(employee_id, leave_type_id, year, allocated_days, used_days) VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(employee_id, leave_type_id, year) DO UPDATE SET used_days = used_days + excluded.used_days`, [employeeId, leaveTypeId, year, days]);
      return Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
    });
  }

  deleteLeaveEntry(id) {
    const entry = this.all('SELECT * FROM leave_entries WHERE id = ?', [Number(id)])[0]; if (!entry) return true;
    return this.transaction(() => {
      this.database.run('DELETE FROM leave_entries WHERE id = ?', [Number(id)]);
      this.database.run(`UPDATE leave_balances SET used_days = max(0, used_days - ?) WHERE employee_id = ? AND leave_type_id = ? AND year = ?`,
        [Number(entry.days_count), Number(entry.employee_id), Number(entry.leave_type_id), Number(String(entry.date_from).slice(0, 4))]); return true;
    });
  }

  getPayrollRun(runId) {
    const run = this.all('SELECT * FROM payroll_runs WHERE id = ?', [Number(runId)])[0]; if (!run) return null;
    run.items = this.all(`SELECT pri.*, e.employee_code, e.full_name, e.department, e.job_title FROM payroll_run_items pri
      JOIN employees e ON e.id = pri.employee_id WHERE pri.payroll_run_id = ? ORDER BY e.full_name COLLATE NOCASE`, [Number(runId)]);
    return run;
  }

  createPayrollRun(input, createdBy) {
    const month = Number(input?.periodMonth); const year = Number(input?.periodYear);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 1900) throw new Error('Select a valid payroll period.');
    if (this.all('SELECT id FROM payroll_runs WHERE period_month = ? AND period_year = ?', [month, year])[0]) throw new Error('A payroll run already exists for this period.');
    const employees = this.all("SELECT * FROM employees WHERE status = 'active' ORDER BY full_name COLLATE NOCASE");
    if (!employees.length) throw new Error('Add at least one active employee before creating payroll.');
    const workingDays = Number(this.all("SELECT value FROM app_settings WHERE key = 'payroll_working_days'")[0]?.value || 30);
    return this.transaction(() => {
      const prefix = `PAY-${year}${String(month).padStart(2, '0')}-`;
      const sequence = Number(this.all(`SELECT coalesce(max(CAST(substr(reference, ?) AS INTEGER)), 0) + 1 AS n FROM payroll_runs WHERE reference LIKE ?`, [prefix.length + 1, `${prefix}%`])[0].n);
      const reference = `${prefix}${String(sequence).padStart(4, '0')}`;
      this.database.run(`INSERT INTO payroll_runs(reference, period_month, period_year, created_by) VALUES (?, ?, ?, ?)`, [reference, month, year, createdBy || null]);
      const runId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      const from = `${year}-${String(month).padStart(2, '0')}-01`; const to = `${year}-${String(month).padStart(2, '0')}-31`;
      for (const employee of employees) {
        const components = this.all(`SELECT type, coalesce(sum(amount), 0) AS total FROM salary_components WHERE employee_id = ? AND is_active = 1 GROUP BY type`, [employee.id]);
        const componentTotal = type => Number(components.find(row => row.type === type)?.total || 0);
        const absences = Number(this.all(`SELECT count(*) AS total FROM attendance_records ar WHERE ar.employee_id = ? AND ar.status = 'absent'
          AND ar.date BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM leave_entries le WHERE le.employee_id = ar.employee_id AND ar.date BETWEEN le.date_from AND le.date_to)`, [employee.id, from, to])[0].total);
        const base = Number(employee.base_salary); const allowances = componentTotal('allowance'); const other = componentTotal('deduction');
        const absence = Math.round((base / workingDays) * absences * 100) / 100; const gross = Math.round((base + allowances) * 100) / 100;
        const net = Math.round((gross - absence - other) * 100) / 100;
        this.database.run(`INSERT INTO payroll_run_items(payroll_run_id, employee_id, base_salary, allowances_total, absence_deduction, other_deductions, gross_pay, net_pay)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [runId, employee.id, base, allowances, absence, other, gross, net]);
      }
      this.recalculatePayrollTotals(runId); return this.getPayrollRun(runId);
    });
  }

  recalculatePayrollTotals(runId) {
    this.database.run(`UPDATE payroll_runs SET total_gross = coalesce((SELECT round(sum(gross_pay), 2) FROM payroll_run_items WHERE payroll_run_id = payroll_runs.id), 0),
      total_deductions = coalesce((SELECT round(sum(absence_deduction + tax_amount + social_insurance_amount + other_deductions), 2) FROM payroll_run_items WHERE payroll_run_id = payroll_runs.id), 0),
      total_net = coalesce((SELECT round(sum(net_pay), 2) FROM payroll_run_items WHERE payroll_run_id = payroll_runs.id), 0), updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [Number(runId)]);
  }

  savePayrollRun(runId, input) {
    const run = this.getPayrollRun(runId); if (!run) throw new Error('Payroll run was not found.');
    if (!['DRAFT', 'REJECTED'].includes(run.workflow_state)) throw new Error('Submitted, approved, or paid payroll is locked.');
    const items = Array.isArray(input?.items) ? input.items : [];
    return this.transaction(() => {
      for (const item of items) {
        const existing = run.items.find(row => Number(row.id) === Number(item.id)); if (!existing) throw new Error('A payroll line was not found.');
        const value = key => { const number = Math.round(Number(item[key] || 0) * 100) / 100; if (!Number.isFinite(number) || number < 0) throw new Error('Payroll amounts cannot be negative.'); return number; };
        const base = run.status === 'finalized' ? Number(existing.base_salary) : value('baseSalary');
        const allowances = run.status === 'finalized' ? Number(existing.allowances_total) : value('allowancesTotal');
        const overtime = value('overtimeAmount'); const bonus = value('bonusAmount'); const absence = value('absenceDeduction');
        const tax = value('taxAmount'); const social = value('socialInsuranceAmount'); const other = value('otherDeductions');
        const gross = item.grossPayOverride ? value('grossPay') : Math.round((base + allowances + overtime + bonus) * 100) / 100;
        const net = item.netPayOverride ? value('netPay') : Math.round((gross - absence - tax - social - other) * 100) / 100;
        if (net < 0) throw new Error('Net pay cannot be negative.');
        this.database.run(`UPDATE payroll_run_items SET base_salary = ?, allowances_total = ?, overtime_amount = ?, bonus_amount = ?, absence_deduction = ?,
          tax_amount = ?, social_insurance_amount = ?, other_deductions = ?, gross_pay = ?, net_pay = ?, notes = ? WHERE id = ? AND payroll_run_id = ?`,
          [base, allowances, overtime, bonus, absence, tax, social, other, gross, net, String(item.notes || '').trim() || null, existing.id, run.id]);
      }
      this.recalculatePayrollTotals(run.id); return this.getPayrollRun(run.id);
    });
  }

  finalizePayrollRun(runId) {
    const run = this.getPayrollRun(runId); if (!run) throw new Error('Payroll run was not found.');
    if (run.status === 'posted') throw new Error('Posted payroll is already locked.');
    if (run.workflow_state !== 'DRAFT' && run.workflow_state !== 'REJECTED') throw new Error('Only draft or rejected payroll can be submitted.');
    this.transaction(() => {
      this.database.run("UPDATE payroll_runs SET status = 'finalized', workflow_state = 'SUBMITTED', submitted_by = coalesce(submitted_by, created_by), submitted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [run.id]);
      this.database.run(`INSERT INTO payroll_approval_history(payroll_run_id, action, acted_by)
        VALUES (?, 'SUBMITTED', coalesce((SELECT submitted_by FROM payroll_runs WHERE id = ?), 'admin'))`, [run.id, run.id]);
    });
    return this.getPayrollRun(run.id);
  }

  buildOperationalWorkflow(fromDate, toDate) {
    const inRange = (column, alias = '') => `${fromDate ? ` AND ${alias}${column} >= '${fromDate}'` : ''}${toDate ? ` AND ${alias}${column} <= '${toDate}'` : ''}`;
    const rows = [];
    for (const row of this.all(`SELECT 'Purchase Order' AS entity, po_number AS reference, order_date AS activity_date,
      approval_state AS status,
      CASE approval_state WHEN 'PENDING_COMMERCIAL' THEN 'Commercial approval'
        WHEN 'PENDING_FINANCE' THEN 'Financial approval' WHEN 'FINANCE_APPROVED' THEN 'Accounting handoff'
        WHEN 'COMMERCIAL_REJECTED' THEN 'Commercial rejection' WHEN 'FINANCE_REJECTED' THEN 'Financial rejection'
        ELSE 'Procurement preparation' END AS stage,
      coalesce(u.username, '-') AS owner, coalesce(sum(pol.line_total),0) AS amount
      FROM purchase_orders po LEFT JOIN users u ON u.id = po.created_by LEFT JOIN purchase_order_lines pol ON pol.purchase_order_id = po.id
      WHERE 1=1 ${inRange('order_date', 'po.')} GROUP BY po.id`)) rows.push(row);
    for (const row of this.all(`SELECT 'Purchase Invoice' AS entity, pi.invoice_code AS reference, pi.invoice_date AS activity_date,
      pi.workflow_state AS status, 'Funding / receipt' AS stage, s.name AS owner, pit.landed_total AS amount
      FROM purchase_invoices pi JOIN suppliers s ON s.id = pi.supplier_id JOIN purchase_invoice_totals pit ON pit.purchase_invoice_id = pi.id
      WHERE 1=1 ${inRange('invoice_date', 'pi.')}`)) rows.push(row);
    for (const row of this.all(`SELECT 'Disbursement Order' AS entity, pdo.order_number AS reference,
      substr(pdo.instructed_at,1,10) AS activity_date, pdo.status, 'Accounting to Treasury' AS stage,
      u.username AS owner, pdo.amount FROM purchase_disbursement_orders pdo JOIN users u ON u.id = pdo.instructed_by
      WHERE 1=1 ${inRange("substr(pdo.instructed_at,1,10)")}`)) rows.push(row);
    for (const row of this.all(`SELECT 'Goods Receipt' AS entity, gr.receipt_number AS reference, gr.receipt_date AS activity_date,
      gr.status, 'Warehouse' AS stage, u.username AS owner, 0 AS amount FROM goods_receipts gr JOIN users u ON u.id = gr.received_by
      WHERE 1=1 ${inRange('receipt_date', 'gr.')}`)) rows.push(row);
    for (const row of this.all(`SELECT 'Product Price' AS entity, p.name AS reference, substr(ppv.published_at,1,10) AS activity_date,
      ppv.status, 'Pricing' AS stage, u.username AS owner, ppv.minimum_sale_price AS amount
      FROM product_price_versions ppv JOIN products p ON p.id = ppv.product_id JOIN users u ON u.id = ppv.created_by
      WHERE 1=1 ${inRange("substr(ppv.published_at,1,10)")}`)) rows.push(row);
    for (const row of this.all(`SELECT 'Sales Return' AS entity, sr.return_number AS reference, sr.return_date AS activity_date,
      sr.status, 'Return settlement' AS stage, u.username AS owner,
      coalesce((SELECT sum(quantity * refund_unit_price) FROM sales_return_lines WHERE sales_return_id = sr.id),0) AS amount
      FROM sales_returns sr JOIN users u ON u.id = sr.requested_by WHERE 1=1 ${inRange('return_date', 'sr.')}`)) rows.push(row);
    for (const row of this.all(`SELECT 'Payroll' AS entity, pr.reference, printf('%04d-%02d-01',pr.period_year,pr.period_month) AS activity_date,
      pr.workflow_state AS status, 'Payroll approval' AS stage, coalesce(u.username,'-') AS owner, pr.total_net AS amount
      FROM payroll_runs pr LEFT JOIN users u ON u.id = pr.created_by WHERE 1=1`)) rows.push(row);
    rows.sort((left, right) => String(right.activity_date).localeCompare(String(left.activity_date)) || String(left.entity).localeCompare(String(right.entity)));
    return { title: 'Operational Workflow', subtitle: 'Approval, payment, receipt, pricing, return, and payroll lifecycle',
      columns: [{ key: 'entity', label: 'Entity' }, { key: 'reference', label: 'Reference' }, { key: 'activity_date', label: 'Date' },
        { key: 'stage', label: 'Stage' }, { key: 'status', label: 'Status' }, { key: 'owner', label: 'Owner' }, { key: 'amount', label: 'Amount / value', type: 'money' }],
      rows, summary: [{ label: 'Workflow records', value: rows.length }, { label: 'Pending decisions', value: rows.filter(row => ['PENDING','PENDING_COMMERCIAL','PENDING_FINANCE','SUBMITTED','COMMERCIAL_APPROVED','PENDING_TREASURY','PARTIALLY_EXECUTED'].includes(row.status)).length },
        { label: 'Completed', value: rows.filter(row => ['APPROVED','FINANCE_APPROVED','AUTHORIZED','RECEIVED','SETTLED','PAID','REFUNDED','PUBLISHED','CONFIRMED','EXECUTED'].includes(row.status)).length }] };
  }

  saveSalaryGrade(input) {
    const code = String(input?.code || '').trim(); const name = String(input?.name || '').trim();
    const minimum = Math.round(Number(input?.minimumSalary || 0) * 100) / 100;
    const maximum = input?.maximumSalary === '' || input?.maximumSalary == null ? null : Math.round(Number(input.maximumSalary) * 100) / 100;
    const defaultSalary = Math.round(Number(input?.defaultBaseSalary || 0) * 100) / 100;
    if (!code || !name || minimum < 0 || defaultSalary < 0 || (maximum != null && maximum < minimum)) throw new Error('Enter a valid salary grade and range.');
    this.run(`INSERT INTO salary_grades(code, name, minimum_salary, maximum_salary, default_base_salary)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, minimum_salary = excluded.minimum_salary,
      maximum_salary = excluded.maximum_salary, default_base_salary = excluded.default_base_salary, is_active = 1`,
      [code, name, minimum, maximum, defaultSalary]);
    return this.all('SELECT * FROM salary_grades WHERE is_active = 1 ORDER BY code COLLATE NOCASE');
  }

  decidePayrollRun(runId, action, comment, actedBy) {
    const id = Number(runId); const decision = String(action || '').toUpperCase(); const reason = String(comment || '').trim();
    if (!['APPROVE', 'REJECT'].includes(decision)) throw new Error('Choose approve or reject.');
    if (decision === 'REJECT' && !reason) throw new Error('Enter a rejection reason.');
    return this.transaction(() => {
      const run = this.getPayrollRun(id); if (!run || run.workflow_state !== 'SUBMITTED') throw new Error('Only submitted payroll can be decided.');
      const approved = decision === 'APPROVE';
      this.database.run(`UPDATE payroll_runs SET workflow_state = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP,
        approval_comment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [approved ? 'APPROVED' : 'REJECTED', actedBy, reason || null, id]);
      this.database.run(`INSERT INTO payroll_approval_history(payroll_run_id, action, comment, acted_by)
        VALUES (?, ?, ?, ?)`, [id, approved ? 'APPROVED' : 'REJECTED', reason || null, actedBy]);
      this.audit(actedBy, approved ? 'APPROVED' : 'REJECTED', 'PAYROLL_RUN', id, reason);
      return this.getPayrollRun(id);
    });
  }

  postPayrollRun(runId, paymentMethodId, createdBy) {
    const run = this.getPayrollRun(runId); if (!run) throw new Error('Payroll run was not found.');
    if (run.status !== 'finalized' || run.workflow_state !== 'APPROVED') throw new Error('Only finance-approved payroll can be paid.');
    if (String(run.approved_by || '') === String(createdBy)) throw new Error('The payroll approver cannot execute the same payment.');
    const payment = this.all(`SELECT pm.*, a.name AS account_name FROM payment_methods pm JOIN accounts a ON a.id = pm.account_id
      WHERE pm.id = ? AND pm.is_active = 1 AND pm.method_type IN ('CASH', 'BANK') AND a.is_active = 1`, [Number(paymentMethodId)])[0];
    if (!payment) throw new Error('Select a valid cash or bank account.');
    const expense = this.all("SELECT id FROM accounts WHERE name = 'Salaries & Wages Expense' COLLATE NOCASE AND account_type = 'EXPENSE' AND is_active = 1 AND is_control = 0")[0];
    const taxAccount = this.all("SELECT id FROM accounts WHERE name = 'Tax Payable' COLLATE NOCASE AND account_type = 'LIABILITY' AND is_active = 1 AND is_control = 0")[0];
    const socialAccount = this.all("SELECT id FROM accounts WHERE name = 'Social Insurance Payable' COLLATE NOCASE AND account_type = 'LIABILITY' AND is_active = 1 AND is_control = 0")[0];
    const tax = Math.round(run.items.reduce((sum, row) => sum + Number(row.tax_amount), 0) * 100) / 100;
    const social = Math.round(run.items.reduce((sum, row) => sum + Number(row.social_insurance_amount), 0) * 100) / 100;
    const expenseAdjustment = Math.round((Number(run.total_gross) - tax - social - Number(run.total_net)) * 100) / 100;
    if (!expense) throw new Error('Create an active detail account named Salaries & Wages Expense before posting payroll.');
    if (tax > 0 && !taxAccount) throw new Error('Create an active detail account named Tax Payable before posting payroll.');
    if (social > 0 && !socialAccount) throw new Error('Create an active detail account named Social Insurance Payable before posting payroll.');
    return this.transaction(() => {
      this.database.run(`INSERT INTO journal_entries(entry_number, entry_date, description, source_type, source_id, currency_id, exchange_rate_to_base, status, created_by)
        VALUES (?, date('now'), ?, 'MANUAL', ?, 1, 1, 'DRAFT', ?)`, [run.reference, `Payroll ${run.reference}`, run.id, createdBy || null]);
      const journalId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      const addDebit = (accountId, amount, memo) => this.database.run('INSERT INTO journal_lines(journal_entry_id, account_id, debit_base, memo) VALUES (?, ?, ?, ?)', [journalId, accountId, amount, memo]);
      const addCredit = (accountId, amount, memo) => this.database.run('INSERT INTO journal_lines(journal_entry_id, account_id, credit_base, memo) VALUES (?, ?, ?, ?)', [journalId, accountId, amount, memo]);
      addDebit(expense.id, Number(run.total_gross), `Gross payroll ${run.reference}`);
      if (expenseAdjustment > 0) addCredit(expense.id, expenseAdjustment, `Payroll deductions and overrides ${run.reference}`);
      if (expenseAdjustment < 0) addDebit(expense.id, Math.abs(expenseAdjustment), `Payroll net override ${run.reference}`);
      if (tax > 0) addCredit(taxAccount.id, tax, `Payroll tax payable ${run.reference}`);
      if (social > 0) addCredit(socialAccount.id, social, `Social insurance payable ${run.reference}`);
      addCredit(payment.account_id, Number(run.total_net), `Net payroll payment ${run.reference}`);
      this.database.run("UPDATE journal_entries SET status = 'POSTED', posted_at = CURRENT_TIMESTAMP WHERE id = ?", [journalId]);
      this.database.run("UPDATE payroll_runs SET status = 'posted', workflow_state = 'PAID', posted_journal_entry_id = ?, posted_account = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [journalId, payment.account_name, run.id]);
      this.database.run(`INSERT INTO payroll_approval_history(payroll_run_id, action, acted_by) VALUES (?, 'PAID', ?)`, [run.id, createdBy]);
      this.audit(createdBy, 'PAID', 'PAYROLL_RUN', run.id, '', { journalId, account: payment.account_name });
      return this.getPayrollRun(run.id);
    });
  }

  nextSalesReturnNumber(returnDate) {
    const prefix = `RET-${String(returnDate).replaceAll('-', '')}-`;
    const count = Number(this.all('SELECT count(*) AS total FROM sales_returns WHERE return_number LIKE ?', [`${prefix}%`])[0]?.total || 0);
    return `${prefix}${String(count + 1).padStart(4, '0')}`;
  }

  listSalesReturns() {
    return this.all(`SELECT sr.*, si.invoice_number, coalesce(si.customer_name_snapshot, cu.name, 'Walk-in customer') AS customer_name,
        coalesce((SELECT sum(srl.quantity * srl.refund_unit_price) FROM sales_return_lines srl WHERE srl.sales_return_id = sr.id), 0) AS return_total
      FROM sales_returns sr JOIN sales_invoices si ON si.id = sr.sales_invoice_id LEFT JOIN customers cu ON cu.id = si.customer_id
      ORDER BY sr.return_date DESC, sr.id DESC`);
  }

  createSalesReturn(input, requestedBy) {
    const saleId = Number(input?.salesInvoiceId); const returnDate = String(input?.returnDate || ''); const reason = String(input?.reason || '').trim();
    const lines = Array.isArray(input?.lines) ? input.lines : [];
    if (!saleId || !/^\d{4}-\d{2}-\d{2}$/.test(returnDate) || !reason || !lines.length) throw new Error('Sale, date, reason and return lines are required.');
    return this.transaction(() => {
      const sale = this.all("SELECT * FROM sales_invoices WHERE id = ? AND status = 'COMPLETED'", [saleId])[0];
      if (!sale) throw new Error('Only a completed sale can be returned.');
      const returnNumber = this.nextSalesReturnNumber(returnDate);
      this.database.run(`INSERT INTO sales_returns(return_number, sales_invoice_id, return_date, reason, status, requested_by)
        VALUES (?, ?, ?, ?, 'SUBMITTED', ?)`, [returnNumber, saleId, returnDate, reason, requestedBy]);
      const returnId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      for (const line of lines) {
        const saleLineId = Number(line.salesInvoiceLineId); const quantity = Number(line.quantity);
        const source = this.all('SELECT * FROM sales_invoice_lines WHERE id = ? AND sales_invoice_id = ?', [saleLineId, saleId])[0];
        if (!source || !(quantity > 0)) throw new Error('A return line is invalid.');
        const returned = Number(this.all(`SELECT coalesce(sum(srl.quantity),0) AS total FROM sales_return_lines srl
          JOIN sales_returns sr ON sr.id = srl.sales_return_id WHERE srl.sales_invoice_line_id = ? AND sr.status NOT IN ('REJECTED')`, [saleLineId])[0]?.total || 0);
        if (quantity + returned > Number(source.quantity) + 0.000001) throw new Error('Return quantity exceeds the net sold quantity.');
        const restock = ['AVAILABLE', 'DAMAGED', 'SALVAGE', 'DISPOSED'].includes(line.restockStatus) ? line.restockStatus : 'AVAILABLE';
        this.database.run(`INSERT INTO sales_return_lines(sales_return_id, sales_invoice_line_id, quantity, restock_status, refund_unit_price)
          VALUES (?, ?, ?, ?, ?)`, [returnId, saleLineId, quantity, restock, source.unit_price]);
      }
      this.database.run(`INSERT INTO sales_return_approval_history(sales_return_id, action, acted_by) VALUES (?, 'SUBMITTED', ?)`, [returnId, requestedBy]);
      this.audit(requestedBy, 'SUBMITTED', 'SALES_RETURN', returnId, reason);
      return this.listSalesReturns().find(row => Number(row.id) === returnId);
    });
  }

  decideSalesReturn(returnId, action, comment, actedBy) {
    const id = Number(returnId); const decision = String(action || '').toUpperCase(); const reason = String(comment || '').trim();
    return this.transaction(() => {
      const record = this.all('SELECT * FROM sales_returns WHERE id = ?', [id])[0]; if (!record) throw new Error('Sales return was not found.');
      let status; let column = null;
      if (decision === 'COMMERCIAL_APPROVE' && record.status === 'SUBMITTED') { status = 'COMMERCIAL_APPROVED'; column = 'commercial_approved_by'; }
      else if (decision === 'FINANCE_APPROVE' && record.status === 'COMMERCIAL_APPROVED') { status = 'FINANCE_APPROVED'; column = 'finance_approved_by'; }
      else if (decision === 'REJECT' && ['SUBMITTED', 'COMMERCIAL_APPROVED'].includes(record.status)) { if (!reason) throw new Error('Enter a rejection reason.'); status = 'REJECTED'; }
      else throw new Error('This return decision is not allowed in its current state.');
      if (column) this.database.run(`UPDATE sales_returns SET status = ?, ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [status, actedBy, id]);
      else this.database.run("UPDATE sales_returns SET status = 'REJECTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
      this.database.run(`INSERT INTO sales_return_approval_history(sales_return_id, action, comment, acted_by) VALUES (?, ?, ?, ?)`, [id, decision, reason || null, actedBy]);
      this.audit(actedBy, decision, 'SALES_RETURN', id, reason);
      return this.listSalesReturns().find(row => Number(row.id) === id);
    });
  }

  settleSalesReturn(returnId, paymentMethodId, executedBy) {
    const id = Number(returnId);
    return this.transaction(() => {
      const record = this.all(`SELECT sr.*, si.currency_id, si.exchange_rate_to_base, si.customer_id,
          coalesce((SELECT im.warehouse_id FROM inventory_movements im JOIN sales_invoice_lines sil ON sil.id = im.sales_line_id
            WHERE sil.sales_invoice_id = si.id LIMIT 1), 1) AS warehouse_id
        FROM sales_returns sr JOIN sales_invoices si ON si.id = sr.sales_invoice_id WHERE sr.id = ?`, [id])[0];
      if (!record || record.status !== 'FINANCE_APPROVED') throw new Error('The return requires commercial and finance approval before settlement.');
      if (String(record.finance_approved_by) === String(executedBy)) throw new Error('The finance approver cannot execute the same refund.');
      const payment = this.all(`SELECT * FROM payment_methods WHERE id = ? AND is_active = 1 AND method_type IN ('CASH','BANK')`, [Number(paymentMethodId)])[0];
      if (!payment) throw new Error('Select an active cash or bank refund method.');
      const lines = this.all(`SELECT srl.*, sil.product_id, sil.unit_price,
          coalesce((SELECT sum(abs(im.quantity_change) * im.unit_cost_base) / nullif(sum(abs(im.quantity_change)),0)
            FROM inventory_movements im WHERE im.sales_line_id = sil.id AND im.movement_type = 'SALE'), 0) AS unit_cost_base
        FROM sales_return_lines srl JOIN sales_invoice_lines sil ON sil.id = srl.sales_invoice_line_id WHERE srl.sales_return_id = ?`, [id]);
      const refundTransaction = lines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.refund_unit_price), 0);
      const refundBase = Math.round(refundTransaction * Number(record.exchange_rate_to_base) * 10000) / 10000;
      const returnNumber = record.return_number;
      this.database.run(`INSERT INTO journal_entries(entry_number, entry_date, description, source_type, source_id,
        currency_id, exchange_rate_to_base, status, created_by) VALUES (?, ?, ?, 'MANUAL', ?, ?, ?, 'DRAFT', ?)`,
        [`JE-${returnNumber}`, record.return_date, `Sales return ${returnNumber}`, id, record.currency_id, record.exchange_rate_to_base, executedBy]);
      const journalId = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
      this.database.run('INSERT INTO journal_lines(journal_entry_id, account_id, debit_base, memo) VALUES (?, 4100, ?, ?)', [journalId, refundBase, returnNumber]);
      this.database.run('INSERT INTO journal_lines(journal_entry_id, account_id, credit_base, memo) VALUES (?, ?, ?, ?)', [journalId, payment.account_id, refundBase, returnNumber]);
      let restockBase = 0;
      for (const line of lines) {
        if (line.restock_status === 'DISPOSED') continue;
        const unitCost = Number(line.unit_cost_base); const quantity = Number(line.quantity); restockBase += unitCost * quantity;
        this.applyBalanceDelta(line.product_id, record.warehouse_id, line.restock_status, '', '', quantity, unitCost);
        this.insertInventoryMovement({ movementDate: record.return_date, productId: line.product_id, warehouseId: record.warehouse_id,
          movementType: 'ADJUSTMENT_IN', quantityChange: quantity, unitCostBase: unitCost, inventoryStatus: line.restock_status,
          referenceCode: returnNumber, notes: record.reason, createdBy: executedBy });
      }
      if (restockBase > 0) {
        this.database.run('INSERT INTO journal_lines(journal_entry_id, account_id, debit_base, memo) VALUES (?, 1300, ?, ?)', [journalId, restockBase, returnNumber]);
        this.database.run('INSERT INTO journal_lines(journal_entry_id, account_id, credit_base, memo) VALUES (?, 5100, ?, ?)', [journalId, restockBase, returnNumber]);
      }
      this.database.run("UPDATE journal_entries SET status = 'POSTED', posted_at = CURRENT_TIMESTAMP WHERE id = ?", [journalId]);
      const refundNumber = `RF-${returnNumber.slice(4)}`;
      this.database.run(`INSERT INTO refunds(refund_number, sales_return_id, payment_method_id, amount, journal_entry_id, executed_by)
        VALUES (?, ?, ?, ?, ?, ?)`, [refundNumber, id, payment.id, refundTransaction, journalId, executedBy]);
      this.database.run("UPDATE sales_returns SET status = 'REFUNDED', journal_entry_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [journalId, id]);
      this.audit(executedBy, 'REFUNDED', 'SALES_RETURN', id, '', { refundNumber, refundTransaction, journalId });
      return { refundNumber, refundTransaction, journalId };
    });
  }
  getInfo() {
    const version = this.all('PRAGMA user_version')[0]?.user_version || 0;
    const tables = this.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).map(row => row.name);
    return { filePath: this.filePath, schemaVersion: version, tableCount: tables.length, tables };
  }
}

function assignMissingProductBarcodes(database) {
  const statement = database.prepare(`SELECT id FROM products WHERE barcode IS NULL OR trim(barcode) = '' ORDER BY id`);
  const productIds = [];
  try { while (statement.step()) productIds.push(Number(statement.getAsObject().id)); } finally { statement.free(); }
  const barcodeExists = (barcode, productId) => {
    const check = database.prepare('SELECT id FROM products WHERE barcode = ? AND id <> ? LIMIT 1');
    try { check.bind([barcode, productId]); return check.step(); } finally { check.free(); }
  };
  for (const productId of productIds) {
    let barcode = null;
    for (let prefix = 20; prefix <= 29 && !barcode; prefix += 1) {
      const candidate = generateInternalEan13(productId, String(prefix));
      if (!barcodeExists(candidate, productId)) barcode = candidate;
    }
    if (!barcode) throw new Error(`Unable to allocate a barcode for product ${productId}.`);
    database.run('UPDATE products SET barcode = ? WHERE id = ?', [barcode, productId]);
  }
}

function migrateDatabase(database) {
  const tableColumns = table => {
    const names = new Set(); const statement = database.prepare(`PRAGMA table_info(${table})`);
    try { while (statement.step()) names.add(String(statement.getAsObject().name)); } finally { statement.free(); }
    return names;
  };
  const ensureColumns = (table, additions) => {
    const columns = tableColumns(table);
    for (const [name, definition] of Object.entries(additions)) {
      if (!columns.has(name)) database.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };

  const permissionTableSql = database.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_permissions'");
  const permissionDefinition = String(permissionTableSql?.[0]?.values?.[0]?.[0] || '');
  if (permissionDefinition && !permissionDefinition.includes("'treasury'")) {
    database.run('ALTER TABLE user_permissions RENAME TO user_permissions_legacy');
  }
  database.run(`CREATE TABLE IF NOT EXISTS user_permissions (
    user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
    screen_key TEXT NOT NULL CHECK (screen_key IN ('dashboard', 'sales', 'inventory', 'treasury', 'journalAccount', 'accounting', 'hr', 'reports')),
    access_level TEXT NOT NULL CHECK (access_level IN ('view', 'manage')),
    PRIMARY KEY (user_id, screen_key))`);
  if (permissionDefinition && !permissionDefinition.includes("'treasury'")) {
    database.run(`INSERT OR IGNORE INTO user_permissions(user_id, screen_key, access_level)
      SELECT user_id, screen_key, access_level FROM user_permissions_legacy`);
    database.run('DROP TABLE user_permissions_legacy');
  }
  ensureColumns('users', { job_profile: "TEXT NOT NULL DEFAULT 'Staff'", password_hash: 'TEXT' });
  database.run("UPDATE users SET job_profile = 'System Administrator' WHERE role = 'System Administrator' AND (job_profile IS NULL OR job_profile = 'Staff')");
  const legacyPasswords = [];
  const legacyPasswordStatement = database.prepare("SELECT id, password FROM users WHERE (password_hash IS NULL OR password_hash = '') AND password <> ''");
  try { while (legacyPasswordStatement.step()) legacyPasswords.push(legacyPasswordStatement.getAsObject()); }
  finally { legacyPasswordStatement.free(); }
  for (const user of legacyPasswords) database.run("UPDATE users SET password_hash = ?, password = '' WHERE id = ?", [hashPassword(user.password), user.id]);
  const capabilityTableSql = database.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_capabilities'");
  const capabilityDefinition = String(capabilityTableSql?.[0]?.values?.[0]?.[0] || '');
  if (capabilityDefinition.includes('CHECK')) {
    database.run('ALTER TABLE user_capabilities RENAME TO user_capabilities_legacy');
    database.run(`CREATE TABLE user_capabilities (
      user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      capability_key TEXT NOT NULL,
      PRIMARY KEY (user_id, capability_key))`);
    database.run(`INSERT OR IGNORE INTO user_capabilities(user_id, capability_key)
      SELECT user_id, capability_key FROM user_capabilities_legacy`);
    database.run('DROP TABLE user_capabilities_legacy');
  } else {
    database.run(`CREATE TABLE IF NOT EXISTS user_capabilities (
      user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
      capability_key TEXT NOT NULL,
      PRIMARY KEY (user_id, capability_key))`);
  }
  database.run(`INSERT OR IGNORE INTO user_capabilities(user_id, capability_key)
    SELECT user_id, 'purchase_order_submit' FROM user_permissions WHERE screen_key = 'inventory' AND access_level = 'manage'`);
  database.run(`INSERT OR IGNORE INTO user_capabilities(user_id, capability_key)
    SELECT user_id, 'treasury_receipt_post' FROM user_permissions WHERE screen_key = 'journalAccount' AND access_level = 'manage'`);
  database.run(`INSERT OR IGNORE INTO user_capabilities(user_id, capability_key)
    SELECT user_id, 'treasury_payment_post' FROM user_permissions WHERE screen_key = 'journalAccount' AND access_level = 'manage'`);

  database.run(`CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_number TEXT NOT NULL UNIQUE,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    order_date TEXT NOT NULL,
    expected_delivery_date TEXT,
    currency_id INTEGER NOT NULL REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    exchange_rate_to_base REAL NOT NULL DEFAULT 1 CHECK (exchange_rate_to_base > 0),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    supplier_reference TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'OPEN', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED', 'CLOSED')),
    created_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  database.run(`CREATE TABLE IF NOT EXISTS purchase_order_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    description TEXT,
    ordered_quantity REAL NOT NULL CHECK (ordered_quantity > 0),
    unit_id INTEGER NOT NULL REFERENCES units(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    unit_quantity REAL NOT NULL DEFAULT 1 CHECK (unit_quantity > 0),
    unit_price REAL NOT NULL CHECK (unit_price > 0),
    cancelled_quantity REAL NOT NULL DEFAULT 0 CHECK (cancelled_quantity >= 0 AND cancelled_quantity <= ordered_quantity),
    line_total REAL GENERATED ALWAYS AS (round(ordered_quantity * unit_quantity * unit_price, 4)) STORED)`);
  database.run('CREATE INDEX IF NOT EXISTS purchase_order_lines_order_idx ON purchase_order_lines(purchase_order_id)');
  database.run('CREATE INDEX IF NOT EXISTS purchase_orders_supplier_idx ON purchase_orders(supplier_id, order_date)');
  const purchaseOrderSql = String(database.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'purchase_orders'")?.[0]?.values?.[0]?.[0] || '');
  if (purchaseOrderSql && !purchaseOrderSql.includes('PENDING_COMMERCIAL')) {
    database.run('PRAGMA foreign_keys = OFF');
    database.run(`CREATE TABLE purchase_orders_v11 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_number TEXT NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      order_date TEXT NOT NULL,
      expected_delivery_date TEXT,
      currency_id INTEGER NOT NULL REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      exchange_rate_to_base REAL NOT NULL DEFAULT 1 CHECK (exchange_rate_to_base > 0),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      supplier_reference TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'OPEN', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED', 'CLOSED')),
      created_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      approval_state TEXT NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (approval_state IN ('NOT_SUBMITTED', 'PENDING_COMMERCIAL', 'PENDING_FINANCE', 'FINANCE_APPROVED', 'COMMERCIAL_REJECTED', 'FINANCE_REJECTED')),
      submitted_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      submitted_at TEXT,
      commercial_approved_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      commercial_approved_at TEXT,
      commercial_approval_comment TEXT,
      financial_approved_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      financial_approved_at TEXT,
      financial_approval_comment TEXT,
      accounting_handoff_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    database.run(`INSERT INTO purchase_orders_v11(id, po_number, supplier_id, order_date, expected_delivery_date, currency_id,
      exchange_rate_to_base, warehouse_id, supplier_reference, notes, status, created_by, approval_state, submitted_by,
      submitted_at, financial_approved_by, financial_approved_at, financial_approval_comment, accounting_handoff_at, created_at, updated_at)
      SELECT id, po_number, supplier_id, order_date, expected_delivery_date, currency_id, exchange_rate_to_base, warehouse_id,
        supplier_reference, notes, status, created_by,
        CASE approval_state WHEN 'PENDING' THEN 'PENDING_COMMERCIAL' WHEN 'APPROVED' THEN 'FINANCE_APPROVED'
          WHEN 'REJECTED' THEN 'FINANCE_REJECTED' ELSE 'NOT_SUBMITTED' END,
        submitted_by, submitted_at,
        CASE WHEN approval_state IN ('APPROVED','REJECTED') THEN approved_by END,
        CASE WHEN approval_state IN ('APPROVED','REJECTED') THEN approved_at END,
        CASE WHEN approval_state IN ('APPROVED','REJECTED') THEN approval_comment END,
        CASE WHEN approval_state = 'APPROVED' THEN coalesce(approved_at, CURRENT_TIMESTAMP) END,
        created_at, updated_at FROM purchase_orders`);
    database.run(`CREATE TABLE purchase_order_approval_history_v11 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders_v11(id) ON UPDATE CASCADE ON DELETE CASCADE,
      action TEXT NOT NULL CHECK (action IN ('SUBMITTED_TO_COMMERCIAL', 'COMMERCIAL_APPROVED', 'COMMERCIAL_REJECTED',
        'ROUTED_TO_FINANCE', 'FINANCE_APPROVED', 'FINANCE_REJECTED', 'HANDED_TO_ACCOUNTING', 'RECALLED', 'LEGACY_MIGRATED')),
      comment TEXT, acted_by TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      acted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    database.run(`INSERT INTO purchase_order_approval_history_v11(id, purchase_order_id, action, comment, acted_by, acted_at)
      SELECT id, purchase_order_id,
        CASE action WHEN 'SUBMITTED' THEN 'SUBMITTED_TO_COMMERCIAL' WHEN 'APPROVED' THEN 'FINANCE_APPROVED'
          WHEN 'REJECTED' THEN 'FINANCE_REJECTED' ELSE 'RECALLED' END,
        comment, acted_by, acted_at FROM purchase_order_approval_history`);
    database.run(`INSERT INTO purchase_order_approval_history_v11(purchase_order_id, action, comment, acted_by, acted_at)
      SELECT id, 'LEGACY_MIGRATED', 'Migrated from the legacy single-stage PO approval workflow',
        coalesce(financial_approved_by, submitted_by, created_by, 'admin'), coalesce(financial_approved_at, updated_at, CURRENT_TIMESTAMP)
      FROM purchase_orders_v11 WHERE approval_state IN ('FINANCE_APPROVED', 'FINANCE_REJECTED')`);
    database.run('DROP TABLE purchase_order_approval_history');
    database.run('DROP TABLE purchase_orders');
    database.run('ALTER TABLE purchase_orders_v11 RENAME TO purchase_orders');
    database.run('ALTER TABLE purchase_order_approval_history_v11 RENAME TO purchase_order_approval_history');
    database.run('PRAGMA foreign_keys = ON');
  }
  ensureColumns('purchase_orders', {
    approval_state: "TEXT NOT NULL DEFAULT 'NOT_SUBMITTED'",
    submitted_by: 'TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT', submitted_at: 'TEXT',
    commercial_approved_by: 'TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT', commercial_approved_at: 'TEXT', commercial_approval_comment: 'TEXT',
    financial_approved_by: 'TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT', financial_approved_at: 'TEXT', financial_approval_comment: 'TEXT',
    accounting_handoff_at: 'TEXT'
  });
  database.run(`CREATE TABLE IF NOT EXISTS purchase_order_approval_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN ('SUBMITTED_TO_COMMERCIAL', 'COMMERCIAL_APPROVED', 'COMMERCIAL_REJECTED',
      'ROUTED_TO_FINANCE', 'FINANCE_APPROVED', 'FINANCE_REJECTED', 'HANDED_TO_ACCOUNTING', 'RECALLED', 'LEGACY_MIGRATED')),
    comment TEXT, acted_by TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    acted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  database.run('CREATE INDEX IF NOT EXISTS purchase_order_approval_history_order_idx ON purchase_order_approval_history(purchase_order_id, acted_at)');
  ensureColumns('purchase_invoices', {
    supplier_invoice_number: 'TEXT', purchase_order_id: 'INTEGER REFERENCES purchase_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    stock_posted_by: 'TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT', stock_posted_at: 'TEXT',
    stock_warehouse_id: 'INTEGER REFERENCES warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    workflow_state: "TEXT NOT NULL DEFAULT 'DRAFT'", submitted_by: 'TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT', submitted_at: 'TEXT'
  });
  ensureColumns('supplier_payments', {
    disbursement_order_id: 'INTEGER REFERENCES purchase_disbursement_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    payment_mode: "TEXT NOT NULL DEFAULT 'SUPPLIER'",
    recipient_user_id: 'TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    advance_applied_amount: 'REAL NOT NULL DEFAULT 0'
  });
  database.run(`UPDATE purchase_invoices SET workflow_state = CASE status
    WHEN 'RECEIVED' THEN 'RECEIVED' WHEN 'VOID' THEN 'CANCELLED' ELSE coalesce(workflow_state, 'DRAFT') END`);
  database.run(`UPDATE purchase_invoices SET stock_warehouse_id = coalesce(
      (SELECT po.warehouse_id FROM purchase_orders po WHERE po.id = purchase_invoices.purchase_order_id),
      (SELECT im.warehouse_id FROM inventory_movements im JOIN purchase_invoice_lines pil ON pil.id = im.purchase_line_id
        WHERE pil.purchase_invoice_id = purchase_invoices.id LIMIT 1))
    WHERE stock_warehouse_id IS NULL`);
  ensureColumns('sales_invoices', { customer_name_snapshot: 'TEXT' });
  ensureColumns('sales_invoice_lines', { published_unit_price: 'REAL', price_version_id: 'INTEGER REFERENCES product_price_versions(id) ON UPDATE CASCADE ON DELETE RESTRICT' });
  database.run(`UPDATE sales_invoices SET customer_name_snapshot = (SELECT name FROM customers WHERE id = sales_invoices.customer_id)
    WHERE customer_id IS NOT NULL AND customer_name_snapshot IS NULL`);
  ensureColumns('purchase_invoice_lines', {
    purchase_order_line_id: 'INTEGER REFERENCES purchase_order_lines(id) ON UPDATE CASCADE ON DELETE RESTRICT'
  });
  ensureColumns('employees', { salary_grade_id: 'INTEGER REFERENCES salary_grades(id) ON UPDATE CASCADE ON DELETE SET NULL' });
  ensureColumns('payroll_runs', {
    workflow_state: "TEXT NOT NULL DEFAULT 'DRAFT'", submitted_by: 'TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    submitted_at: 'TEXT', approved_by: 'TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT', approved_at: 'TEXT', approval_comment: 'TEXT'
  });
  database.run(`UPDATE payroll_runs SET workflow_state = CASE status
    WHEN 'posted' THEN 'PAID' WHEN 'finalized' THEN 'APPROVED' ELSE coalesce(workflow_state, 'DRAFT') END`);
  database.run('CREATE INDEX IF NOT EXISTS purchase_lines_order_line_idx ON purchase_invoice_lines(purchase_order_line_id)');
  database.run(`CREATE INDEX IF NOT EXISTS purchase_supplier_invoice_idx
    ON purchase_invoices(supplier_id, supplier_invoice_number)
    WHERE supplier_invoice_number IS NOT NULL AND trim(supplier_invoice_number) <> ''`);
  database.run(`CREATE TABLE IF NOT EXISTS invoice_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_type TEXT NOT NULL CHECK (invoice_type IN ('SALE', 'PURCHASE')),
    invoice_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL CHECK (file_size >= 0),
    file_data BLOB NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    created_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  database.run('CREATE INDEX IF NOT EXISTS invoice_attachments_owner_idx ON invoice_attachments(invoice_type, invoice_id)');
  ensureColumns('purchase_additional_costs', {
    cost_invoice_date: 'TEXT', supplier_id: 'INTEGER REFERENCES suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    journal_entry_id: 'INTEGER REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    created_by: 'TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT', created_at: 'TEXT'
  });
  ensureColumns('item_categories', { parent_id: 'INTEGER REFERENCES item_categories(id) ON UPDATE CASCADE ON DELETE RESTRICT' });
  ensureColumns('suppliers', { code: 'TEXT' });
  ensureColumns('customers', { code: 'TEXT' });
  ensureColumns('payment_methods', { bank_fee_account_id: 'INTEGER REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT' });
  ensureColumns('products', { barcode: 'TEXT' });
  assignMissingProductBarcodes(database);
  database.run('CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_idx ON products(barcode) WHERE barcode IS NOT NULL');
  database.run(`INSERT OR IGNORE INTO accounts(code, name, account_type, normal_balance, parent_id, is_control) VALUES
    ('6210', 'Bankak Bank Fees', 'EXPENSE', 'DEBIT', 6200, 0),
    ('6220', 'OCash Bank Fees', 'EXPENSE', 'DEBIT', 6200, 0),
    ('6230', 'Fawry Bank Fees', 'EXPENSE', 'DEBIT', 6200, 0),
    ('6240', 'MyCashi Bank Fees', 'EXPENSE', 'DEBIT', 6200, 0)`);
  database.run(`UPDATE payment_methods SET bank_fee_account_id = CASE code
    WHEN 'BANKAK' THEN (SELECT id FROM accounts WHERE code = '6210')
    WHEN 'OCASH' THEN (SELECT id FROM accounts WHERE code = '6220')
    WHEN 'FAWRY' THEN (SELECT id FROM accounts WHERE code = '6230')
    WHEN 'MYCASHI' THEN (SELECT id FROM accounts WHERE code = '6240')
    ELSE bank_fee_account_id END
    WHERE method_type = 'BANK' AND bank_fee_account_id IS NULL`);
  database.run(`CREATE TABLE IF NOT EXISTS account_currencies (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE CASCADE,
    currency_id INTEGER NOT NULL REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE CASCADE,
    PRIMARY KEY (account_id, currency_id))`);
  database.run("INSERT OR IGNORE INTO currencies(id, code, name, symbol, is_base, is_active) VALUES (3, 'AED', 'UAE Dirham', 'AED', 0, 1)");
  database.run(`INSERT OR IGNORE INTO account_currencies(account_id, currency_id)
    SELECT a.id, c.id FROM accounts a CROSS JOIN currencies c
    WHERE a.is_active = 1 AND c.is_active = 1
      AND NOT EXISTS (SELECT 1 FROM account_currencies existing WHERE existing.account_id = a.id)`);
  const needsJournalLineRateMigration = !tableColumns('journal_lines').has('exchange_rate_to_base');
  ensureColumns('journal_lines', {
    customer_id: 'INTEGER REFERENCES customers(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    supplier_id: 'INTEGER REFERENCES suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    exchange_rate_to_base: 'REAL NOT NULL DEFAULT 1 CHECK (exchange_rate_to_base > 0)'
  });
  if (needsJournalLineRateMigration) {
    database.run('DROP TRIGGER IF EXISTS journal_lines_no_update_posted');
    database.run(`UPDATE journal_lines SET exchange_rate_to_base = coalesce((
        SELECT je.exchange_rate_to_base FROM journal_entries je WHERE je.id = journal_lines.journal_entry_id
      ), 1) WHERE transaction_amount IS NOT NULL AND currency_id IS NOT NULL AND exchange_rate_to_base = 1`);
    database.run(`CREATE TRIGGER journal_lines_no_update_posted
      BEFORE UPDATE ON journal_lines
      WHEN (SELECT status FROM journal_entries WHERE id = OLD.journal_entry_id) = 'POSTED'
      BEGIN SELECT RAISE(ABORT, 'Posted journal lines cannot be changed'); END`);
  }
  database.run(`UPDATE suppliers SET code = 'SUP-' || printf('%06d', id) WHERE code IS NULL OR trim(code) = ''`);
  database.run(`UPDATE customers SET code = 'CUS-' || printf('%06d', id) WHERE code IS NULL OR trim(code) = ''`);
  database.run(`CREATE UNIQUE INDEX IF NOT EXISTS suppliers_code_idx ON suppliers(code)`);
  database.run(`CREATE UNIQUE INDEX IF NOT EXISTS customers_code_idx ON customers(code)`);
  database.run(`CREATE UNIQUE INDEX IF NOT EXISTS purchase_costs_journal_idx
    ON purchase_additional_costs(journal_entry_id) WHERE journal_entry_id IS NOT NULL`);
  database.run('DROP TRIGGER IF EXISTS journal_validate_posting');
  database.run(`CREATE TRIGGER journal_validate_posting
    BEFORE UPDATE OF status ON journal_entries
    WHEN NEW.status = 'POSTED' AND OLD.status <> 'POSTED'
    BEGIN
      SELECT CASE WHEN (SELECT count(*) FROM journal_lines WHERE journal_entry_id = NEW.id) < 2
        THEN RAISE(ABORT, 'A posted journal entry requires at least two lines') END;
      SELECT CASE WHEN round((SELECT coalesce(sum(debit_base - credit_base), 0) FROM journal_lines WHERE journal_entry_id = NEW.id), 4) <> 0
        THEN RAISE(ABORT, 'Journal entry is not balanced') END;
    END`);

  // Inventory status / balances migration
  ensureColumns('inventory_movements', {
    inventory_status: "TEXT NOT NULL DEFAULT 'AVAILABLE'",
    batch_code: "TEXT NOT NULL DEFAULT ''",
    expiry_date: "TEXT NOT NULL DEFAULT ''",
    related_status: 'TEXT',
    created_by: 'TEXT'
  });
  database.run(`UPDATE inventory_movements SET inventory_status = 'AVAILABLE'
    WHERE inventory_status IS NULL OR trim(inventory_status) = ''`);
  database.run(`UPDATE inventory_movements SET batch_code = '' WHERE batch_code IS NULL`);
  database.run(`UPDATE inventory_movements SET expiry_date = '' WHERE expiry_date IS NULL`);
  database.run(`CREATE TABLE IF NOT EXISTS inventory_balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'SALVAGE', 'DISPOSED')),
    batch_code TEXT NOT NULL DEFAULT '',
    expiry_date TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    unit_cost_base REAL NOT NULL DEFAULT 0 CHECK (unit_cost_base >= 0),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (product_id, warehouse_id, status, batch_code, expiry_date))`);
  database.run('CREATE INDEX IF NOT EXISTS inventory_balances_product_idx ON inventory_balances(product_id, warehouse_id, status)');
  database.run('CREATE INDEX IF NOT EXISTS inventory_movements_status_idx ON inventory_movements(product_id, warehouse_id, inventory_status)');
  database.run('DROP VIEW IF EXISTS inventory_stock');
  database.run(`CREATE VIEW inventory_stock AS
    SELECT p.id AS product_id,
           p.name AS product_name,
           w.id AS warehouse_id,
           w.name AS warehouse_name,
           coalesce(sum(CASE WHEN b.status <> 'DISPOSED' THEN b.quantity ELSE 0 END), 0) AS quantity_on_hand,
           coalesce(sum(CASE WHEN b.status = 'AVAILABLE' THEN b.quantity ELSE 0 END), 0) AS quantity_available,
           coalesce(sum(CASE WHEN b.status = 'RESERVED' THEN b.quantity ELSE 0 END), 0) AS quantity_reserved,
           coalesce(sum(CASE WHEN b.status = 'DAMAGED' THEN b.quantity ELSE 0 END), 0) AS quantity_damaged,
           coalesce(sum(CASE WHEN b.status = 'SALVAGE' THEN b.quantity ELSE 0 END), 0) AS quantity_salvage,
           coalesce(sum(CASE WHEN b.status = 'DISPOSED' THEN b.quantity ELSE 0 END), 0) AS quantity_disposed,
           coalesce(sum(CASE WHEN b.status <> 'DISPOSED' THEN round(b.quantity * b.unit_cost_base, 4) ELSE 0 END), 0) AS movement_value_base,
           coalesce(sum(CASE WHEN b.status = 'AVAILABLE' THEN round(b.quantity * b.unit_cost_base, 4) ELSE 0 END), 0) AS available_value_base
    FROM products p
    CROSS JOIN warehouses w
    LEFT JOIN inventory_balances b ON b.product_id = p.id AND b.warehouse_id = w.id
    GROUP BY p.id, w.id`);
  const balanceCount = database.exec('SELECT count(*) AS c FROM inventory_balances');
  const hasBalances = balanceCount?.[0]?.values?.[0]?.[0] > 0;
  if (!hasBalances) {
    database.run(`INSERT INTO inventory_balances
      (product_id, warehouse_id, status, batch_code, expiry_date, quantity, unit_cost_base, updated_at)
      SELECT product_id, warehouse_id, 'AVAILABLE', '', '',
        round(sum(quantity_change), 6),
        CASE WHEN sum(quantity_change) = 0 THEN 0
             ELSE round(sum(CASE WHEN quantity_change > 0 THEN total_cost_base ELSE -total_cost_base END)
               / sum(quantity_change), 6) END,
        CURRENT_TIMESTAMP
      FROM inventory_movements
      GROUP BY product_id, warehouse_id
      HAVING round(sum(quantity_change), 6) > 0`);
  }
  database.run(`INSERT OR IGNORE INTO item_categories(id, name, parent_id) VALUES
    (1, 'Uncategorized', NULL),
    (2, 'Beverages', NULL),
    (3, 'Food', NULL),
    (4, 'Electronics', NULL),
    (5, 'Office Supplies', NULL),
    (6, 'Medical Supplies', NULL)`);
  database.run(`INSERT OR IGNORE INTO app_settings(key, value) VALUES
    ('business_address', ''), ('business_phone', ''), ('business_phone_secondary', ''), ('business_email', '')`);
  database.run("DELETE FROM user_capabilities WHERE capability_key = 'stock_receipt_post'");
  database.run("DELETE FROM role_profile_capabilities WHERE capability_key = 'stock_receipt_post'");
  database.run("DELETE FROM user_capabilities WHERE capability_key = 'purchase_invoice_manage'");
  database.run("DELETE FROM role_profile_capabilities WHERE capability_key = 'purchase_invoice_manage'");
  database.run("DELETE FROM role_profile_capabilities WHERE profile_key = 'treasury_manager' AND capability_key IN ('purchase_funding_view', 'supplier_payment_execute')");
  database.run(`CREATE TABLE IF NOT EXISTS purchase_disbursement_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT NOT NULL UNIQUE,
    funding_request_id INTEGER NOT NULL REFERENCES purchase_funding_requests(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    amount REAL NOT NULL CHECK (amount > 0),
    currency_id INTEGER NOT NULL REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    payment_mode TEXT NOT NULL DEFAULT 'SUPPLIER' CHECK (payment_mode IN ('SUPPLIER', 'PURCHASING_ADVANCE')),
    debit_account_id INTEGER NOT NULL REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'PENDING_TREASURY' CHECK (status IN ('PENDING_TREASURY', 'PARTIALLY_EXECUTED', 'EXECUTED', 'CANCELLED')),
    instructed_by TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    instructed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancelled_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    cancelled_at TEXT,
    notes TEXT)`);
  database.run('CREATE INDEX IF NOT EXISTS purchase_disbursement_funding_idx ON purchase_disbursement_orders(funding_request_id, status)');
  ensureColumns('supplier_payments', {
    disbursement_order_id: 'INTEGER REFERENCES purchase_disbursement_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT'
  });
  database.run("UPDATE role_profiles SET display_name = 'Procurement Manager' WHERE profile_key = 'purchasing_manager'");
  database.run("UPDATE users SET job_profile = 'Procurement Manager' WHERE job_profile = 'Purchasing Manager'");
  database.run(`INSERT OR IGNORE INTO user_capabilities(user_id, capability_key)
    SELECT user_id, 'purchase_order_finance_approve' FROM user_capabilities WHERE capability_key = 'purchase_order_approve'`);
  database.run(`INSERT OR IGNORE INTO user_capabilities(user_id, capability_key)
    SELECT user_id, 'purchase_order_finance_reject' FROM user_capabilities WHERE capability_key = 'purchase_order_reject'`);
  database.run("DELETE FROM user_capabilities WHERE capability_key IN ('purchase_order_approve', 'purchase_order_reject')");
  database.run("DELETE FROM role_profile_capabilities WHERE capability_key IN ('purchase_order_approve', 'purchase_order_reject')");
  database.run(`INSERT OR IGNORE INTO role_profile_capabilities(profile_key, capability_key) VALUES
    ('commercial_manager','purchase_order_commercial_approve'), ('commercial_manager','purchase_order_commercial_reject'),
    ('financial_manager','purchase_order_finance_approve'), ('financial_manager','purchase_order_finance_reject'),
    ('accountant','purchase_order_accounting_view'), ('accountant','purchase_disbursement_view'),
    ('accountant','purchase_disbursement_create'), ('treasury_manager','purchase_disbursement_view'),
    ('treasury_manager','purchase_disbursement_execute')`);
  database.run("INSERT OR IGNORE INTO role_profile_permissions(profile_key, screen_key, access_level) VALUES ('treasury_manager', 'inventory', 'view')");
  database.run("DELETE FROM role_profile_capabilities WHERE profile_key = 'accountant' AND capability_key IN ('supplier_payment_execute', 'treasury_payment_post')");
  database.run(`DELETE FROM user_capabilities WHERE capability_key IN ('supplier_payment_execute', 'treasury_payment_post')
    AND user_id IN (SELECT id FROM users WHERE job_profile = 'Accountant')`);
  database.run(`INSERT OR IGNORE INTO product_price_versions
    (product_id, warehouse_id, currency_id, cost_snapshot_base, pricing_method, markup_percent,
     published_price, minimum_sale_price, status, effective_from, created_by, published_by, published_at)
    SELECT p.id, NULL, p.sales_currency_id, 0, 'MANUAL', NULL, p.manual_sales_price, p.manual_sales_price,
      'PUBLISHED', date('now'), 'admin', 'admin', CURRENT_TIMESTAMP
    FROM products p WHERE p.manual_sales_price > 0
      AND NOT EXISTS (SELECT 1 FROM product_price_versions ppv WHERE ppv.product_id = p.id AND ppv.status = 'PUBLISHED')`);
  database.run("UPDATE app_settings SET value = '12' WHERE key = 'schema_version'");
  database.run("INSERT OR IGNORE INTO app_settings(key, value) VALUES ('schema_version', '12')");
  database.run('PRAGMA user_version = 12');
}

async function initializeDatabase({ isPackaged, userDataPath }) {
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const projectRoot = path.join(__dirname, '..');
  const schemaPath = path.join(projectRoot, 'database', 'schema.sql');
  const databasePath = isPackaged ? path.join(userDataPath, 'holool.sqlite') : path.join(projectRoot, 'data', 'dev.sqlite');
  const existingData = fs.existsSync(databasePath) ? fs.readFileSync(databasePath) : null;
  const database = existingData ? new SQL.Database(existingData) : new SQL.Database();
  database.run('PRAGMA foreign_keys = ON');
  database.exec(fs.readFileSync(schemaPath, 'utf8'));
  migrateDatabase(database);
  const service = new DatabaseService(database, databasePath);
  service.persist();
  return service;
}

module.exports = { DatabaseService, initializeDatabase };
