'use strict';

const { app, BrowserWindow, ipcMain, dialog, safeStorage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const { initializeDatabase } = require('./database');
const { buildBarcodeLabelsHtml } = require('./barcode');
const { buildReportHtml, buildFooterTemplate, buildAttachmentPages, attachmentStyles, buildBrandHeading, brandingStyles,
  buildSalesInvoiceHtml, buildPurchaseInvoiceHtml, buildPurchaseOrderHtml } = require('./report-pdf');
const { LicenseService } = require('../licensing/license-service');
const APP_ICON = path.join(__dirname, '..', 'icon.png');

const ADMIN_ROLE = 'System Administrator';
const ALLOWED_ROLES = new Set([ADMIN_ROLE, 'Manager', 'Staff']);
const sessions = new Map();
const pendingJournalAttachments = new Map();
const rpcHandlers = new Map();
const webSessionIds = new Set();
const MANAGE_CHANNELS = new Set([
  'purchase-orders:save', 'purchase-orders:set-status', 'purchase-orders:delete',
  'purchases:add-cost', 'purchases:create', 'purchases:update', 'purchases:delete',
  'suppliers:add', 'products:add', 'products:update', 'categories:save', 'categories:delete',
  'sales:create', 'sales:update', 'sales:delete', 'customers:add',
  'hr:save-employee', 'hr:deactivate-employee', 'hr:save-attendance', 'hr:delete-attendance',
  'hr:save-leave-balance', 'hr:add-leave-entry', 'hr:delete-leave-entry', 'hr:create-payroll',
  'hr:save-payroll', 'hr:finalize-payroll', 'hr:post-payroll', 'accounting:save-account',
  'accounting:create-voucher', 'accounting:create-manual-journal', 'accounting:update-manual-journal',
  'accounting:delete-journal', 'inventory:change-status', 'inventory:adjust', 'inventory:transfer',
  'inventory:update-balance', 'inventory:create-salvage'
]);
const originalIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => {
  const securedHandler = (event, ...args) => {
    authorizeChannel(event, channel, args);
    return handler(event, ...args);
  };
  rpcHandlers.set(channel, securedHandler);
  return originalIpcHandle(channel, securedHandler);
};
let databasePromise;
let webServerInfo = { port: 0, urls: [] };
let licenseService;

function permissionScreens(channel, args) {
  if (channel.startsWith('funding:')) return ['inventory', 'treasury', 'accounting'];
  if (channel.startsWith('goods-receipts:') || channel.startsWith('pricing:')) return ['inventory'];
  if (channel.startsWith('returns:')) return ['sales', 'inventory', 'treasury'];
  if (channel.startsWith('purchase-orders:') || channel.startsWith('purchases:') || channel.startsWith('suppliers:') ||
      channel.startsWith('products:') || channel.startsWith('categories:') || channel.startsWith('inventory:')) return ['inventory'];
  if (channel.startsWith('sales:') || channel.startsWith('customers:')) return ['sales'];
  if (channel === 'hr:post-payroll') return ['hr', 'treasury', 'journalAccount'];
  if (channel.startsWith('hr:')) return ['hr'];
  if (channel === 'reports:run' && String(args[0] || '') === 'profit_loss') return ['reports', 'dashboard'];
  if (channel.startsWith('reports:')) return ['reports'];
  if (channel === 'accounting:overview') return ['dashboard', 'sales', 'inventory', 'treasury', 'journalAccount', 'accounting', 'hr', 'reports'];
  if (channel === 'accounting:save-account' || channel === 'accounting:ledger') return ['accounting'];
  if (channel === 'accounting:release-attachments') return null;
  if (channel === 'accounting:create-voucher' || channel === 'accounting:next-voucher-number') return ['treasury', 'journalAccount'];
  if (channel === 'accounting:journal' || (channel.startsWith('accounting:') && channel.includes('attachment'))) return ['treasury', 'journalAccount', 'accounting'];
  if (channel.startsWith('accounting:')) return ['journalAccount'];
  if (channel.startsWith('documents:view-invoice') || channel.startsWith('documents:export-invoice')) {
    return [String(args[0] || '').toUpperCase() === 'SALE' ? 'sales' : 'inventory'];
  }
  return null;
}

function authorizeChannel(event, channel, args) {
  const screens = permissionScreens(channel, args);
  if (!screens) return;
  const user = getSession(event);
  if (user.role === ADMIN_ROLE) return;
  const needed = MANAGE_CHANNELS.has(channel) ? 'manage' : 'view';
  const allowed = screens.some(screen => {
    const level = user.permissions?.[screen];
    return level === 'manage' || (needed === 'view' && level === 'view');
  });
  if (!allowed) throw new Error(`${needed === 'manage' ? 'Manage' : 'View'} access is required for this operation.`);
}

const HOST_ONLY_CHANNELS = new Set([
  'documents:select-images', 'accounting:select-attachments',
  'documents:export-invoice-attachment', 'accounting:export-attachment',
  'products:print-barcode', 'sales:export-pdf', 'purchases:export-pdf',
  'purchase-orders:export-pdf', 'reports:export-pdf', 'reports:export-purchases-pdf'
]);

function getSession(event) {
  const user = sessions.get(event.sender.id);
  if (!user) throw new Error('Authentication required.');
  return user;
}

const IMAGE_MIME_TYPES = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' });
const RECORD_MIME_TYPES = Object.freeze({ '.pdf': 'application/pdf', ...IMAGE_MIME_TYPES });
const SAFE_PREVIEW_MIME_TYPES = new Set(Object.values(RECORD_MIME_TYPES));

async function selectPdfAttachments(owner) {
  const result = await dialog.showOpenDialog(owner, {
    title: 'Select images to append to the PDF (optional)', buttonLabel: 'Attach selected images',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Image files', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
  });
  if (result.canceled) return [];
  return result.filePaths.map(filePath => {
    const extension = path.extname(filePath).toLowerCase(); const mimeType = IMAGE_MIME_TYPES[extension];
    if (!mimeType) throw new Error(`Unsupported image type: ${extension}`);
    return { name: path.basename(filePath), dataUrl: `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}` };
  });
}

function readPendingImages(event, tokenValue) {
  const token = String(tokenValue || ''); if (!token) return { token: '', attachments: [] };
  const selection = pendingJournalAttachments.get(token);
  if (!selection || selection.senderId !== event.sender.id) throw new Error('The selected attachments are no longer available. Select them again.');
  const attachments = selection.files.map(file => {
    const mimeType = RECORD_MIME_TYPES[file.extension];
    if (!mimeType) throw new Error(`${file.name} is not a supported attachment.`);
    return { name: file.name, size: file.size, mimeType, data: fs.readFileSync(file.path) };
  });
  return { token, attachments };
}

async function printHtmlPdf({ html, filePath, footerTemplate, landscape = false }) {
  const temporaryHtml = path.join(app.getPath('temp'), `holool-pdf-${crypto.randomUUID()}.html`);
  const reportWindow = new BrowserWindow({ show: false, icon: APP_ICON, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    fs.writeFileSync(temporaryHtml, html, 'utf8');
    await reportWindow.loadFile(temporaryHtml);
    await reportWindow.webContents.executeJavaScript(`Promise.all(Array.from(document.images).map(image => image.complete ? Promise.resolve() : new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; })))`);
    const pdf = await reportWindow.webContents.printToPDF({ printBackground: true, pageSize: 'A4', landscape,
      preferCSSPageSize: true, displayHeaderFooter: Boolean(footerTemplate), headerTemplate: '<div></div>', footerTemplate: footerTemplate || '<div></div>' });
    fs.writeFileSync(filePath, pdf);
  } finally {
    reportWindow.destroy();
    if (fs.existsSync(temporaryHtml)) fs.unlinkSync(temporaryHtml);
  }
}

async function saveBarcodePdf({ html, filePath }) {
  const temporaryHtml = path.join(app.getPath('temp'), `holool-barcode-${crypto.randomUUID()}.html`);
  const printWindow = new BrowserWindow({ show: false, icon: APP_ICON,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    fs.writeFileSync(temporaryHtml, html, 'utf8');
    await printWindow.loadFile(temporaryHtml);
    const pdf = await printWindow.webContents.printToPDF({
      printBackground: true, preferCSSPageSize: true,
      pageSize: { width: 50000, height: 30000 }, margins: { top: 0, bottom: 0, left: 0, right: 0 }
    });
    fs.writeFileSync(filePath, pdf);
  } finally {
    printWindow.destroy();
    if (fs.existsSync(temporaryHtml)) fs.unlinkSync(temporaryHtml);
  }
}
function requireAdministrator(event) {
  const user = getSession(event);
  if (user.role !== ADMIN_ROLE) throw new Error('Administrator access required.');
  return user;
}

function requireCapability(event, capability) {
  const user = getSession(event);
  if (user.role === ADMIN_ROLE || user.capabilities?.includes(capability)) return user;
  throw new Error(`Permission required: ${capability.replaceAll('_', ' ')}.`);
}

function requireAnyCapability(event, capabilities) {
  const user = getSession(event);
  if (user.role === ADMIN_ROLE || capabilities.some(capability => user.capabilities?.includes(capability))) return user;
  throw new Error(`Permission required: ${capabilities.join(' or ')}.`);
}

ipcMain.handle('auth:login', async (event, credentials) => {
  const user = (await databasePromise).authenticate(String(credentials?.username || '').trim(), String(credentials?.password || ''));
  if (!user) return null;
  sessions.set(event.sender.id, user);
  return user;
});
ipcMain.handle('auth:logout', event => { sessions.delete(event.sender.id);
  for (const [token, selection] of pendingJournalAttachments) if (selection.senderId === event.sender.id) pendingJournalAttachments.delete(token);
  return true; });

ipcMain.handle('users:list', async event => { requireAdministrator(event); return (await databasePromise).listUsers(); });
ipcMain.handle('users:add', async (event, input) => {
  requireAdministrator(event);
  const username = String(input?.username || '').trim();
  const password = String(input?.password || '');
  const role = String(input?.role || '');
  const permissions = input?.permissions && typeof input.permissions === 'object' ? input.permissions : {};
  if (!username || !password) throw new Error('Username and password are required.');
  if (password.length < 8) throw new Error('Passwords must contain at least 8 characters.');
  if (!ALLOWED_ROLES.has(role)) throw new Error('Invalid user role.');
  const database = await databasePromise;
  if (database.listUsers().some(user => user.username.toLowerCase() === username.toLowerCase())) throw new Error('That username already exists.');
  return database.addUser({ id: crypto.randomUUID(), username, password, role, permissions,
    jobProfile: input?.jobProfile, capabilities: input?.capabilities });
});
ipcMain.handle('users:update', async (event, userId, input) => {
  requireAdministrator(event);
  const targetId = String(userId || '');
  const role = String(input?.role || '');
  if (!ALLOWED_ROLES.has(role)) throw new Error('Invalid user role.');
  if (!String(input?.username || '').trim()) throw new Error('Username is required.');
  if (String(input?.password || '') && String(input.password).length < 8) throw new Error('Passwords must contain at least 8 characters.');
  const database = await databasePromise;
  const duplicate = database.listUsers().find(user => user.id !== targetId && user.username.toLowerCase() === String(input.username).trim().toLowerCase());
  if (duplicate) throw new Error('That username already exists.');
  const users = database.updateUser(targetId, { ...input, role });
  const refreshed = users.find(user => user.id === targetId);
  for (const [senderId, session] of sessions) if (session.id === targetId && refreshed) sessions.set(senderId, refreshed);
  return users;
});
ipcMain.handle('users:delete', async (event, userId) => {
  const currentUser = requireAdministrator(event);
  const targetId = String(userId || '');
  if (!targetId || targetId === 'admin') throw new Error('The default administrator cannot be deleted.');
  if (targetId === currentUser.id) throw new Error('You cannot delete the account currently in use.');
  const users = (await databasePromise).deactivateUser(targetId);
  for (const [senderId, session] of sessions) if (session.id === targetId) sessions.delete(senderId);
  return users;
});

ipcMain.handle('database:info', async event => { getSession(event); return (await databasePromise).getInfo(); });
// This setting is safe to read before authentication, allowing LAN clients to
// render even the sign-in screen in the installation's selected language.
ipcMain.handle('settings:get-locale', async () => (await databasePromise).getApplicationLocale());
ipcMain.handle('settings:save-locale', async (event, locale) => {
  requireAdministrator(event);
  return (await databasePromise).saveApplicationLocale(locale);
});
ipcMain.handle('settings:get-branding', async event => { getSession(event); return (await databasePromise).getBusinessBranding(); });
ipcMain.handle('settings:save-branding', async (event, input) => { requireAdministrator(event); return (await databasePromise).saveBusinessBranding(input || {}); });
ipcMain.handle('purchases:setup', async event => {
  const user = requireAnyCapability(event, ['product_create','purchase_order_view','purchase_order_create','purchase_order_commercial_approve','purchase_order_commercial_reject','purchase_order_finance_approve','purchase_order_finance_reject','purchase_order_accounting_view','purchase_invoice_view','purchase_invoice_create','purchase_funding_view','purchase_disbursement_view']);
  const setup = (await databasePromise).getPurchaseSetup();
  if (user.role === ADMIN_ROLE || user.capabilities?.includes('pricing_view')) return setup;
  return { ...setup, products: setup.products.map(({ manual_sales_price, default_markup_percent, ...product }) => product) };
});
ipcMain.handle('purchases:next-code', async (event, invoiceDate) => {
  getSession(event);
  return (await databasePromise).nextPurchaseCode(String(invoiceDate || ''));
});
ipcMain.handle('purchases:next-cost-code', async (event, invoiceDate) => {
  getSession(event);
  return (await databasePromise).nextPurchaseCostCode(String(invoiceDate || ''));
});
ipcMain.handle('purchase-orders:next-number', async (event, orderDate) => { getSession(event); return (await databasePromise).nextPurchaseOrderNumber(String(orderDate || '')); });
ipcMain.handle('purchase-orders:list', async event => {
  const user = requireAnyCapability(event, ['purchase_order_view', 'purchase_order_create', 'purchase_order_commercial_approve', 'purchase_order_commercial_reject', 'purchase_order_finance_approve', 'purchase_order_finance_reject', 'purchase_order_accounting_view']);
  const accountingOnly = user.role !== ADMIN_ROLE && user.capabilities?.includes('purchase_order_accounting_view') &&
    !['purchase_order_view','purchase_order_create','purchase_order_commercial_approve','purchase_order_commercial_reject','purchase_order_finance_approve','purchase_order_finance_reject'].some(cap => user.capabilities?.includes(cap));
  return (await databasePromise).listPurchaseOrders(accountingOnly ? 'accounting' : 'all');
});
ipcMain.handle('purchase-orders:get', async (event, id) => {
  const user = requireAnyCapability(event, ['purchase_order_view', 'purchase_order_create', 'purchase_order_commercial_approve', 'purchase_order_commercial_reject', 'purchase_order_finance_approve', 'purchase_order_finance_reject', 'purchase_order_accounting_view']);
  const accountingOnly = user.role !== ADMIN_ROLE && user.capabilities?.includes('purchase_order_accounting_view') &&
    !['purchase_order_view','purchase_order_create','purchase_order_commercial_approve','purchase_order_commercial_reject','purchase_order_finance_approve','purchase_order_finance_reject'].some(cap => user.capabilities?.includes(cap));
  return (await databasePromise).getPurchaseOrder(Number(id), accountingOnly ? 'accounting' : 'all');
});
ipcMain.handle('purchase-orders:save', async (event, id, input) => {
  const user = input?.confirm ? requireCapability(event, 'purchase_order_submit')
    : requireCapability(event, Number(id) ? 'purchase_order_edit' : 'purchase_order_create');
  return (await databasePromise).savePurchaseOrder(Number(id) || null, input || {}, user.id);
});
ipcMain.handle('purchase-orders:set-status', async (event, id, action) => {
  const normalized = String(action || '').toUpperCase();
  const user = ['SUBMIT', 'CONFIRM'].includes(normalized) ? requireCapability(event, 'purchase_order_submit') : requireCapability(event, 'purchase_order_edit');
  return (await databasePromise).setPurchaseOrderStatus(Number(id), normalized, user.id);
});
ipcMain.handle('purchase-orders:approval', async (event, id, action, comment) => {
  const normalized = String(action || '').toUpperCase();
  const capabilities = {
    COMMERCIAL_APPROVE: 'purchase_order_commercial_approve', COMMERCIAL_REJECT: 'purchase_order_commercial_reject',
    FINANCE_APPROVE: 'purchase_order_finance_approve', FINANCE_REJECT: 'purchase_order_finance_reject'
  };
  if (!capabilities[normalized]) throw new Error('Invalid purchase-order decision.');
  const user = requireCapability(event, capabilities[normalized]);
  return (await databasePromise).setPurchaseOrderStatus(Number(id), normalized, user.id, comment);
});
ipcMain.handle('purchase-orders:delete', async (event, id) => { requireCapability(event, 'purchase_order_edit'); return (await databasePromise).deletePurchaseOrder(Number(id)); });
ipcMain.handle('purchases:list', async event => { requireAnyCapability(event, ['purchase_invoice_view', 'purchase_invoice_create', 'purchase_funding_view']); return (await databasePromise).listPurchases(); });
ipcMain.handle('purchases:get', async (event, id) => { requireAnyCapability(event, ['purchase_invoice_view', 'purchase_invoice_create', 'purchase_funding_view']); return (await databasePromise).getPurchase(Number(id)); });
ipcMain.handle('purchases:add-cost', async (event, purchaseId, input) => {
  const user = requireCapability(event, 'purchase_cost_manage');
  return (await databasePromise).addPurchaseAdditionalCost(Number(purchaseId), input, user.id);
});
ipcMain.handle('purchases:create', async (event, input) => {
  const user = requireCapability(event, 'purchase_invoice_create'); const selected = readPendingImages(event, input?.attachmentToken);
  const invoice = (await databasePromise).createPurchase({ ...input,
    allowPricing: user.role === ADMIN_ROLE || user.capabilities?.includes('pricing_publish') }, selected.attachments, user.id);
  if (selected.token) pendingJournalAttachments.delete(selected.token);
  return invoice;
});
ipcMain.handle('purchases:update', async (event, id, input) => {
  const user = requireCapability(event, 'purchase_invoice_edit'); const selected = readPendingImages(event, input?.attachmentToken);
  const invoice = await (await databasePromise).updatePurchase(Number(id), { ...input,
    allowPricing: user.role === ADMIN_ROLE || user.capabilities?.includes('pricing_publish') }, selected.attachments, user.id);
  if (selected.token) pendingJournalAttachments.delete(selected.token);
  return invoice;
});
ipcMain.handle('purchases:delete', async (event, id) => {
  requireCapability(event, 'purchase_invoice_edit'); return (await databasePromise).deletePurchase(Number(id));
});
ipcMain.handle('purchases:submit', async (event, id) => {
  const user = requireCapability(event, 'purchase_invoice_submit');
  return (await databasePromise).submitPurchaseInvoice(Number(id), user.id);
});
ipcMain.handle('funding:list', async event => {
  requireAnyCapability(event, ['purchase_funding_view', 'purchase_disbursement_view']);
  return (await databasePromise).listPurchaseFunding();
});
ipcMain.handle('funding:decide', async (event, id, action, comment) => {
  const capability = String(action || '').toUpperCase() === 'REJECT' ? 'purchase_funding_reject' : 'purchase_funding_approve';
  const user = requireCapability(event, capability);
  return (await databasePromise).decidePurchaseFunding(Number(id), action, comment, user.id);
});
ipcMain.handle('disbursements:list', async event => {
  requireCapability(event, 'purchase_disbursement_view');
  return (await databasePromise).listPurchaseDisbursements();
});
ipcMain.handle('disbursements:create', async (event, id, input) => {
  const user = requireCapability(event, 'purchase_disbursement_create');
  return (await databasePromise).createPurchaseDisbursement(Number(id), input || {}, user.id);
});
ipcMain.handle('disbursements:export-pdf', async (event, id) => {
  const user = requireCapability(event, 'purchase_disbursement_view'); const database = await databasePromise;
  const order = database.getPurchaseDisbursement(Number(id));
  if (!order || order.status !== 'EXECUTED') throw new Error('Only an executed disbursement voucher can be exported.');
  const owner = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(owner, { title: 'Export payment voucher', defaultPath: `${order.payment_number}.pdf`,
    filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  const branding = database.getBusinessBranding();
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${brandingStyles()}body{font-family:Arial,sans-serif;color:#172033;padding:28px}header{border-bottom:2px solid #172033;margin-bottom:24px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 28px}.grid div{border-bottom:1px solid #ddd;padding:9px 0}.grid span{display:block;color:#667085;font-size:12px}.amount{font-size:24px;font-weight:700}.signatures{display:grid;grid-template-columns:1fr 1fr;gap:60px;margin-top:70px}.signatures div{border-top:1px solid #172033;padding-top:8px}</style></head><body><header>${buildBrandHeading(branding)}<h1>Payment Voucher</h1><p>${escapeHtml(order.payment_number)}</p></header><section class="grid"><div><span>Disbursement order</span>${escapeHtml(order.order_number)}</div><div><span>Purchase invoice</span>${escapeHtml(order.invoice_code)}</div><div><span>Supplier</span>${escapeHtml(order.supplier_name)}</div><div><span>Payment route</span>${escapeHtml(String(order.payment_mode).replaceAll('_',' '))}</div><div><span>Debit account</span>${escapeHtml(order.debit_account_code)} - ${escapeHtml(order.debit_account_name)}</div><div><span>Cash / bank account</span>${escapeHtml(order.payment_account_name)}</div><div><span>Amount</span><strong class="amount">${money(order.executed_amount)} ${escapeHtml(order.currency_code)}</strong></div><div><span>Executed at</span>${escapeHtml(order.executed_at || '')}</div><div><span>Accountant instruction</span>${escapeHtml(order.instructed_by_name)}</div><div><span>Treasury execution</span>${escapeHtml(order.executed_by_name)}</div></section><section class="signatures"><div>Accountant signature</div><div>Treasury Manager signature</div></section></body></html>`;
  await printHtmlPdf({ html, filePath: result.filePath });
  return { canceled: false, filePath: result.filePath };
});
ipcMain.handle('funding:pay', async (event, id, input) => {
  const user = requireCapability(event, 'purchase_disbursement_execute');
  return (await databasePromise).executeSupplierPayment(Number(id), input || {}, user.id);
});
ipcMain.handle('goods-receipts:list', async event => {
  requireCapability(event, 'goods_receipt_view');
  return (await databasePromise).listGoodsReceiptQueue();
});
ipcMain.handle('goods-receipts:confirm', async (event, input) => {
  const user = requireCapability(event, 'goods_receipt_confirm');
  return (await databasePromise).confirmGoodsReceipt(input || {}, user.id);
});
ipcMain.handle('pricing:list', async event => {
  const user = requireCapability(event, 'pricing_view');
  const rows = (await databasePromise).getPricingWorkspace();
  if (user.role === ADMIN_ROLE || user.capabilities?.includes('pricing_cost_view')) return rows;
  return rows.map(({ landed_cost_base, ...row }) => row);
});
ipcMain.handle('pricing:publish', async (event, input) => {
  const user = requireCapability(event, 'pricing_publish');
  return (await databasePromise).publishProductPrice(input || {}, user.id);
});
ipcMain.handle('suppliers:add', async (event, input) => { requireCapability(event, 'supplier_manage'); return (await databasePromise).addSupplier(input); });
ipcMain.handle('products:add', async (event, input) => {
  const user = requireCapability(event, 'product_create');
  return (await databasePromise).addProduct(input, user.id);
});
ipcMain.handle('products:update', async (event, productId, input) => {
  requireAdministrator(event); return (await databasePromise).updateProduct(productId, input || {});
});
ipcMain.handle('products:print-barcode', async (event, productId, copies) => {
  getSession(event);
  const count = Math.trunc(Number(copies));
  if (!(count >= 1 && count <= 100)) throw new Error('Choose between 1 and 100 barcode labels.');
  const database = await databasePromise;
  const details = database.getProductDetails(Number(productId));
  if (!details?.product?.barcode) throw new Error('This product does not have a barcode.');
  const owner = BrowserWindow.fromWebContents(event.sender);
  const safeName = String(details.product.sku || details.product.barcode).replace(/[^A-Za-z0-9_-]/g, '-');
  const result = await dialog.showSaveDialog(owner, { title: `Save barcode labels for ${details.product.name}`,
    defaultPath: `barcode-${safeName}.pdf`, filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  await saveBarcodePdf({ html: buildBarcodeLabelsHtml(details.product, count, database.getBusinessBranding()), filePath: result.filePath });
  return { canceled: false, filePath: result.filePath };
});
ipcMain.handle('categories:list', async event => { getSession(event); return (await databasePromise).listCategories(); });
ipcMain.handle('categories:save', async (event, input) => {
  requireAdministrator(event); return (await databasePromise).saveCategory(input || {});
});
ipcMain.handle('categories:delete', async (event, categoryId) => {
  requireAdministrator(event); return (await databasePromise).deleteCategory(categoryId);
});
ipcMain.handle('sales:setup', async event => {
  const user = requireAnyCapability(event, ['sale_create', 'sale_view_own', 'sale_view_all', 'sales_return_create']);
  const setup = (await databasePromise).getSalesSetup();
  if (user.role === ADMIN_ROLE || ['stock_cost_view','pricing_cost_view','sensitive_cost_reports_view'].some(cap => user.capabilities?.includes(cap))) return setup;
  return { ...setup, products: setup.products.map(({ average_unit_cost_base, ...product }) => product) };
});
ipcMain.handle('sales:list', async event => { const user = requireAnyCapability(event, ['sale_create', 'sale_view_own', 'sale_view_all', 'sales_return_create']); return (await databasePromise).listSales(user.role === ADMIN_ROLE || user.capabilities?.includes('sale_view_all') ? null : user.id); });
ipcMain.handle('sales:get', async (event, id) => { const user = requireAnyCapability(event, ['sale_create', 'sale_view_own', 'sale_view_all', 'sales_return_create']); return (await databasePromise).getSale(Number(id), user.role === ADMIN_ROLE || user.capabilities?.includes('sale_view_all') ? null : user.id); });
ipcMain.handle('sales:create', async (event, input) => {
  const user = requireCapability(event, 'sale_create'); const selected = readPendingImages(event, input?.attachmentToken);
  const invoice = (await databasePromise).createSale({ ...input, allowPriceIncrease: user.role === ADMIN_ROLE || user.capabilities?.includes('sale_price_increase') }, selected.attachments, user.id);
  if (selected.token) pendingJournalAttachments.delete(selected.token);
  return invoice;
});
ipcMain.handle('sales:update', async (event, id, input) => {
  const user = requireCapability(event, 'sale_create'); const selected = readPendingImages(event, input?.attachmentToken);
  const invoice = await (await databasePromise).updateSale(Number(id), { ...input, allowPriceIncrease: user.role === ADMIN_ROLE || user.capabilities?.includes('sale_price_increase') }, selected.attachments, user.id, user.role === ADMIN_ROLE || user.capabilities?.includes('sale_view_all'));
  if (selected.token) pendingJournalAttachments.delete(selected.token);
  return invoice;
});
ipcMain.handle('sales:delete', async (event, id) => {
  const user = requireCapability(event, 'sale_create'); return (await databasePromise).deleteSale(Number(id), user.id,
    user.role === ADMIN_ROLE || user.capabilities?.includes('sale_view_all'));
});
ipcMain.handle('customers:add', async (event, input) => { requireCapability(event, 'sale_create'); return (await databasePromise).addCustomer(input); });
ipcMain.handle('returns:list', async event => {
  const user = getSession(event);
  if (user.role !== ADMIN_ROLE && !['sales_return_create', 'sales_return_approve', 'purchase_funding_approve', 'sales_return_settle', 'sale_view_all'].some(cap => user.capabilities?.includes(cap)))
    throw new Error('Permission required to view sales returns.');
  return (await databasePromise).listSalesReturns();
});
ipcMain.handle('returns:create', async (event, input) => {
  const user = requireCapability(event, 'sales_return_create');
  return (await databasePromise).createSalesReturn(input || {}, user.id);
});
ipcMain.handle('returns:decide', async (event, id, action, comment) => {
  const normalized = String(action || '').toUpperCase();
  const user = normalized === 'FINANCE_APPROVE' ? requireCapability(event, 'purchase_funding_approve')
    : normalized === 'COMMERCIAL_APPROVE' ? requireCapability(event, 'sales_return_approve')
      : requireAnyCapability(event, ['sales_return_approve', 'purchase_funding_approve']);
  return (await databasePromise).decideSalesReturn(Number(id), normalized, comment, user.id);
});
ipcMain.handle('returns:settle', async (event, id, paymentMethodId) => {
  const user = requireCapability(event, 'sales_return_settle');
  return (await databasePromise).settleSalesReturn(Number(id), Number(paymentMethodId), user.id);
});
ipcMain.handle('sales:export-pdf', async (event, saleId, locale = 'en') => {
  const user = getSession(event); const owner = BrowserWindow.fromWebContents(event.sender);
  const database = await databasePromise;
  const invoice = database.getSale(Number(saleId));
  if (!invoice) throw new Error('Sales invoice was not found.');
  const attachments = [];
  const result = await dialog.showSaveDialog(owner, { title: `Export Sales Invoice ${invoice.invoice_number}`,
    defaultPath: `sales-invoice-${invoice.invoice_number}.pdf`, filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  const branding = database.getBusinessBranding();
  await printHtmlPdf({ html: buildSalesInvoiceHtml(invoice, user, attachments, branding, locale), filePath: result.filePath,
    footerTemplate: buildFooterTemplate({ title: `Sales Invoice ${invoice.invoice_number}` }, branding) });
  return { canceled: false, filePath: result.filePath, attachmentCount: attachments.length };
});
ipcMain.handle('purchases:export-pdf', async (event, purchaseId, locale = 'en') => {
  const user = getSession(event); const owner = BrowserWindow.fromWebContents(event.sender);
  const database = await databasePromise;
  const invoice = database.getPurchase(Number(purchaseId));
  if (!invoice) throw new Error('Purchase invoice was not found.');
  const attachments = [];
  const result = await dialog.showSaveDialog(owner, { title: `Export Purchase Invoice ${invoice.invoice_code}`,
    defaultPath: `purchase-invoice-${invoice.invoice_code}.pdf`, filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  const branding = database.getBusinessBranding();
  await printHtmlPdf({ html: buildPurchaseInvoiceHtml(invoice, user, attachments, branding, locale), filePath: result.filePath,
    footerTemplate: buildFooterTemplate({ title: `Purchase Invoice ${invoice.invoice_code}` }, branding) });
  return { canceled: false, filePath: result.filePath, attachmentCount: attachments.length };
});
ipcMain.handle('purchase-orders:export-pdf', async (event, purchaseOrderId, locale = 'en') => {
  const user = requireAnyCapability(event, ['purchase_order_view', 'purchase_order_create', 'purchase_order_commercial_approve', 'purchase_order_commercial_reject', 'purchase_order_finance_approve', 'purchase_order_finance_reject', 'purchase_order_accounting_view']);
  const owner = BrowserWindow.fromWebContents(event.sender);
  const database = await databasePromise;
  const accountingOnly = user.role !== ADMIN_ROLE && user.capabilities?.includes('purchase_order_accounting_view') &&
    !['purchase_order_view','purchase_order_create','purchase_order_commercial_approve','purchase_order_commercial_reject','purchase_order_finance_approve','purchase_order_finance_reject'].some(cap => user.capabilities?.includes(cap));
  const order = database.getPurchaseOrder(Number(purchaseOrderId), accountingOnly ? 'accounting' : 'all');
  if (!order) throw new Error('Purchase order was not found.');
  const result = await dialog.showSaveDialog(owner, { title: `Export Purchase Order ${order.po_number}`,
    defaultPath: `purchase-order-${order.po_number}.pdf`, filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  const branding = database.getBusinessBranding();
  await printHtmlPdf({ html: buildPurchaseOrderHtml(order, user, branding, locale), filePath: result.filePath,
    footerTemplate: buildFooterTemplate({ title: `Purchase Order ${order.po_number}` }, branding) });
  return { canceled: false, filePath: result.filePath };
});
ipcMain.handle('hr:data', async event => { getSession(event); return (await databasePromise).getHrData(); });
ipcMain.handle('hr:save-employee', async (event, input) => { requireCapability(event, 'employee_manage'); return (await databasePromise).saveEmployee(input || {}); });
ipcMain.handle('hr:save-grade', async (event, input) => { requireCapability(event, 'employee_manage'); return (await databasePromise).saveSalaryGrade(input || {}); });
ipcMain.handle('hr:deactivate-employee', async (event, id) => { requireCapability(event, 'employee_manage'); return (await databasePromise).deactivateEmployee(Number(id)); });
ipcMain.handle('hr:save-attendance', async (event, input) => { const user = getSession(event); return (await databasePromise).saveAttendance(input || {}, user.id); });
ipcMain.handle('hr:delete-attendance', async (event, id) => { getSession(event); return (await databasePromise).deleteAttendance(Number(id)); });
ipcMain.handle('hr:save-leave-balance', async (event, input) => { getSession(event); return (await databasePromise).saveLeaveBalance(input || {}); });
ipcMain.handle('hr:add-leave-entry', async (event, input) => { getSession(event); return (await databasePromise).addLeaveEntry(input || {}); });
ipcMain.handle('hr:delete-leave-entry', async (event, id) => { getSession(event); return (await databasePromise).deleteLeaveEntry(Number(id)); });
ipcMain.handle('hr:create-payroll', async (event, input) => { const user = requireCapability(event, 'payroll_prepare'); return (await databasePromise).createPayrollRun(input || {}, user.id); });
ipcMain.handle('hr:get-payroll', async (event, id) => { getSession(event); return (await databasePromise).getPayrollRun(Number(id)); });
ipcMain.handle('hr:save-payroll', async (event, id, input) => { requireCapability(event, 'payroll_prepare'); return (await databasePromise).savePayrollRun(Number(id), input || {}); });
ipcMain.handle('hr:finalize-payroll', async (event, id) => { requireCapability(event, 'payroll_submit'); return (await databasePromise).finalizePayrollRun(Number(id)); });
ipcMain.handle('hr:decide-payroll', async (event, id, action, comment) => {
  const user = requireCapability(event, 'payroll_approve');
  return (await databasePromise).decidePayrollRun(Number(id), action, comment, user.id);
});
ipcMain.handle('hr:post-payroll', async (event, id, paymentMethodId) => { const user = requireCapability(event, 'payroll_payment_execute'); return (await databasePromise).postPayrollRun(Number(id), Number(paymentMethodId), user.id); });
ipcMain.handle('accounting:overview', async event => {
  const user = getSession(event); const overview = (await databasePromise).getAccountingOverview();
  const treasuryOnly = user.role !== ADMIN_ROLE && user.permissions?.treasury && !user.permissions?.journalAccount && !user.permissions?.accounting;
  if (treasuryOnly) overview.journals = overview.journals.filter(row => ['RECEIPT', 'PAYMENT'].includes(row.source_type));
  return overview;
});
ipcMain.handle('accounting:save-account', async (event, input) => {
  requireAdministrator(event);
  const database = await databasePromise;
  const id = database.saveAccount(input || {});
  return database.getAccountingOverview().accounts.find(account => Number(account.id) === Number(id));
});
ipcMain.handle('accounting:next-manual-number', async (event, entryDate) => {
  getSession(event); return (await databasePromise).nextManualJournalNumber(String(entryDate || ''));
});
ipcMain.handle('accounting:next-voucher-number', async (event, voucherType, entryDate) => {
  getSession(event); return (await databasePromise).nextCashVoucherNumber(String(voucherType || ''), String(entryDate || ''));
});
ipcMain.handle('accounting:create-voucher', async (event, voucherType, input) => {
  const type = String(voucherType || '').toLowerCase();
  const user = requireCapability(event, type === 'receipt' ? 'treasury_receipt_post' : 'treasury_payment_post');
  const selected = readPendingImages(event, input?.attachmentToken);
  const voucher = (await databasePromise).createCashVoucher(String(voucherType || ''), input || {}, selected.attachments, user.id);
  if (selected.token) pendingJournalAttachments.delete(selected.token);
  return voucher;
});
ipcMain.handle('documents:select-images', async event => {
  getSession(event); const owner = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(owner, { title: 'Attach files', buttonLabel: 'Attach',
    properties: ['openFile', 'multiSelections'], filters: [
      { name: 'Images and PDF documents', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }
    ] });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  if (result.filePaths.length > 10) throw new Error('Select no more than 10 attachments.');
  const files = result.filePaths.map(filePath => { const stat = fs.statSync(filePath); return {
    path: filePath, name: path.basename(filePath), size: stat.size, extension: path.extname(filePath).toLowerCase() }; });
  if (files.some(file => !RECORD_MIME_TYPES[file.extension])) throw new Error('Only image and PDF attachments are supported.');
  if (files.some(file => file.size > 10 * 1024 * 1024)) throw new Error('Each attachment must be 10 MB or smaller.');
  if (files.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024) throw new Error('Attachments cannot exceed 25 MB in total.');
  const token = crypto.randomUUID(); pendingJournalAttachments.set(token, { senderId: event.sender.id, files });
  return { canceled: false, token, files: files.map(({ name, size, extension }) => ({
    name, size, extension, mimeType: RECORD_MIME_TYPES[extension]
  })) };
});ipcMain.handle('accounting:select-attachments', async event => {
  getSession(event); const owner = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(owner, { title: 'Attach supporting documents', buttonLabel: 'Attach',
    properties: ['openFile', 'multiSelections'], filters: [
      { name: 'Supporting documents', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'docx', 'xlsx', 'xls', 'csv', 'txt'] },
      { name: 'All files', extensions: ['*'] }
    ] });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  if (result.filePaths.length > 10) throw new Error('Select no more than 10 attachments.');
  const files = result.filePaths.map(filePath => { const stat = fs.statSync(filePath); return { path: filePath,
    name: path.basename(filePath), size: stat.size, extension: path.extname(filePath).toLowerCase() }; });
  if (files.some(file => file.size > 10 * 1024 * 1024)) throw new Error('Each attachment must be 10 MB or smaller.');
  if (files.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024) throw new Error('Attachments cannot exceed 25 MB in total.');
  const token = crypto.randomUUID(); pendingJournalAttachments.set(token, { senderId: event.sender.id, files });
  return { canceled: false, token, files: files.map(({ name, size, extension }) => ({ name, size, extension })) };
});
ipcMain.handle('accounting:release-attachments', (event, token) => {
  getSession(event); const selection = pendingJournalAttachments.get(String(token || ''));
  if (selection?.senderId === event.sender.id) pendingJournalAttachments.delete(String(token));
  return true;
});
ipcMain.handle('accounting:create-manual-journal', async (event, input) => {
  const user = getSession(event); const token = String(input?.attachmentToken || '');
  const selection = token ? pendingJournalAttachments.get(token) : null;
  if (token && (!selection || selection.senderId !== event.sender.id)) throw new Error('The selected attachments are no longer available. Select them again before posting.');
  const mimeTypes = { '.pdf': 'application/pdf', ...IMAGE_MIME_TYPES,
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel',
    '.csv': 'text/csv', '.txt': 'text/plain' };
  const attachments = (selection?.files || []).map(file => ({ name: file.name, size: file.size,
    mimeType: mimeTypes[file.extension] || 'application/octet-stream', data: fs.readFileSync(file.path) }));
  const journal = (await databasePromise).createManualJournal(input || {}, attachments, user.id);
  if (token) pendingJournalAttachments.delete(token);
  return journal;
});
ipcMain.handle('accounting:update-manual-journal', async (event, journalId, input) => {
  const user = getSession(event); const token = String(input?.attachmentToken || '');
  const selection = token ? pendingJournalAttachments.get(token) : null;
  if (token && (!selection || selection.senderId !== event.sender.id)) throw new Error('The selected attachments are no longer available.');
  const mimeTypes = { '.pdf': 'application/pdf', ...IMAGE_MIME_TYPES,
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel',
    '.csv': 'text/csv', '.txt': 'text/plain' };
  const attachments = (selection?.files || []).map(file => ({ name: file.name, size: file.size,
    mimeType: mimeTypes[file.extension] || 'application/octet-stream', data: fs.readFileSync(file.path) }));
  const journal = (await databasePromise).updateManualJournal(Number(journalId), input || {}, attachments, user.id);
  if (token) pendingJournalAttachments.delete(token);
  return journal;
});
ipcMain.handle('accounting:delete-journal', async (event, journalId) => {
  getSession(event); return (await databasePromise).deleteJournal(Number(journalId));
});
ipcMain.handle('documents:view-invoice-image', async (event, invoiceType, invoiceId, attachmentId) => {
  getSession(event); const type = String(invoiceType || '').toUpperCase();
  if (!['SALE', 'PURCHASE'].includes(type)) throw new Error('Invalid invoice type.');
  const attachment = (await databasePromise).getInvoiceAttachment(type, Number(invoiceId), Number(attachmentId));
  if (!attachment) throw new Error('The invoice attachment was not found.');
  const mimeType = String(attachment.mime_type || '').toLowerCase();
  if (!SAFE_PREVIEW_MIME_TYPES.has(mimeType)) throw new Error('This attachment cannot be previewed.');
  const data = Buffer.from(attachment.file_data || []);
  if (!data.length || data.length > 10 * 1024 * 1024) throw new Error('The saved attachment is empty or exceeds the 10 MB preview limit.');
  return { name: attachment.original_name, mimeType, size: data.length,
    dataUrl: `data:${mimeType};base64,${data.toString('base64')}` };
});
ipcMain.handle('documents:export-invoice-attachment', async (event, invoiceType, invoiceId, attachmentId) => {
  getSession(event); const type = String(invoiceType || '').toUpperCase();
  if (!['SALE', 'PURCHASE'].includes(type)) throw new Error('Invalid invoice type.');
  const attachment = (await databasePromise).getInvoiceAttachment(type, Number(invoiceId), Number(attachmentId));
  if (!attachment) throw new Error('The invoice attachment was not found.');
  const owner = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(owner, { title: 'Save invoice attachment', defaultPath: attachment.original_name });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, Buffer.from(attachment.file_data));
  return { canceled: false, filePath: result.filePath };
});
ipcMain.handle('accounting:view-image-attachment', async (event, journalId, attachmentId) => {
  getSession(event);
  const attachment = (await databasePromise).getJournalAttachment(Number(journalId), Number(attachmentId));
  if (!attachment) throw new Error('The journal attachment was not found.');
  const mimeType = String(attachment.mime_type || '').toLowerCase();
  if (!SAFE_PREVIEW_MIME_TYPES.has(mimeType)) throw new Error('This attachment cannot be previewed.');
  const data = Buffer.from(attachment.file_data || []);
  if (!data.length || data.length > 10 * 1024 * 1024) throw new Error('The saved attachment is empty or exceeds the 10 MB preview limit.');
  return { name: attachment.original_name, mimeType, size: data.length,
    dataUrl: `data:${mimeType};base64,${data.toString('base64')}` };
});
ipcMain.handle('accounting:export-attachment', async (event, journalId, attachmentId) => {
  getSession(event); const attachment = (await databasePromise).getJournalAttachment(Number(journalId), Number(attachmentId));
  if (!attachment) throw new Error('The journal attachment was not found.');
  const owner = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(owner, { title: 'Export journal attachment', defaultPath: attachment.original_name });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, Buffer.from(attachment.file_data));
  return { canceled: false, filePath: result.filePath };
});
ipcMain.handle('accounting:journal', async (event, journalId) => {
  getSession(event);
  return (await databasePromise).getJournalDetails(Number(journalId));
});
ipcMain.handle('accounting:ledger', async (event, accountId) => {
  getSession(event);
  return (await databasePromise).getAccountLedger(Number(accountId));
});
ipcMain.handle('inventory:summary', async event => {
  const user = requireAnyCapability(event, ['stock_quantity_view', 'stock_cost_view', 'pricing_view', 'purchase_invoice_view']);
  const rows = (await databasePromise).getInventorySummary();
  if (user.role === ADMIN_ROLE || ['stock_cost_view', 'pricing_cost_view', 'sensitive_cost_reports_view'].some(cap => user.capabilities?.includes(cap))) return rows;
  return rows.map(({ movement_value_base, available_value_base, ...row }) => row);
});
ipcMain.handle('inventory:movements', async (event, productId) => {
  const user = requireAnyCapability(event, ['stock_quantity_view', 'stock_cost_view', 'pricing_view']);
  const rows = (await databasePromise).getInventoryMovements(Number(productId));
  if (user.role === ADMIN_ROLE || ['stock_cost_view', 'pricing_cost_view', 'sensitive_cost_reports_view'].some(cap => user.capabilities?.includes(cap))) return rows;
  return rows.map(({ unit_cost_base, total_cost_base, ...row }) => row);
});
ipcMain.handle('inventory:product-details', async (event, productId) => {
  const user = requireAnyCapability(event, ['stock_quantity_view', 'stock_cost_view', 'pricing_view']);
  const details = (await databasePromise).getProductDetails(Number(productId));
  if (!details || user.role === ADMIN_ROLE || ['stock_cost_view', 'pricing_cost_view', 'sensitive_cost_reports_view'].some(cap => user.capabilities?.includes(cap))) return details;
  const { manual_sales_price, default_markup_percent, ...product } = details.product;
  return { ...details, product,
    balances: details.balances.map(({ unit_cost_base, stock_value_base, ...row }) => row),
    movements: details.movements.map(({ unit_cost_base, total_cost_base, ...row }) => row),
    summary: { ...details.summary, total_value_base: undefined } };
});
ipcMain.handle('inventory:change-status', async (event, input) => {
  const user = requireAnyCapability(event, ['inventory_adjust', 'inventory_dispose']);
  return (await databasePromise).changeInventoryStatus(input || {}, user.id);
});
ipcMain.handle('inventory:adjust', async (event, input) => {
  const user = requireCapability(event, 'inventory_adjust');
  return (await databasePromise).adjustInventory(input || {}, user.id);
});
ipcMain.handle('inventory:transfer', async (event, input) => {
  const user = requireCapability(event, 'inventory_transfer');
  return (await databasePromise).transferInventory(input || {}, user.id);
});
ipcMain.handle('inventory:update-balance', async (event, input) => {
  const user = requireAdministrator(event);
  return (await databasePromise).updateInventoryBalanceMeta(input || {}, user.id);
});
ipcMain.handle('inventory:create-salvage', async (event, input) => {
  const user = requireCapability(event, 'inventory_dispose');
  return (await databasePromise).createInventorySalvage(input, user.id);
});
ipcMain.handle('reports:run', async (event, reportId, filters) => {
  const user = getSession(event); const id = String(reportId || '');
  const capability = id === 'operational_workflow' ? 'operational_reports_view' : 'financial_reports_view';
  if (user.role !== ADMIN_ROLE && !user.capabilities?.includes(capability)) throw new Error(`Permission required: ${capability.replaceAll('_', ' ')}.`);
  return (await databasePromise).getReport(String(reportId || ''), filters || {});
});
ipcMain.handle('reports:export-pdf', async (event, reportId, filters) => {
  const user = getSession(event); const id = String(reportId || '');
  const capability = id === 'operational_workflow' ? 'operational_reports_view' : 'financial_reports_view';
  if (user.role !== ADMIN_ROLE && !user.capabilities?.includes(capability)) throw new Error(`Permission required: ${capability.replaceAll('_', ' ')}.`);
  const database = await databasePromise;
  const report = database.getReport(String(reportId || ''), filters || {});
  const owner = BrowserWindow.fromWebContents(event.sender);
  const attachments = await selectPdfAttachments(owner);
  const safeName = String(report.id).replace(/[^a-z0-9_-]/gi, '-');
  const result = await dialog.showSaveDialog(owner, {
    title: `Export ${report.title}`, defaultPath: `${safeName}-${new Date().toISOString().slice(0, 10)}.pdf`,
    filters: [{ name: 'PDF document', extensions: ['pdf'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const branding = database.getBusinessBranding();
  await printHtmlPdf({ html: buildReportHtml(report, user, attachments, branding), filePath: result.filePath,
    landscape: report.orientation !== 'portrait', footerTemplate: buildFooterTemplate(report, branding) });
  return { canceled: false, filePath: result.filePath, attachmentCount: attachments.length };
});

ipcMain.handle('reports:purchase-register', async event => { getSession(event); return (await databasePromise).getPurchaseReport(); });
ipcMain.handle('reports:export-purchases-pdf', async event => {
  const user = getSession(event); const database = await databasePromise; const rows = database.getPurchaseReport();
  const owner = BrowserWindow.fromWebContents(event.sender); const attachments = await selectPdfAttachments(owner);
  const result = await dialog.showSaveDialog(owner, { title: 'Export Purchase Register',
    defaultPath: `purchase-register-${new Date().toISOString().slice(0, 10)}.pdf`, filters: [{ name: 'PDF document', extensions: ['pdf'] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  await printHtmlPdf({ html: purchaseReportHtml(rows, user, attachments, database.getBusinessBranding()), filePath: result.filePath, landscape: true });
  return { canceled: false, filePath: result.filePath, attachmentCount: attachments.length };
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function money(value) { return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function purchaseReportHtml(rows, user, attachments = [], branding = {}) {
  const body = rows.map(row => `<tr><td>${escapeHtml(row.invoice_code)}</td><td>${escapeHtml(row.invoice_date)}</td><td>${escapeHtml(row.supplier_name)}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.currency_code)}</td><td class="num">${money(row.goods_total)}</td><td class="num">${money(row.additional_cost_total)}</td><td class="num">${money(row.landed_total)}</td></tr>`).join('');
  const total = rows.reduce((sum, row) => sum + Number(row.landed_total || 0), 0);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Purchase Register</title><style>
    @page { size: A4 landscape; margin: 12mm 10mm; } * { box-sizing: border-box; } body { font: 12px Arial, sans-serif; color: #172033; }
    header { border-bottom: 2px solid #2457c5; margin-bottom: 18px; padding-bottom: 10px; } h1 { margin: 0 0 5px; font-size: 24px; } p { margin: 2px 0; color: #536078; }
    table { width: 100%; border-collapse: collapse; } thead { display: table-header-group; } th { background: #eaf0ff; text-align: left; } th, td { border: 1px solid #cdd6e6; padding: 7px; } .num { text-align: right; } tfoot { font-weight: bold; }
    footer { position: fixed; bottom: -5mm; left: 0; right: 0; color: #6b7280; font-size: 9px; text-align: right; }
    ${brandingStyles()}
    ${attachmentStyles(165)}
  </style></head><body><header>${buildBrandHeading(branding)}<p>Purchase Register</p><p>Generated ${escapeHtml(new Date().toLocaleString('en-GB'))} by ${escapeHtml(user.username)}</p></header>
  <table><thead><tr><th>Invoice</th><th>Date</th><th>Supplier</th><th>Status</th><th>Currency</th><th class="num">Goods</th><th class="num">Costs</th><th class="num">Landed total</th></tr></thead><tbody>${body || '<tr><td colspan="8">No purchase invoices found.</td></tr>'}</tbody><tfoot><tr><td colspan="7">Combined landed total (mixed currencies)</td><td class="num">${money(total)}</td></tr></tfoot></table><footer>Powered by Holool Tech - Holool.tech</footer>${buildAttachmentPages(attachments)}</body></html>`;
}

function getLanUrls(port) {
  const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, entries]) =>
    (entries || []).filter(entry => !entry.internal && (entry.family === 'IPv4' || entry.family === 4))
      .map(entry => ({ name, address: entry.address }))
  );
  addresses.sort((left, right) => {
    const isVirtual = name => /virtual|vmware|vbox|hyper-v|docker|wsl|vpn|loopback|bluetooth/i.test(name);
    return Number(isVirtual(left.name)) - Number(isVirtual(right.name));
  });
  return [...new Set(addresses.map(entry => `http://${entry.address}:${port}`))];
}

function getWebServerInfo() {
  return { port: webServerInfo.port, urls: getLanUrls(webServerInfo.port) };
}

ipcMain.handle('server:info', () => getWebServerInfo());

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders
  });
  response.end(body);
}

function getWebSession(request, response) {
  const cookie = String(request.headers.cookie || '');
  const match = cookie.match(/(?:^|;\s*)holool_session=([a-f0-9]{64})(?:;|$)/);
  if (match && webSessionIds.has(match[1])) return `web:${match[1]}`;
  const id = crypto.randomBytes(32).toString('hex');
  webSessionIds.add(id);
  response.setHeader('Set-Cookie', `holool_session=${id}; HttpOnly; SameSite=Strict; Path=/`);
  return `web:${id}`;
}

async function handleWebRpc(request, response) {
  if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed.' });
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    return sendJson(response, 415, { error: 'JSON content is required.' });
  }
  const origin = String(request.headers.origin || '');
  if (origin && origin !== `http://${request.headers.host}`) return sendJson(response, 403, { error: 'Invalid request origin.' });

  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) return sendJson(response, 413, { error: 'Request is too large.' });
    chunks.push(chunk);
  }

  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return sendJson(response, 400, { error: 'Invalid JSON request.' }); }
  const channel = String(input?.channel || '');
  const args = Array.isArray(input?.args) ? input.args : [];
  const handler = rpcHandlers.get(channel);
  if (!handler) return sendJson(response, 404, { error: 'Unknown application operation.' });
  if (HOST_ONLY_CHANNELS.has(channel)) {
    return sendJson(response, 501, { error: 'This file or PDF action is available only in the Electron application on the host computer.' });
  }

  try {
    const result = await handler({ sender: { id: getWebSession(request, response) } }, ...args);
    return sendJson(response, 200, { result: result === undefined ? null : result });
  } catch (error) {
    const message = String(error?.message || 'The application operation failed.');
    return sendJson(response, message === 'Authentication required.' ? 401 : 400, { error: message });
  }
}

function serveWebFile(request, response) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
  }
  const sourceRoot = path.resolve(__dirname, '..', 'src');
  let requestPath;
  try { requestPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
  catch { response.writeHead(400); response.end('Bad request'); return; }
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const isApplicationIcon = requestPath === '/icon.png';
  const filePath = isApplicationIcon ? path.resolve(__dirname, '..', 'icon.png') : path.resolve(sourceRoot, relativePath);
  if (!isApplicationIcon && filePath !== sourceRoot && !filePath.startsWith(`${sourceRoot}${path.sep}`)) {
    response.writeHead(403); response.end('Forbidden'); return;
  }
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) { response.writeHead(404); response.end('Not found'); return; }
    const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
    if (request.method === 'HEAD') { response.end(); return; }
    fs.createReadStream(filePath).pipe(response);
  });
}

function startWebServer() {
  const configuredPort = Number(process.env.HOLOOL_PORT || 3000);
  const port = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535 ? configuredPort : 3000;
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith('/api/invoke')) {
      handleWebRpc(request, response).catch(error => {
        console.error('Web request failed:', error);
        if (!response.headersSent) sendJson(response, 500, { error: 'The web request failed.' });
        else response.end();
      });
      return;
    }
    serveWebFile(request, response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      webServerInfo = { port, urls: getLanUrls(port) };
      console.log(`Holool ERP web access: ${webServerInfo.urls.join(', ') || `http://localhost:${port}`}`);
      resolve();
    });
  });
}
function createWindow(authorized) {
  const window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 680, autoHideMenuBar: true,
    backgroundColor: '#f4f7fb', title: 'Holool ERP Enterprise', icon: APP_ICON,
    webPreferences: { preload: path.join(__dirname, authorized ? 'preload.js' : 'license-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const webContentsId = window.webContents.id;
  window.on('closed', () => sessions.delete(webContentsId));
  window.loadFile(path.join(__dirname, '..', authorized ? 'src/index.html' : 'licensing/license.html'));
  return window;
}

let appServicesPromise = null;
function ensureAppServicesStarted() {
  if (!appServicesPromise) {
    appServicesPromise = (async () => {
      databasePromise = initializeDatabase({ isPackaged: app.isPackaged, userDataPath: app.getPath('userData') });
      await databasePromise;
      await startWebServer();
    })();
  }
  return appServicesPromise;
}

async function launchAuthorizedApplication(window) {
  await ensureAppServicesStarted();
  if (window && !window.isDestroyed()) {
    createWindow(true);
    window.destroy();
  }
}

function legacyStatus(status) {
  return {
    installationId: status.hardwareId,
    state: status.status === 'licensed' ? 'LICENSED' : status.status === 'trial' ? 'TRIAL' : 'EXPIRED',
    trialDaysLeft: status.trialDaysRemaining,
    reason: status.status === 'trial_expired' ? 'Your 7-day trial has ended. Activate the application to continue.' : undefined,
    license: status.status === 'licensed' ? { customer: status.customer, licenseId: status.licenseId } : undefined
  };
}

function registerLicensingIpc() {
  originalIpcHandle('license:status', () => licenseService.getLicenseStatus());
  originalIpcHandle('license:hardware-id', () => licenseService.getHardwareId());
  originalIpcHandle('license:start-trial', async event => {
    try {
      const status = await licenseService.startTrial();
      await launchAuthorizedApplication(BrowserWindow.fromWebContents(event.sender));
      return { success: true, status };
    } catch (error) { return { success: false, error: error.message }; }
  });
  originalIpcHandle('license:activate', async (event, licenseKey) => {
    try {
      const result = await licenseService.activateLicense(licenseKey);
      const status = await licenseService.getLicenseStatus();
      if (event.sender.getURL().includes('/licensing/license.html')) {
        await launchAuthorizedApplication(BrowserWindow.fromWebContents(event.sender));
      }
      return { ...result, ok: true, status: legacyStatus(status) };
    } catch (error) { return { success: false, ok: false, error: error.message }; }
  });
  originalIpcHandle('license:import-file', async event => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Import Holool ERP License', properties: ['openFile'],
      filters: [{ name: 'Holool ERP License', extensions: ['erplicense', 'txt'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const filePath = result.filePaths[0];
    if ((await fs.promises.stat(filePath)).size > 64 * 1024) return { canceled: false, error: 'Invalid license format.' };
    const licenseKey = (await fs.promises.readFile(filePath, 'utf8')).trim();
    return licenseKey.startsWith('ERP1.') ? { canceled: false, licenseKey } : { canceled: false, error: 'Invalid license format.' };
  });
  originalIpcHandle('license:copy-text', (_event, text) => clipboard.writeText(String(text || '')));
  originalIpcHandle('license:read-clipboard', () => clipboard.readText());
  ipcMain.on('license:exit', () => app.quit());

  originalIpcHandle('license:get-status', async () => legacyStatus(await licenseService.getLicenseStatus()));
  originalIpcHandle('license:quit', () => app.quit());
}

async function openForCurrentLicenseStatus() {
  const status = await licenseService.getLicenseStatus();
  if (status.status === 'licensed' || status.status === 'trial') {
    await launchAuthorizedApplication();
    createWindow(true);
  } else createWindow(false);
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.holool.app');
  licenseService = new LicenseService({ app, safeStorage, publicKeyPath: path.join(__dirname, '..', 'licensing', 'public-key.pem') });
  registerLicensingIpc();
  await openForCurrentLicenseStatus();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) openForCurrentLicenseStatus().catch(error => dialog.showErrorBox('Holool ERP Enterprise could not start', String(error?.message || error))); });
}).catch(error => { console.error('Application startup failed:', error); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
