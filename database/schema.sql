PRAGMA foreign_keys = ON;
PRAGMA user_version = 12;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('System Administrator', 'Manager', 'Staff')),
  job_profile TEXT NOT NULL DEFAULT 'Staff',
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  screen_key TEXT NOT NULL CHECK (screen_key IN ('dashboard', 'sales', 'inventory', 'treasury', 'journalAccount', 'accounting', 'hr', 'reports')),
  access_level TEXT NOT NULL CHECK (access_level IN ('view', 'manage')),
  PRIMARY KEY (user_id, screen_key)
);

CREATE TABLE IF NOT EXISTS user_capabilities (
  user_id TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE CASCADE,
  capability_key TEXT NOT NULL,
  PRIMARY KEY (user_id, capability_key)
);

CREATE TABLE IF NOT EXISTS role_profiles (
  profile_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL UNIQUE,
  security_role TEXT NOT NULL CHECK (security_role IN ('System Administrator', 'Manager', 'Staff')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS role_profile_permissions (
  profile_key TEXT NOT NULL REFERENCES role_profiles(profile_key) ON UPDATE CASCADE ON DELETE CASCADE,
  screen_key TEXT NOT NULL,
  access_level TEXT NOT NULL CHECK (access_level IN ('view', 'manage')),
  PRIMARY KEY (profile_key, screen_key)
);

CREATE TABLE IF NOT EXISTS role_profile_capabilities (
  profile_key TEXT NOT NULL REFERENCES role_profiles(profile_key) ON UPDATE CASCADE ON DELETE CASCADE,
  capability_key TEXT NOT NULL,
  PRIMARY KEY (profile_key, capability_key)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  reason TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events(entity_type, entity_id, created_at);

CREATE TABLE IF NOT EXISTS currencies (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  is_base INTEGER NOT NULL DEFAULT 0 CHECK (is_base IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_base_currency ON currencies(is_base) WHERE is_base = 1;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('DEBIT', 'CREDIT')),
  parent_id INTEGER REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  is_control INTEGER NOT NULL DEFAULT 0 CHECK (is_control IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  description TEXT
);
CREATE INDEX IF NOT EXISTS accounts_parent_idx ON accounts(parent_id);

CREATE TABLE IF NOT EXISTS account_currencies (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE CASCADE,
  currency_id INTEGER NOT NULL REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE CASCADE,
  PRIMARY KEY (account_id, currency_id)
);

CREATE TABLE IF NOT EXISTS accounting_mappings (
  mapping_key TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  description TEXT
);

CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  unit_type TEXT NOT NULL CHECK (unit_type IN ('ITEM', 'WEIGHT', 'LENGTH')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS item_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  parent_id INTEGER REFERENCES item_categories(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  location TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES item_categories(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  default_unit_id INTEGER NOT NULL REFERENCES units(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  sales_currency_id INTEGER NOT NULL DEFAULT 1 REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  manual_sales_price REAL CHECK (manual_sales_price IS NULL OR manual_sales_price >= 0),
  default_markup_percent REAL CHECK (default_markup_percent IS NULL OR default_markup_percent >= 0),
  inventory_account_id INTEGER NOT NULL DEFAULT 1300 REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  sales_account_id INTEGER NOT NULL DEFAULT 4100 REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  cogs_account_id INTEGER NOT NULL DEFAULT 5100 REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  phone_number TEXT,
  location TEXT,
  supplier_type TEXT NOT NULL DEFAULT 'DOMESTIC' CHECK (supplier_type IN ('DOMESTIC', 'INTERNATIONAL')),
  default_currency_id INTEGER NOT NULL DEFAULT 1 REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  payable_account_id INTEGER NOT NULL DEFAULT 2100 REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  phone_number TEXT,
  location TEXT,
  receivable_account_id INTEGER NOT NULL DEFAULT 1200 REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  method_type TEXT NOT NULL CHECK (method_type IN ('CASH', 'BANK', 'CREDIT')),
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  bank_fee_account_id INTEGER REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_number TEXT NOT NULL UNIQUE,
  entry_date TEXT NOT NULL,
  description TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('OPENING', 'SALE', 'PURCHASE', 'PAYMENT', 'RECEIPT', 'INVENTORY', 'MANUAL')),
  source_id INTEGER,
  currency_id INTEGER NOT NULL REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  exchange_rate_to_base REAL NOT NULL DEFAULT 1 CHECK (exchange_rate_to_base > 0),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'VOID')),
  created_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  posted_at TEXT
);
CREATE INDEX IF NOT EXISTS journal_entries_source_idx ON journal_entries(source_type, source_id);
CREATE INDEX IF NOT EXISTS journal_entries_date_idx ON journal_entries(entry_date);

CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  product_id INTEGER REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  customer_id INTEGER REFERENCES customers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  supplier_id INTEGER REFERENCES suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  debit_base REAL NOT NULL DEFAULT 0 CHECK (debit_base >= 0),
  credit_base REAL NOT NULL DEFAULT 0 CHECK (credit_base >= 0),
  transaction_amount REAL,
  currency_id INTEGER REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  exchange_rate_to_base REAL NOT NULL DEFAULT 1 CHECK (exchange_rate_to_base > 0),
  memo TEXT,
  CHECK ((debit_base > 0 AND credit_base = 0) OR (credit_base > 0 AND debit_base = 0))
);
CREATE INDEX IF NOT EXISTS journal_lines_entry_idx ON journal_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS journal_lines_account_idx ON journal_lines(account_id);

CREATE TABLE IF NOT EXISTS journal_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size >= 0),
  file_data BLOB NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS journal_attachments_entry_idx ON journal_attachments(journal_entry_id);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT, employee_code TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL,
  phone TEXT, email TEXT, department TEXT, job_title TEXT,
  employment_type TEXT NOT NULL CHECK (employment_type IN ('full_time', 'part_time', 'contractor')),
  hire_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  base_salary REAL NOT NULL CHECK (base_salary >= 0), salary_grade_id INTEGER REFERENCES salary_grades(id) ON UPDATE CASCADE ON DELETE SET NULL, notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS salary_components (
  id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('allowance', 'deduction')), name TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount >= 0), is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);
