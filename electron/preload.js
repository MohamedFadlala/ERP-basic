'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const channels = Object.freeze({
  getServerInfo: 'server:info', login: 'auth:login', logout: 'auth:logout',
  listUsers: 'users:list', addUser: 'users:add', updateUser: 'users:update', deleteUser: 'users:delete',
  getDatabaseInfo: 'database:info', getBusinessBranding: 'settings:get-branding',
  saveBusinessBranding: 'settings:save-branding', selectRecordImages: 'documents:select-images',
  releaseRecordImages: 'accounting:release-attachments', viewInvoiceImage: 'documents:view-invoice-image',
  exportInvoiceAttachment: 'documents:export-invoice-attachment', getPurchaseSetup: 'purchases:setup',
  getNextPurchaseCode: 'purchases:next-code', getNextPurchaseCostCode: 'purchases:next-cost-code',
  getNextPurchaseOrderNumber: 'purchase-orders:next-number', listPurchaseOrders: 'purchase-orders:list',
  getPurchaseOrder: 'purchase-orders:get', savePurchaseOrder: 'purchase-orders:save',
  setPurchaseOrderStatus: 'purchase-orders:set-status', decidePurchaseOrder: 'purchase-orders:approval', deletePurchaseOrder: 'purchase-orders:delete',
  exportPurchaseOrderPdf: 'purchase-orders:export-pdf', listPurchases: 'purchases:list',
  getPurchase: 'purchases:get', addPurchaseCost: 'purchases:add-cost', createPurchase: 'purchases:create',
  updatePurchase: 'purchases:update', deletePurchase: 'purchases:delete', addSupplier: 'suppliers:add',
  submitPurchaseInvoice: 'purchases:submit', listPurchaseFunding: 'funding:list', decidePurchaseFunding: 'funding:decide',
  listPurchaseDisbursements: 'disbursements:list', createPurchaseDisbursement: 'disbursements:create', exportDisbursementPdf: 'disbursements:export-pdf',
  executeSupplierPayment: 'funding:pay', listGoodsReceiptQueue: 'goods-receipts:list', confirmGoodsReceipt: 'goods-receipts:confirm',
  listPricing: 'pricing:list', publishPrice: 'pricing:publish',
  addProduct: 'products:add', updateProduct: 'products:update', printProductBarcode: 'products:print-barcode',
  listCategories: 'categories:list', saveCategory: 'categories:save', deleteCategory: 'categories:delete',
  getSalesSetup: 'sales:setup', listSales: 'sales:list', createSale: 'sales:create', getSale: 'sales:get',
  updateSale: 'sales:update', deleteSale: 'sales:delete', exportSalePdf: 'sales:export-pdf',
  listSalesReturns: 'returns:list', createSalesReturn: 'returns:create', decideSalesReturn: 'returns:decide', settleSalesReturn: 'returns:settle',
  exportPurchasePdf: 'purchases:export-pdf', addCustomer: 'customers:add', getHrData: 'hr:data',
  saveEmployee: 'hr:save-employee', deactivateEmployee: 'hr:deactivate-employee',
  saveSalaryGrade: 'hr:save-grade',
  saveAttendance: 'hr:save-attendance', deleteAttendance: 'hr:delete-attendance',
  saveLeaveBalance: 'hr:save-leave-balance', addLeaveEntry: 'hr:add-leave-entry',
  deleteLeaveEntry: 'hr:delete-leave-entry', createPayrollRun: 'hr:create-payroll',
  getPayrollRun: 'hr:get-payroll', savePayrollRun: 'hr:save-payroll', finalizePayrollRun: 'hr:finalize-payroll',
  decidePayrollRun: 'hr:decide-payroll',
  postPayrollRun: 'hr:post-payroll', getAccountingOverview: 'accounting:overview',
  saveAccount: 'accounting:save-account', getNextManualJournalNumber: 'accounting:next-manual-number',
  getNextVoucherNumber: 'accounting:next-voucher-number', createCashVoucher: 'accounting:create-voucher',
  selectJournalAttachments: 'accounting:select-attachments', releaseJournalAttachments: 'accounting:release-attachments',
  createManualJournal: 'accounting:create-manual-journal', updateManualJournal: 'accounting:update-manual-journal',
  deleteJournal: 'accounting:delete-journal', viewJournalImageAttachment: 'accounting:view-image-attachment',
  exportJournalAttachment: 'accounting:export-attachment', getJournalDetails: 'accounting:journal',
  getAccountLedger: 'accounting:ledger', getInventorySummary: 'inventory:summary',
  getInventoryMovements: 'inventory:movements', getProductInventoryDetails: 'inventory:product-details',
  changeInventoryStatus: 'inventory:change-status', adjustInventory: 'inventory:adjust',
  transferInventory: 'inventory:transfer', updateInventoryBalanceMeta: 'inventory:update-balance',
  createInventorySalvage: 'inventory:create-salvage', runReport: 'reports:run',
  exportReportPdf: 'reports:export-pdf', getPurchaseReport: 'reports:purchase-register',
  exportPurchaseReportPdf: 'reports:export-purchases-pdf',
  getLicenseStatus: 'license:get-status', activateLicense: 'license:activate', quitApp: 'license:quit'
});

const bridge = Object.fromEntries(Object.entries(channels)
  .map(([name, channel]) => [name, (...args) => ipcRenderer.invoke(channel, ...args)]));
contextBridge.exposeInMainWorld('appBridge', Object.freeze(bridge));

contextBridge.exposeInMainWorld('softwareLicense', Object.freeze({
  getStatus: () => ipcRenderer.invoke('license:status'),
  activate: licenseKey => ipcRenderer.invoke('license:activate', licenseKey),
  importFile: () => ipcRenderer.invoke('license:import-file'),
  copyText: text => ipcRenderer.invoke('license:copy-text', text),
  readClipboard: () => ipcRenderer.invoke('license:read-clipboard')
}));
