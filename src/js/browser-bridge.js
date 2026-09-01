'use strict';

(function initializeBridge(root, factory) {
  const bridgeFactory = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = bridgeFactory;
  } else if (!root.appBridge) {
    root.appBridge = bridgeFactory.createAppBridge(async (channel, ...args) => {
      const response = await fetch('/api/invoke', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, args })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'The application request failed.');
      return payload.result;
    });
  }
})(globalThis, () => {
  const channels = Object.freeze({
    getServerInfo: 'server:info', login: 'auth:login', logout: 'auth:logout',
    listUsers: 'users:list', addUser: 'users:add', updateUser: 'users:update', deleteUser: 'users:delete',
    getDatabaseInfo: 'database:info', getApplicationLocale: 'settings:get-locale',
    saveApplicationLocale: 'settings:save-locale', getBusinessBranding: 'settings:get-branding',
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

  function createAppBridge(invoke) {
    return Object.freeze(Object.fromEntries(Object.entries(channels)
      .map(([name, channel]) => [name, (...args) => invoke(channel, ...args)])));
  }

  return { createAppBridge };
});