CREATE INDEX IF NOT EXISTS salary_components_employee_idx ON salary_components(employee_id);
CREATE TABLE IF NOT EXISTS leave_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
  default_annual_days INTEGER NOT NULL DEFAULT 0 CHECK (default_annual_days >= 0)
);
CREATE TABLE IF NOT EXISTS leave_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  year INTEGER NOT NULL CHECK (year BETWEEN 1900 AND 9999), allocated_days REAL NOT NULL DEFAULT 0 CHECK (allocated_days >= 0),
  used_days REAL NOT NULL DEFAULT 0 CHECK (used_days >= 0), UNIQUE(employee_id, leave_type_id, year)
);
CREATE TABLE IF NOT EXISTS leave_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  date_from TEXT NOT NULL, date_to TEXT NOT NULL, days_count REAL NOT NULL CHECK (days_count > 0), reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK (date_to >= date_from)
);
CREATE TABLE IF NOT EXISTS attendance_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, employee_id INTEGER NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE CASCADE,
  date TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'half_day', 'on_leave')),
  notes TEXT, entered_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(employee_id, date)
);
CREATE TABLE IF NOT EXISTS payroll_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, reference TEXT NOT NULL UNIQUE,
  period_month INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12), period_year INTEGER NOT NULL CHECK (period_year BETWEEN 1900 AND 9999),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized', 'posted')),
  workflow_state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (workflow_state IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PAYMENT_PENDING', 'PAID', 'CANCELLED')),
  submitted_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  submitted_at TEXT,
  approved_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  approved_at TEXT,
  approval_comment TEXT,
  total_gross REAL NOT NULL DEFAULT 0, total_deductions REAL NOT NULL DEFAULT 0, total_net REAL NOT NULL DEFAULT 0,
  posted_journal_entry_id INTEGER UNIQUE REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  posted_account TEXT, created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(period_month, period_year)
);
CREATE TABLE IF NOT EXISTS payroll_run_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  base_salary REAL NOT NULL DEFAULT 0, allowances_total REAL NOT NULL DEFAULT 0, overtime_amount REAL NOT NULL DEFAULT 0,
  bonus_amount REAL NOT NULL DEFAULT 0, absence_deduction REAL NOT NULL DEFAULT 0, tax_amount REAL NOT NULL DEFAULT 0,
  social_insurance_amount REAL NOT NULL DEFAULT 0, other_deductions REAL NOT NULL DEFAULT 0,
  gross_pay REAL NOT NULL DEFAULT 0, net_pay REAL NOT NULL DEFAULT 0, notes TEXT, UNIQUE(payroll_run_id, employee_id)
);
CREATE INDEX IF NOT EXISTS payroll_run_items_run_idx ON payroll_run_items(payroll_run_id);

CREATE TABLE IF NOT EXISTS salary_grades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  minimum_salary REAL NOT NULL DEFAULT 0 CHECK (minimum_salary >= 0),
  maximum_salary REAL CHECK (maximum_salary IS NULL OR maximum_salary >= minimum_salary),
  default_base_salary REAL NOT NULL DEFAULT 0 CHECK (default_base_salary >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payroll_approval_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'PAID', 'RECALLED')),
  comment TEXT,
  acted_by TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  acted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS payroll_approval_history_run_idx ON payroll_approval_history(payroll_run_id, acted_at);

CREATE TABLE IF NOT EXISTS invoice_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_type TEXT NOT NULL CHECK (invoice_type IN ('SALE', 'PURCHASE')),
  invoice_id INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size >= 0),
  file_data BLOB NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS invoice_attachments_owner_idx ON invoice_attachments(invoice_type, invoice_id);

CREATE TABLE IF NOT EXISTS sales_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_key TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
  invoice_number TEXT NOT NULL UNIQUE,
  invoice_date TEXT NOT NULL,
  customer_id INTEGER REFERENCES customers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  customer_name_snapshot TEXT,
  payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  currency_id INTEGER NOT NULL REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  exchange_rate_to_base REAL NOT NULL DEFAULT 1 CHECK (exchange_rate_to_base > 0),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'COMPLETED', 'VOID')),
  journal_entry_id INTEGER UNIQUE REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  notes TEXT,
  created_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales_invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sales_invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id) ON UPDATE CASCADE ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  category_id INTEGER NOT NULL REFERENCES item_categories(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  description TEXT,
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit_id INTEGER NOT NULL REFERENCES units(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  unit_quantity REAL NOT NULL DEFAULT 1 CHECK (unit_quantity > 0),
  unit_price REAL NOT NULL CHECK (unit_price >= 0),
  published_unit_price REAL,
  price_version_id INTEGER REFERENCES product_price_versions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  base_quantity REAL GENERATED ALWAYS AS (quantity * unit_quantity) STORED,
  line_total REAL GENERATED ALWAYS AS (round(quantity * unit_quantity * unit_price, 4)) STORED
);
CREATE INDEX IF NOT EXISTS sales_lines_invoice_idx ON sales_invoice_lines(sales_invoice_id);

CREATE TABLE IF NOT EXISTS purchase_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_key TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
  invoice_code TEXT NOT NULL UNIQUE,
  supplier_invoice_number TEXT,
  purchase_order_id INTEGER REFERENCES purchase_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  invoice_date TEXT NOT NULL,
  currency_id INTEGER NOT NULL REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  exchange_rate_to_base REAL NOT NULL DEFAULT 1 CHECK (exchange_rate_to_base > 0),
  declared_invoice_total REAL CHECK (declared_invoice_total IS NULL OR declared_invoice_total >= 0),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'RECEIVED', 'VOID')),
  workflow_state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (workflow_state IN ('DRAFT', 'SUBMITTED', 'FUNDING_AUTHORIZED', 'REJECTED', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_RECEIVED', 'RECEIVED', 'SETTLED', 'CANCELLED')),
  submitted_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  submitted_at TEXT,
  journal_entry_id INTEGER UNIQUE REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  notes TEXT,
  created_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  stock_posted_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  stock_posted_at TEXT,
  stock_warehouse_id INTEGER REFERENCES warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON UPDATE CASCADE ON DELETE CASCADE,
  purchase_order_line_id INTEGER REFERENCES purchase_order_lines(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  category_id INTEGER NOT NULL REFERENCES item_categories(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  description TEXT,
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit_id INTEGER NOT NULL REFERENCES units(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  unit_quantity REAL NOT NULL DEFAULT 1 CHECK (unit_quantity > 0),
  unit_price REAL NOT NULL CHECK (unit_price > 0),
  pricing_method TEXT NOT NULL DEFAULT 'MANUAL' CHECK (pricing_method IN ('MANUAL', 'MARKUP')),
  manual_sales_price REAL CHECK (manual_sales_price IS NULL OR manual_sales_price >= 0),
  markup_percent REAL CHECK (markup_percent IS NULL OR markup_percent >= 0),
  base_quantity REAL GENERATED ALWAYS AS (quantity * unit_quantity) STORED,
  line_total REAL GENERATED ALWAYS AS (round(quantity * unit_quantity * unit_price, 4)) STORED
);
CREATE INDEX IF NOT EXISTS purchase_lines_invoice_idx ON purchase_invoice_lines(purchase_invoice_id);

CREATE TABLE IF NOT EXISTS purchase_orders (
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
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'OPEN', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED', 'CLOSED')),
  created_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  approval_state TEXT NOT NULL DEFAULT 'NOT_SUBMITTED'
    CHECK (approval_state IN ('NOT_SUBMITTED', 'PENDING_COMMERCIAL', 'PENDING_FINANCE', 'FINANCE_APPROVED', 'COMMERCIAL_REJECTED', 'FINANCE_REJECTED')),
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
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_order_approval_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('SUBMITTED_TO_COMMERCIAL', 'COMMERCIAL_APPROVED', 'COMMERCIAL_REJECTED',
    'ROUTED_TO_FINANCE', 'FINANCE_APPROVED', 'FINANCE_REJECTED', 'HANDED_TO_ACCOUNTING', 'RECALLED', 'LEGACY_MIGRATED')),
  comment TEXT,
  acted_by TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  acted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS purchase_order_approval_history_order_idx
  ON purchase_order_approval_history(purchase_order_id, acted_at);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON UPDATE CASCADE ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  description TEXT,
  ordered_quantity REAL NOT NULL CHECK (ordered_quantity > 0),
  unit_id INTEGER NOT NULL REFERENCES units(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  unit_quantity REAL NOT NULL DEFAULT 1 CHECK (unit_quantity > 0),
  unit_price REAL NOT NULL CHECK (unit_price > 0),
  cancelled_quantity REAL NOT NULL DEFAULT 0 CHECK (cancelled_quantity >= 0 AND cancelled_quantity <= ordered_quantity),
  line_total REAL GENERATED ALWAYS AS (round(ordered_quantity * unit_quantity * unit_price, 4)) STORED
);
CREATE INDEX IF NOT EXISTS purchase_order_lines_order_idx ON purchase_order_lines(purchase_order_id);
CREATE INDEX IF NOT EXISTS purchase_orders_supplier_idx ON purchase_orders(supplier_id, order_date);

CREATE TABLE IF NOT EXISTS additional_cost_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  inventory_account_id INTEGER NOT NULL DEFAULT 1300 REFERENCES accounts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE TABLE IF NOT EXISTS purchase_additional_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON UPDATE CASCADE ON DELETE CASCADE,
  cost_type_id INTEGER NOT NULL REFERENCES additional_cost_types(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  description TEXT,
  amount REAL NOT NULL CHECK (amount >= 0),
  currency_id INTEGER NOT NULL REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  exchange_rate_to_base REAL NOT NULL DEFAULT 1 CHECK (exchange_rate_to_base > 0),
  reference_code TEXT,
  cost_invoice_date TEXT,
  supplier_id INTEGER REFERENCES suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_invoice_approval_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON UPDATE CASCADE ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('SUBMITTED', 'AUTHORIZED', 'REJECTED', 'RECALLED')),
  comment TEXT,
  acted_by TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  acted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS purchase_invoice_approval_idx ON purchase_invoice_approval_history(purchase_invoice_id, acted_at);

CREATE TABLE IF NOT EXISTS purchase_funding_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  requested_amount REAL NOT NULL CHECK (requested_amount > 0),
  currency_id INTEGER NOT NULL REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  exchange_rate_to_base REAL NOT NULL DEFAULT 1 CHECK (exchange_rate_to_base > 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'AUTHORIZED', 'REJECTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED')),
  requested_by TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  decided_at TEXT,
  decision_comment TEXT
);
CREATE INDEX IF NOT EXISTS purchase_funding_invoice_idx ON purchase_funding_requests(purchase_invoice_id, status);

CREATE TABLE IF NOT EXISTS purchase_disbursement_orders (
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
  notes TEXT
);
CREATE INDEX IF NOT EXISTS purchase_disbursement_funding_idx ON purchase_disbursement_orders(funding_request_id, status);

CREATE TABLE IF NOT EXISTS supplier_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_number TEXT NOT NULL UNIQUE,
  funding_request_id INTEGER NOT NULL REFERENCES purchase_funding_requests(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  disbursement_order_id INTEGER REFERENCES purchase_disbursement_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  currency_id INTEGER NOT NULL REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  amount REAL NOT NULL CHECK (amount > 0),
  payment_mode TEXT NOT NULL DEFAULT 'SUPPLIER' CHECK (payment_mode IN ('SUPPLIER', 'PURCHASING_ADVANCE')),
  recipient_user_id TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  advance_applied_amount REAL NOT NULL DEFAULT 0 CHECK (advance_applied_amount >= 0),
  exchange_rate_to_base REAL NOT NULL DEFAULT 1 CHECK (exchange_rate_to_base > 0),
  journal_entry_id INTEGER NOT NULL UNIQUE REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  executed_by TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS supplier_payment_allocations (
  supplier_payment_id INTEGER NOT NULL REFERENCES supplier_payments(id) ON UPDATE CASCADE ON DELETE CASCADE,
  purchase_invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  allocated_amount REAL NOT NULL CHECK (allocated_amount > 0),
  PRIMARY KEY (supplier_payment_id, purchase_invoice_id)
);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number TEXT NOT NULL UNIQUE,
  purchase_invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  receipt_date TEXT NOT NULL,
  delivery_note_number TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'CONFIRMED', 'REJECTED', 'REVERSED')),
  received_by TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  confirmed_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS goods_receipt_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goods_receipt_id INTEGER NOT NULL REFERENCES goods_receipts(id) ON UPDATE CASCADE ON DELETE CASCADE,
  purchase_invoice_line_id INTEGER NOT NULL REFERENCES purchase_invoice_lines(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  accepted_quantity REAL NOT NULL DEFAULT 0 CHECK (accepted_quantity >= 0),
  rejected_quantity REAL NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  damaged_quantity REAL NOT NULL DEFAULT 0 CHECK (damaged_quantity >= 0),
  batch_code TEXT NOT NULL DEFAULT '',
  expiry_date TEXT NOT NULL DEFAULT '',
  notes TEXT
);
CREATE INDEX IF NOT EXISTS goods_receipt_invoice_idx ON goods_receipts(purchase_invoice_id, status);

CREATE TABLE IF NOT EXISTS product_price_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  warehouse_id INTEGER REFERENCES warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  currency_id INTEGER NOT NULL REFERENCES currencies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  cost_snapshot_base REAL NOT NULL CHECK (cost_snapshot_base >= 0),
  pricing_method TEXT NOT NULL CHECK (pricing_method IN ('MANUAL', 'MARKUP')),
  markup_percent REAL CHECK (markup_percent IS NULL OR markup_percent >= 0),
  published_price REAL NOT NULL CHECK (published_price >= 0),
  minimum_sale_price REAL NOT NULL CHECK (minimum_sale_price >= 0),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'EXPIRED')),
  effective_from TEXT,
  effective_to TEXT,
  notes TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  published_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS product_price_active_idx ON product_price_versions(product_id, warehouse_id, status, effective_from);
CREATE INDEX IF NOT EXISTS purchase_costs_invoice_idx ON purchase_additional_costs(purchase_invoice_id);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  movement_date TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  movement_type TEXT NOT NULL CHECK (movement_type IN ('PURCHASE', 'SALE', 'RETURN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'TRANSFER_IN', 'TRANSFER_OUT')),
  quantity_change REAL NOT NULL CHECK (quantity_change <> 0),
  unit_cost_base REAL NOT NULL DEFAULT 0 CHECK (unit_cost_base >= 0),
  total_cost_base REAL GENERATED ALWAYS AS (round(abs(quantity_change) * unit_cost_base, 4)) STORED,
  inventory_status TEXT NOT NULL DEFAULT 'AVAILABLE'
    CHECK (inventory_status IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'SALVAGE', 'DISPOSED')),
  batch_code TEXT NOT NULL DEFAULT '',
  expiry_date TEXT NOT NULL DEFAULT '',
  related_status TEXT CHECK (related_status IS NULL OR related_status IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'SALVAGE', 'DISPOSED')),
  purchase_line_id INTEGER REFERENCES purchase_invoice_lines(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  sales_line_id INTEGER REFERENCES sales_invoice_lines(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  reference_code TEXT,
  notes TEXT,
  created_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS inventory_product_warehouse_idx ON inventory_movements(product_id, warehouse_id);

CREATE TABLE IF NOT EXISTS inventory_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('AVAILABLE', 'RESERVED', 'DAMAGED', 'SALVAGE', 'DISPOSED')),
  batch_code TEXT NOT NULL DEFAULT '',
  expiry_date TEXT NOT NULL DEFAULT '',
  quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  unit_cost_base REAL NOT NULL DEFAULT 0 CHECK (unit_cost_base >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (product_id, warehouse_id, status, batch_code, expiry_date)
);
CREATE INDEX IF NOT EXISTS inventory_balances_product_idx ON inventory_balances(product_id, warehouse_id, status);

CREATE TABLE IF NOT EXISTS inventory_salvage_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference_code TEXT NOT NULL UNIQUE,
  operation_date TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  quantity REAL NOT NULL CHECK (quantity > 0),
  original_unit_cost_base REAL NOT NULL CHECK (original_unit_cost_base >= 0),
  salvage_unit_value_base REAL NOT NULL CHECK (salvage_unit_value_base >= 0),
  write_down_base REAL NOT NULL CHECK (write_down_base > 0),
  notes TEXT,
  journal_entry_id INTEGER REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_number TEXT NOT NULL UNIQUE,
  sales_invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  return_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED', 'COMMERCIAL_APPROVED', 'FINANCE_APPROVED', 'REJECTED', 'REFUNDED', 'CREDIT_ISSUED', 'CLOSED')),
  requested_by TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  commercial_approved_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  finance_approved_by TEXT REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  journal_entry_id INTEGER UNIQUE REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sales_return_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sales_return_id INTEGER NOT NULL REFERENCES sales_returns(id) ON UPDATE CASCADE ON DELETE CASCADE,
  sales_invoice_line_id INTEGER NOT NULL REFERENCES sales_invoice_lines(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  quantity REAL NOT NULL CHECK (quantity > 0),
  restock_status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (restock_status IN ('AVAILABLE', 'DAMAGED', 'SALVAGE', 'DISPOSED')),
  refund_unit_price REAL NOT NULL CHECK (refund_unit_price >= 0)
);

CREATE TABLE IF NOT EXISTS sales_return_approval_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sales_return_id INTEGER NOT NULL REFERENCES sales_returns(id) ON UPDATE CASCADE ON DELETE CASCADE,
  action TEXT NOT NULL,
  comment TEXT,
  acted_by TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  acted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_number TEXT NOT NULL UNIQUE,
  sales_return_id INTEGER NOT NULL UNIQUE REFERENCES sales_returns(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  amount REAL NOT NULL CHECK (amount > 0),
  journal_entry_id INTEGER NOT NULL UNIQUE REFERENCES journal_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  executed_by TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS inventory_salvage_product_warehouse_idx
  ON inventory_salvage_operations(product_id, warehouse_id, operation_date);

CREATE TRIGGER IF NOT EXISTS journal_no_direct_post
BEFORE INSERT ON journal_entries
WHEN NEW.status = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'Create the journal entry as DRAFT, add balanced lines, then post it');
END;

CREATE TRIGGER IF NOT EXISTS journal_validate_posting
BEFORE UPDATE OF status ON journal_entries
WHEN NEW.status = 'POSTED' AND OLD.status <> 'POSTED'
BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM journal_lines WHERE journal_entry_id = NEW.id) < 2
    THEN RAISE(ABORT, 'A posted journal entry requires at least two lines') END;
  SELECT CASE WHEN round((SELECT coalesce(sum(debit_base - credit_base), 0) FROM journal_lines WHERE journal_entry_id = NEW.id), 4) <> 0
    THEN RAISE(ABORT, 'Journal entry is not balanced') END;
END;

CREATE TRIGGER IF NOT EXISTS journal_lines_no_insert_posted
BEFORE INSERT ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = NEW.journal_entry_id) = 'POSTED'
BEGIN SELECT RAISE(ABORT, 'Posted journal lines cannot be changed'); END;

CREATE TRIGGER IF NOT EXISTS journal_lines_no_update_posted
BEFORE UPDATE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.journal_entry_id) = 'POSTED'
BEGIN SELECT RAISE(ABORT, 'Posted journal lines cannot be changed'); END;

CREATE TRIGGER IF NOT EXISTS journal_lines_no_delete_posted
BEFORE DELETE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.journal_entry_id) = 'POSTED'
BEGIN SELECT RAISE(ABORT, 'Posted journal lines cannot be changed'); END;

CREATE VIEW IF NOT EXISTS sales_invoice_totals AS
SELECT si.id AS sales_invoice_id,
       coalesce(sum(sl.line_total), 0) AS invoice_total,
       round(coalesce(sum(sl.line_total), 0) * si.exchange_rate_to_base, 4) AS invoice_total_base
FROM sales_invoices si
LEFT JOIN sales_invoice_lines sl ON sl.sales_invoice_id = si.id
GROUP BY si.id;

CREATE VIEW IF NOT EXISTS purchase_invoice_totals AS
SELECT pi.id AS purchase_invoice_id,
       coalesce((SELECT sum(pl.line_total) FROM purchase_invoice_lines pl WHERE pl.purchase_invoice_id = pi.id), 0) AS goods_total,
       coalesce((SELECT sum((pc.amount * pc.exchange_rate_to_base) / pi.exchange_rate_to_base)
                 FROM purchase_additional_costs pc WHERE pc.purchase_invoice_id = pi.id), 0) AS additional_cost_total,
       coalesce((SELECT sum(pl.line_total) FROM purchase_invoice_lines pl WHERE pl.purchase_invoice_id = pi.id), 0)
       + coalesce((SELECT sum((pc.amount * pc.exchange_rate_to_base) / pi.exchange_rate_to_base)
                   FROM purchase_additional_costs pc WHERE pc.purchase_invoice_id = pi.id), 0) AS landed_total,
       pi.declared_invoice_total
FROM purchase_invoices pi;

CREATE VIEW IF NOT EXISTS purchase_line_costs AS
SELECT pl.id AS purchase_line_id,
       pl.purchase_invoice_id,
       pl.product_id,
       pl.base_quantity,
       pl.unit_price,
       pl.line_total,
       pit.goods_total,
       pit.additional_cost_total,
       CASE WHEN pit.goods_total = 0 THEN 0
            ELSE round((pl.line_total / pit.goods_total) * pit.additional_cost_total, 6) END AS allocated_additional_cost,
       round(pl.line_total + CASE WHEN pit.goods_total = 0 THEN 0
            ELSE (pl.line_total / pit.goods_total) * pit.additional_cost_total END, 6) AS landed_cost_total,
       round((pl.line_total + CASE WHEN pit.goods_total = 0 THEN 0
            ELSE (pl.line_total / pit.goods_total) * pit.additional_cost_total END) / pl.base_quantity, 6) AS landed_cost_per_unit,
       round(((pl.line_total + CASE WHEN pit.goods_total = 0 THEN 0
            ELSE (pl.line_total / pit.goods_total) * pit.additional_cost_total END) / pl.base_quantity)
            * pi.exchange_rate_to_base, 6) AS landed_cost_per_unit_base,
       CASE WHEN pl.pricing_method = 'MANUAL' THEN pl.manual_sales_price
            WHEN pl.pricing_method = 'MARKUP' THEN round(((pl.line_total + CASE WHEN pit.goods_total = 0 THEN 0
                 ELSE (pl.line_total / pit.goods_total) * pit.additional_cost_total END) / pl.base_quantity)
                 * (1 + coalesce(pl.markup_percent, 0) / 100.0), 6)
            ELSE NULL END AS suggested_sales_price
FROM purchase_invoice_lines pl
JOIN purchase_invoices pi ON pi.id = pl.purchase_invoice_id
JOIN purchase_invoice_totals pit ON pit.purchase_invoice_id = pl.purchase_invoice_id;

CREATE VIEW IF NOT EXISTS inventory_stock AS
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
GROUP BY p.id, w.id;

CREATE VIEW IF NOT EXISTS journal_entry_balances AS
SELECT je.id AS journal_entry_id,
       je.entry_number,
       je.status,
       coalesce(sum(jl.debit_base), 0) AS total_debit,
       coalesce(sum(jl.credit_base), 0) AS total_credit,
       round(coalesce(sum(jl.debit_base - jl.credit_base), 0), 4) AS difference
FROM journal_entries je
LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
GROUP BY je.id;

CREATE VIEW IF NOT EXISTS account_balances AS
WITH RECURSIVE account_tree(root_id, descendant_id) AS (
  SELECT id, id FROM accounts
  UNION ALL
  SELECT account_tree.root_id, child.id
  FROM account_tree
  JOIN accounts child ON child.parent_id = account_tree.descendant_id
)
SELECT root.id AS account_id,
       root.code,
       root.name,
       root.account_type,
       root.normal_balance,
       round(coalesce(sum(CASE WHEN je.status = 'POSTED' THEN jl.debit_base ELSE 0 END), 0), 4) AS total_debit,
       round(coalesce(sum(CASE WHEN je.status = 'POSTED' THEN jl.credit_base ELSE 0 END), 0), 4) AS total_credit,
       round(CASE WHEN root.normal_balance = 'DEBIT'
             THEN coalesce(sum(CASE WHEN je.status = 'POSTED' THEN jl.debit_base - jl.credit_base ELSE 0 END), 0)
             ELSE coalesce(sum(CASE WHEN je.status = 'POSTED' THEN jl.credit_base - jl.debit_base ELSE 0 END), 0)
             END, 4) AS balance
FROM accounts root
JOIN account_tree tree ON tree.root_id = root.id
LEFT JOIN journal_lines jl ON jl.account_id = tree.descendant_id
LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
GROUP BY root.id;

INSERT OR IGNORE INTO app_settings(key, value) VALUES ('base_currency', 'SDG'), ('schema_version', '12');
INSERT OR IGNORE INTO app_settings(key, value) VALUES ('payroll_working_days', '30');
INSERT OR IGNORE INTO app_settings(key, value) VALUES
  ('business_name', 'Holool ERP Enterprise'), ('business_logo', ''),
  ('business_address', ''), ('business_phone', ''), ('business_phone_secondary', ''), ('business_email', '');
INSERT OR IGNORE INTO leave_types(name, default_annual_days) VALUES ('Annual', 21), ('Sick', 14), ('Unpaid', 0);
INSERT OR IGNORE INTO users(id, username, password, role, job_profile) VALUES ('admin', 'admin', '1234', 'System Administrator', 'System Administrator');
INSERT OR IGNORE INTO role_profiles(profile_key, display_name, security_role) VALUES
  ('sales_cashier', 'Sales / Cashier', 'Staff'),
  ('purchasing_manager', 'Procurement Manager', 'Manager'),
  ('warehouse_manager', 'Warehouse Manager', 'Manager'),
  ('pricing_manager', 'Pricing Manager', 'Manager'),
  ('accountant', 'Accountant', 'Manager'),
  ('financial_manager', 'Financial Manager', 'Manager'),
  ('commercial_manager', 'Commercial Manager', 'Manager'),
  ('general_manager', 'General Manager', 'Manager'),
  ('treasury_manager', 'Treasury Manager', 'Manager'),
  ('staff', 'Staff', 'Staff');

INSERT OR IGNORE INTO role_profile_permissions(profile_key, screen_key, access_level) VALUES
  ('sales_cashier','dashboard','view'), ('sales_cashier','sales','manage'),
  ('purchasing_manager','dashboard','view'), ('purchasing_manager','inventory','manage'), ('purchasing_manager','reports','view'),
  ('warehouse_manager','dashboard','view'), ('warehouse_manager','inventory','manage'),
  ('pricing_manager','dashboard','view'), ('pricing_manager','inventory','manage'), ('pricing_manager','reports','view'),
  ('accountant','dashboard','view'), ('accountant','inventory','view'), ('accountant','treasury','manage'), ('accountant','journalAccount','manage'), ('accountant','accounting','view'), ('accountant','hr','view'), ('accountant','reports','manage'),
  ('financial_manager','dashboard','view'), ('financial_manager','inventory','view'), ('financial_manager','treasury','view'), ('financial_manager','accounting','manage'), ('financial_manager','hr','manage'), ('financial_manager','reports','manage'),
  ('commercial_manager','dashboard','view'), ('commercial_manager','sales','view'), ('commercial_manager','inventory','view'), ('commercial_manager','reports','view'),
  ('general_manager','dashboard','view'), ('general_manager','sales','view'), ('general_manager','inventory','view'), ('general_manager','treasury','view'), ('general_manager','journalAccount','view'), ('general_manager','accounting','view'), ('general_manager','hr','view'), ('general_manager','reports','view'),
  ('treasury_manager','dashboard','view'), ('treasury_manager','inventory','view'), ('treasury_manager','treasury','manage'), ('treasury_manager','reports','view'),
  ('staff','dashboard','view');

INSERT OR IGNORE INTO role_profile_capabilities(profile_key, capability_key) VALUES
  ('sales_cashier','sale_create'), ('sales_cashier','sale_hold'), ('sales_cashier','sale_view_own'), ('sales_cashier','sale_reprint'), ('sales_cashier','sale_price_increase'),
  ('purchasing_manager','supplier_view'), ('purchasing_manager','supplier_manage'), ('purchasing_manager','product_create'),
  ('purchasing_manager','purchase_order_view'), ('purchasing_manager','purchase_order_create'), ('purchasing_manager','purchase_order_edit'), ('purchasing_manager','purchase_order_submit'),
  ('purchasing_manager','purchase_invoice_view'), ('purchasing_manager','purchase_invoice_create'), ('purchasing_manager','purchase_invoice_edit'), ('purchasing_manager','purchase_invoice_submit'), ('purchasing_manager','purchase_cost_manage'), ('purchasing_manager','purchase_attachment_manage'),
  ('purchasing_manager','operational_reports_view'),
  ('warehouse_manager','stock_quantity_view'), ('warehouse_manager','goods_receipt_view'), ('warehouse_manager','goods_receipt_confirm'), ('warehouse_manager','goods_receipt_reject'),
  ('pricing_manager','stock_quantity_view'), ('pricing_manager','pricing_cost_view'), ('pricing_manager','pricing_view'), ('pricing_manager','pricing_create'), ('pricing_manager','pricing_publish'), ('pricing_manager','operational_reports_view'),
  ('accountant','journal_view'), ('accountant','journal_create'), ('accountant','journal_post'), ('accountant','purchase_order_accounting_view'), ('accountant','purchase_funding_view'), ('accountant','purchase_disbursement_view'), ('accountant','purchase_disbursement_create'), ('accountant','payroll_payment_execute'), ('accountant','sales_return_settle'), ('accountant','treasury_receipt_post'), ('accountant','financial_reports_view'), ('accountant','operational_reports_view'),
  ('financial_manager','purchase_order_view'), ('financial_manager','purchase_order_finance_approve'), ('financial_manager','purchase_order_finance_reject'), ('financial_manager','purchase_funding_view'), ('financial_manager','purchase_funding_approve'), ('financial_manager','purchase_funding_reject'), ('financial_manager','accounting_tree_view'), ('financial_manager','accounting_tree_manage'), ('financial_manager','employee_manage'), ('financial_manager','payroll_prepare'), ('financial_manager','payroll_submit'), ('financial_manager','payroll_approve'), ('financial_manager','financial_reports_view'), ('financial_manager','operational_reports_view'),
  ('commercial_manager','stock_quantity_view'), ('commercial_manager','pricing_view'), ('commercial_manager','pricing_create'), ('commercial_manager','pricing_publish'), ('commercial_manager','sale_view_all'), ('commercial_manager','sales_return_create'), ('commercial_manager','sales_return_approve'), ('commercial_manager','purchase_order_commercial_approve'), ('commercial_manager','purchase_order_commercial_reject'), ('commercial_manager','operational_reports_view'),
  ('commercial_manager','pricing_cost_view'), ('commercial_manager','supplier_view'), ('commercial_manager','purchase_order_view'), ('commercial_manager','purchase_invoice_view'),
  ('general_manager','financial_reports_view'), ('general_manager','operational_reports_view'), ('general_manager','sensitive_cost_reports_view'), ('general_manager','hr_reports_view'), ('general_manager','sale_view_all'), ('general_manager','purchase_order_view'), ('general_manager','purchase_invoice_view'), ('general_manager','pricing_view'), ('general_manager','stock_cost_view'),
  ('treasury_manager','treasury_receipt_post'), ('treasury_manager','treasury_payment_post'), ('treasury_manager','purchase_disbursement_view'), ('treasury_manager','purchase_disbursement_execute');
INSERT OR IGNORE INTO currencies(id, code, name, symbol, is_base) VALUES
  (1, 'SDG', 'Sudanese Pound', 'SDG', 1),
  (2, 'USD', 'US Dollar', '$', 0),
  (3, 'AED', 'UAE Dirham', 'AED', 0);

INSERT OR IGNORE INTO accounts(id, code, name, account_type, normal_balance, parent_id, is_control) VALUES
  (1000, '1000', 'Assets', 'ASSET', 'DEBIT', NULL, 1),
  (1100, '1100', 'Cash and Banks', 'ASSET', 'DEBIT', 1000, 1),
  (1110, '1110', 'Cash on Hand', 'ASSET', 'DEBIT', 1100, 0),
  (1120, '1120', 'Bankak', 'ASSET', 'DEBIT', 1100, 0),
  (1130, '1130', 'OCash', 'ASSET', 'DEBIT', 1100, 0),
  (1140, '1140', 'Fawry', 'ASSET', 'DEBIT', 1100, 0),
  (1150, '1150', 'MyCashi', 'ASSET', 'DEBIT', 1100, 0),
  (1200, '1200', 'Accounts Receivable', 'ASSET', 'DEBIT', 1000, 0),
  (1250, '1250', 'Purchasing Advances', 'ASSET', 'DEBIT', 1000, 0),
  (1300, '1300', 'Inventory', 'ASSET', 'DEBIT', 1000, 0),
  (2000, '2000', 'Liabilities', 'LIABILITY', 'CREDIT', NULL, 1),
  (2100, '2100', 'Accounts Payable', 'LIABILITY', 'CREDIT', 2000, 0),
  (3000, '3000', 'Equity', 'EQUITY', 'CREDIT', NULL, 1),
  (3100, '3100', 'Capital', 'EQUITY', 'CREDIT', 3000, 0),
  (3200, '3200', 'Retained Earnings', 'EQUITY', 'CREDIT', 3000, 0),
  (4000, '4000', 'Revenue', 'REVENUE', 'CREDIT', NULL, 1),
  (4100, '4100', 'Sales Revenue', 'REVENUE', 'CREDIT', 4000, 0),
  (5000, '5000', 'Cost of Sales', 'EXPENSE', 'DEBIT', NULL, 1),
  (5100, '5100', 'Cost of Goods Sold', 'EXPENSE', 'DEBIT', 5000, 0),
  (6000, '6000', 'Operating Expenses', 'EXPENSE', 'DEBIT', NULL, 1),
  (6100, '6100', 'Inventory Adjustments', 'EXPENSE', 'DEBIT', 6000, 0),
  (6200, '6200', 'Other Expenses', 'EXPENSE', 'DEBIT', 6000, 0),
  (6210, '6210', 'Bankak Bank Fees', 'EXPENSE', 'DEBIT', 6200, 0),
  (6220, '6220', 'OCash Bank Fees', 'EXPENSE', 'DEBIT', 6200, 0),
  (6230, '6230', 'Fawry Bank Fees', 'EXPENSE', 'DEBIT', 6200, 0),
  (6240, '6240', 'MyCashi Bank Fees', 'EXPENSE', 'DEBIT', 6200, 0);

INSERT OR IGNORE INTO accounting_mappings(mapping_key, account_id, description) VALUES
  ('ACCOUNTS_RECEIVABLE', 1200, 'Default customer receivable account'),
  ('ACCOUNTS_PAYABLE', 2100, 'Default supplier payable account'),
  ('INVENTORY', 1300, 'Default inventory asset account'),
  ('SALES_REVENUE', 4100, 'Default sales revenue account'),
  ('COST_OF_GOODS_SOLD', 5100, 'Default cost of goods sold account'),
  ('INVENTORY_ADJUSTMENT', 6100, 'Default inventory adjustment account');

INSERT OR IGNORE INTO units(id, code, name, unit_type) VALUES
  (1, 'ITEM', 'Item', 'ITEM'),
  (2, 'KG', 'Kilogram', 'WEIGHT'),
  (3, 'M', 'Meter', 'LENGTH');
INSERT OR IGNORE INTO item_categories(id, name) VALUES
  (1, 'Uncategorized'),
  (2, 'Beverages'),
  (3, 'Food'),
  (4, 'Electronics'),
  (5, 'Office Supplies'),
  (6, 'Medical Supplies');
INSERT OR IGNORE INTO warehouses(id, code, name) VALUES (1, 'MAIN', 'Main Warehouse');

INSERT OR IGNORE INTO payment_methods(id, code, name, method_type, account_id) VALUES
  (1, 'CASH', 'Cash', 'CASH', 1110),
  (2, 'BANKAK', 'Bankak', 'BANK', 1120),
  (3, 'OCASH', 'OCash', 'BANK', 1130),
  (4, 'FAWRY', 'Fawry', 'BANK', 1140),
  (5, 'MYCASHI', 'MyCashi', 'BANK', 1150),
  (6, 'CREDIT', 'Credit', 'CREDIT', 1200);

INSERT OR IGNORE INTO account_currencies(account_id, currency_id)
SELECT a.id, c.id FROM accounts a CROSS JOIN currencies c WHERE a.is_active = 1 AND c.is_active = 1;

INSERT OR IGNORE INTO additional_cost_types(id, name, inventory_account_id) VALUES
  (1, 'Additional Cost', 1300),
  (2, 'Shipment', 1300),
  (3, 'Customs', 1300),
  (4, 'Carriage', 1300),
  (5, 'Other', 1300);
