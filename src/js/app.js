'use strict';

const ADMIN_ROLE = 'System Administrator';
const SCREEN_LABELS = Object.freeze({ dashboard: 'Dashboard', sales: 'Sales', inventory: 'Inventory',
  treasury: 'Treasury', journalAccount: 'Journal Account', accounting: 'Accounting', hr: 'HR & Payroll', reports: 'Reports' });
function accessLevel(screen) {
  if (state.currentUser?.role === ADMIN_ROLE) return 'manage';
  return state.currentUser?.permissions?.[screen] || '';
}
function canViewScreen(screen) { return ['view', 'manage'].includes(accessLevel(screen)); }
function canManageScreen(screen) { return accessLevel(screen) === 'manage'; }
function hasCapability(capability) { return state.currentUser?.role === ADMIN_ROLE || state.currentUser?.capabilities?.includes(capability); }

const state = { hr: { employees: [], salaryComponents: [], salaryGrades: [], leaveTypes: [], leaveBalances: [], leaveEntries: [], attendance: [], payrollRuns: [], paymentMethods: [], workingDays: 30, activeRun: null }, users: [], currentUser: null, purchaseSetup: null, purchases: [], purchaseOrders: [], purchaseFunding: [], purchaseDisbursements: [], supplierTarget: 'purchaseSupplier', goodsReceiptQueue: [], pricing: [], salesReturns: [], activePurchase: null, editingPurchaseId: null, editingPurchaseOrderId: null, receivingPurchaseOrder: null, inventory: [], activeInventoryDetails: null, categories: [], salesSetup: null, sales: [], saleCart: [], editingSaleId: null, heldInvoices: { sale: [], purchase: [] }, nextHeldInvoiceId: 1, accounting: { accounts: [], customers: [], suppliers: [], currencies: [], paymentMethods: [], mappings: {}, journals: [] }, manualJournalAttachments: { token: null, files: [] }, editingJournalId: null,
  recordImages: { sale: { token: null, files: [] }, purchase: { token: null, files: [] }, receipt: { token: null, files: [] }, payment: { token: null, files: [] } },
  salesCategory: '', branding: { businessName: 'Holool ERP Enterprise', logoDataUrl: '', address: '', phone: '', secondaryPhone: '', email: '' }, brandingDraftLogo: null };
const byId = id => document.getElementById(id);
let dashboardRequest = 0;
let searchableSelectObserver;

function boot() {
  bindEvents();
  applyUserProfileDefaults();
  bindHrEvents();
  initializeSearchableSelects();
  byId('purchaseDate').value = new Date().toISOString().slice(0, 10);
  byId('purchaseOrderDate').value = new Date().toISOString().slice(0, 10);
  byId('salesDate').value = new Date().toISOString().slice(0, 10);
  byId('manualJournalDate').value = new Date().toISOString().slice(0, 10);
  byId('receiptVoucherDate').value = new Date().toISOString().slice(0, 10);
  byId('paymentVoucherDate').value = new Date().toISOString().slice(0, 10);
  byId('reportToDate').value = new Date().toISOString().slice(0, 10);
  byId('reportFromDate').value = `${new Date().getFullYear()}-01-01`;
  const today = new Date().toISOString().slice(0, 10);
  byId('dashboardFromDate').value = `${today.slice(0, 7)}-01`;
  byId('dashboardToDate').value = today;
  renderTodayChip();
  renderNetworkUrl();
  byId('loginPassword').focus();
}

function renderTodayChip() { byId('todayChip').textContent = window.i18n.formatDate(new Date(), { day: '2-digit', month: 'short', year: 'numeric' }); }

async function renderNetworkUrl() {
  const badge = byId('networkUrl');
  try {
    const info = await window.appBridge.getServerInfo();
    const urls = Array.isArray(info?.urls) ? info.urls : [];
    const url = urls[0] || (info?.port ? `http://localhost:${info.port}` : '');
    if (!url) return;
    badge.textContent = `LAN: ${url}`;
    badge.title = urls.join('\n') || url;
    badge.hidden = false;
  } catch { badge.hidden = true; }
}

function applySelectSearch(select, input) {
  const query = input.value.trim().toLowerCase();
  [...select.options].forEach(option => {
    const matches = !query || option.textContent.toLowerCase().includes(query);
    option.hidden = Boolean(query) && !matches && !option.selected;
  });
}
function syncSearchableSelect(select, wrapper, input) {
  wrapper.hidden = select.hidden; input.disabled = select.disabled;
}
/*function enhanceSearchableSelect(select) {
  if (!(select instanceof HTMLSelectElement) || select.dataset.searchableEnhanced === 'true') return;
  select.dataset.searchableEnhanced = 'true';
  const wrapper = document.createElement('div'); wrapper.className = 'searchable-select';
  const input = document.createElement('input'); input.type = 'search'; input.className = 'select-search';
  input.placeholder = 'Search options...'; input.autocomplete = 'off';
  input.setAttribute('aria-label', `Search ${select.getAttribute('aria-label') || select.id || 'dropdown'} options`);
  select.parentNode.insertBefore(wrapper, select); wrapper.append(input, select);
  input.addEventListener('input', () => applySelectSearch(select, input));
  input.addEventListener('keydown', event => {
    if (!['Enter', 'ArrowDown'].includes(event.key)) return;
    const first = [...select.options].find(option => !option.hidden && !option.disabled && option.value);
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!first) return;
      if (select.multiple) first.selected = true; else select.value = first.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      input.value = ''; applySelectSearch(select, input);
    } else if (event.key === 'ArrowDown') { event.preventDefault(); select.focus(); }
  });
  select.addEventListener('change', () => { input.value = ''; applySelectSearch(select, input); });
  new MutationObserver(records => {
    // Filtering toggles `hidden` on options. Do not run the filter again for
    // those mutations or large account lists can create a self-triggering loop.
    if (records.some(record => record.type === 'childList')) applySelectSearch(select, input);
    if (records.some(record => record.type === 'childList' || record.target === select)) {
      syncSearchableSelect(select, wrapper, input);
    }
  }).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled'] });
  syncSearchableSelect(select, wrapper, input);
}*/
function initializeSearchableSelects() {}

function bindEvents() {
  byId('loginForm').addEventListener('submit', handleLogin);
  byId('logoutButton').addEventListener('click', logout);
  byId('refreshDashboard').addEventListener('click', renderDashboard);
  byId('userForm').addEventListener('submit', addUser);
  byId('newUserRole').addEventListener('change', updatePermissionEditor);
  byId('newUserProfile').addEventListener('change', applyUserProfileDefaults);
  byId('cancelUserEdit').addEventListener('click', resetUserEditor);
  byId('brandingSettingsForm').addEventListener('submit', saveBusinessBranding);
  byId('businessLogo').addEventListener('change', selectBusinessLogo);
  byId('removeBusinessLogo').addEventListener('click', removeBusinessLogo);
  byId('navigation').addEventListener('click', event => {
    const button = event.target.closest('button[data-page]'); if (!button) return;
    openPage(button.dataset.page);
    if (button.dataset.inventoryView) showInventoryView(button.dataset.inventoryView);
    if (button.dataset.inventoryView === 'orders') { byId('purchaseOrderStatusFilter').value = button.dataset.poStatus || ''; renderPurchaseOrders(); }
    if (button.dataset.salesView) showSalesView(button.dataset.salesView);
    if (button.dataset.hrView) showHrView(button.dataset.hrView);
  });
  document.addEventListener('click', event => {
    const go = event.target.closest('[data-go-page]'); if (go) { openPage(go.dataset.goPage); if (go.dataset.inventoryView) showInventoryView(go.dataset.inventoryView); }
    const opener = event.target.closest('[data-open-dialog]');
    if (opener) {
      const requiredCapability = opener.dataset.requiresCapability;
      if (!requiredCapability || hasCapability(requiredCapability)) {
        if (opener.dataset.openDialog === 'supplierDialog') state.supplierTarget = opener.dataset.supplierTarget || 'purchaseSupplier';
        byId(opener.dataset.openDialog).showModal();
      }
    }
    const closer = event.target.closest('.close-dialog'); if (closer) closer.closest('dialog').close();
  });
  byId('usersTableBody').addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-user]'); if (edit) { editUser(edit.dataset.editUser); return; }
    const remove = event.target.closest('[data-delete-user]'); if (remove) deleteUser(remove.dataset.deleteUser);
  });
  document.querySelector('.inventory-page-tabs').addEventListener('click', event => { const button = event.target.closest('[data-inventory-view]'); if (button) showInventoryView(button.dataset.inventoryView); });
  byId('newPurchaseOrder').addEventListener('click', () => openPurchaseOrderEditor());
  byId('cancelPurchaseOrderEdit').addEventListener('click', closePurchaseOrderEditor);
  byId('purchaseOrderForm').addEventListener('submit', savePurchaseOrder);
  byId('addPurchaseOrderLine').addEventListener('click', () => addPurchaseOrderLine());
  byId('purchaseOrderLines').addEventListener('input', renderPurchaseOrderTotal);
  byId('purchaseOrderLines').addEventListener('change', handlePurchaseOrderLineChange);
  byId('purchaseOrderLines').addEventListener('click', event => { const button = event.target.closest('.remove-row'); if (button) { button.closest('tr').remove(); renderPurchaseOrderTotal(); } });
  byId('purchaseOrderSearch').addEventListener('input', renderPurchaseOrders);
  byId('purchaseOrderStatusFilter').addEventListener('change', renderPurchaseOrders);
  byId('purchaseOrderCurrency').addEventListener('change', handlePurchaseOrderCurrency);
  byId('purchaseOrderDate').addEventListener('change', refreshPurchaseOrderNumber);
  byId('purchaseOrderBody').addEventListener('click', handlePurchaseOrderAction);
  byId('purchaseOrderDecisionForm').addEventListener('submit', savePurchaseOrderDecision);
  byId('addProductLine').addEventListener('click', () => addProductLine());
  byId('addCostLine').addEventListener('click', addCostLine);
  byId('purchaseLines').addEventListener('input', updatePurchasePreview);
  byId('purchaseLines').addEventListener('change', handleProductLineChange);
  byId('purchaseLines').addEventListener('click', removeLine);
  byId('costLines').addEventListener('input', updatePurchasePreview);
  byId('costLines').addEventListener('click', removeLine);
  byId('purchaseCurrency').addEventListener('change', handlePurchaseCurrency);
  byId('purchaseDate').addEventListener('change', refreshPurchaseCode);
  byId('purchaseRate').addEventListener('input', updatePurchasePreview);
  byId('purchaseForm').addEventListener('submit', savePurchase);
  byId('resetPurchase').addEventListener('click', () => resetPurchaseForm());
  byId('holdPurchase').addEventListener('click', () => holdPurchase());
  byId('heldPurchasesList').addEventListener('click', event => handleHeldInvoiceAction('purchase', event));
  byId('selectPurchaseImages').addEventListener('click', () => selectRecordImages('purchase'));
  byId('clearPurchaseImages').addEventListener('click', () => clearRecordImages('purchase'));
  byId('supplierForm').addEventListener('submit', addSupplier);
  byId('productForm').addEventListener('submit', addProduct);
  byId('refreshPurchases').addEventListener('click', loadPurchases);
  byId('refreshStockReceipts').addEventListener('click', loadGoodsReceiptQueue);
  byId('stockReceiptBody').addEventListener('click', handleGoodsReceiptAction);
  byId('goodsReceiptForm').addEventListener('submit', submitGoodsReceipt);
  byId('refreshFunding').addEventListener('click', loadPurchaseFunding);
  byId('fundingBody').addEventListener('click', handleFundingAction);
  byId('fundingDecisionForm').addEventListener('submit', submitFundingDecision);
  byId('disbursementOrderForm').addEventListener('submit', submitDisbursementOrder);
  byId('fundingPaymentForm').addEventListener('submit', submitFundingPayment);
  byId('disbursementBody').addEventListener('click', handleDisbursementAction);
  byId('refreshPricing').addEventListener('click', loadPricing);
  byId('pricingBody').addEventListener('click', handlePricingAction);
  byId('pricingPublishMethod').addEventListener('change', updatePricingDialogFields);
  byId('pricingPublishForm').addEventListener('submit', submitPublishedPrice);
  byId('purchaseSearch').addEventListener('input', renderPurchases);
  byId('purchaseHistoryBody').addEventListener('click', event => {
    const editButton = event.target.closest('[data-edit-purchase]'); if (editButton) editPurchase(Number(editButton.dataset.editPurchase));
    const deleteButton = event.target.closest('[data-delete-purchase]'); if (deleteButton) deletePurchase(Number(deleteButton.dataset.deletePurchase));
    const costButton = event.target.closest('[data-add-purchase-cost]'); if (costButton) openPurchaseCostDialog(Number(costButton.dataset.addPurchaseCost));
    const imagesButton = event.target.closest('[data-view-invoice-images]'); if (imagesButton) openInvoiceImages('PURCHASE', Number(imagesButton.dataset.viewInvoiceImages));
    const pdfButton = event.target.closest('[data-export-purchase-pdf]'); if (pdfButton) exportInvoicePdf('purchase', Number(pdfButton.dataset.exportPurchasePdf), pdfButton);
    const submitButton = event.target.closest('[data-submit-purchase]'); if (submitButton) submitPurchaseInvoice(Number(submitButton.dataset.submitPurchase));
  });
  byId('purchaseCostForm').addEventListener('submit', savePurchaseCost);
  byId('purchaseCostDate').addEventListener('change', refreshPurchaseCostCode);
  byId('purchaseCostCurrency').addEventListener('change', updatePurchaseCostRate);
  byId('reportCatalogue').addEventListener('click', event => { const card = event.target.closest('[data-report-id]'); if (card) selectReport(card.dataset.reportId); });
  byId('openInventoryValuationReport').addEventListener('click', () => selectReport('inventory_valuation'));
  byId('runActiveReport').addEventListener('click', runActiveReport);
  byId('exportActiveReportPdf').addEventListener('click', exportActiveReportPdf);
  byId('reportAccountPartyType').addEventListener('change', updateReportStatementParties);
  byId('clearAccountStatementFilters').addEventListener('click', clearAccountStatementFilters);
  byId('inventorySearch').addEventListener('input', renderInventory);
  byId('inventoryWarehouse').addEventListener('change', renderInventory);
  byId('refreshInventory').addEventListener('click', loadInventory);
  byId('manageCategories').addEventListener('click', openCategoryManager);
  byId('inventoryTableBody').addEventListener('click', event => {
    const row = event.target.closest('[data-product-id]'); if (row) showInventoryProduct(Number(row.dataset.productId));
  });
  byId('inventoryBalanceBody').addEventListener('click', handleInventoryBalanceAction);
  byId('inventoryStatusAction').addEventListener('change', () => { byId('inventorySalvageValueLabel').hidden = byId('inventoryStatusAction').value !== 'MOVE_TO_SALVAGE'; });
  byId('inventoryStatusForm').addEventListener('submit', saveInventoryStatus);
  byId('inventoryAdjustForm').addEventListener('submit', saveInventoryAdjustment);
  byId('inventoryEditForm').addEventListener('submit', saveInventoryRowEdit);
  byId('inventoryTransferForm').addEventListener('submit', saveInventoryTransfer);
  byId('inventoryProductForm').addEventListener('submit', saveInventoryProduct);
  byId('printInventoryBarcode').addEventListener('click', printInventoryBarcode);
  byId('barcodePrintForm').addEventListener('submit', saveInventoryBarcodePdf);
  byId('editInventoryProduct').addEventListener('click', openInventoryProductEditor);
  byId('addInventoryAdjustment').addEventListener('click', openInventoryAdjustment);
  byId('categoryForm').addEventListener('submit', saveInventoryCategory);
  byId('categoryTableBody').addEventListener('click', handleCategoryAction);
  byId('cancelCategoryEdit').addEventListener('click', resetCategoryForm);
  byId('closeInventoryDetail').addEventListener('click', () => { byId('inventoryDetail').hidden = true; state.activeInventoryDetails = null; });
  document.querySelector('[data-sales-view="checkout"]').parentElement.addEventListener('click', event => { const button = event.target.closest('[data-sales-view]'); if (button) showSalesView(button.dataset.salesView); });
  byId('salesProductSearch').addEventListener('input', renderSalesCatalog);
  byId('salesCategoryFilters').addEventListener('click', event => { const button = event.target.closest('[data-sales-category]'); if (button) { state.salesCategory = button.dataset.salesCategory; renderSalesCatalog(); } });
  byId('salesProductSearch').addEventListener('keydown', scanSalesBarcode);
  byId('salesWarehouse').addEventListener('change', renderSalesCatalog);
  byId('salesCurrency').addEventListener('change', handleSalesCurrency);
  byId('salesRate').addEventListener('input', renderSalesCart);
  byId('salesPayment').addEventListener('change', updateSalesPostingPreview);
  byId('salesCustomer').addEventListener('change', () => {
    const customer = state.salesSetup?.customers.find(item => String(item.id) === byId('salesCustomer').value);
    byId('salesMessage').textContent = customer ? `${customer.name} is selected as the invoice customer.` : 'Walk-in customer is selected.';
  });
  byId('salesProductBody').addEventListener('click', event => { const button = event.target.closest('[data-add-sale-product]'); if (button) addSaleProduct(Number(button.dataset.addSaleProduct)); });
  byId('salesCartBody').addEventListener('input', updateSaleCartValue);
  byId('salesCartBody').addEventListener('change', validateChangedSalePrice);
  byId('salesCartBody').addEventListener('click', removeSaleCartItem);
  byId('clearSalesCart').addEventListener('click', () => { state.saleCart = []; renderSalesCart(); });
  byId('resetSale').addEventListener('click', () => resetSalesForm());
  byId('holdSale').addEventListener('click', () => holdSale());
  byId('heldSalesList').addEventListener('click', event => handleHeldInvoiceAction('sale', event));
  byId('salesForm').addEventListener('submit', saveSale);
  byId('selectSalesImages').addEventListener('click', () => selectRecordImages('sale'));
  byId('clearSalesImages').addEventListener('click', () => clearRecordImages('sale'));
  byId('refreshSales').addEventListener('click', loadSales);
  byId('refreshReturns').addEventListener('click', loadSalesReturns);
  byId('salesReturnBody').addEventListener('click', handleSalesReturnAction);
  byId('salesReturnCreateForm').addEventListener('submit', submitSalesReturn);
  byId('salesReturnActionForm').addEventListener('submit', submitSalesReturnAction);
  byId('salesHistoryBody').addEventListener('click', event => {
    const pdf = event.target.closest('[data-export-sale-pdf]'); if (pdf) exportInvoicePdf('sale', Number(pdf.dataset.exportSalePdf), pdf);
    const edit = event.target.closest('[data-edit-sale]'); if (edit) editSale(Number(edit.dataset.editSale));
    const remove = event.target.closest('[data-delete-sale]'); if (remove) deleteSale(Number(remove.dataset.deleteSale));
    const images = event.target.closest('[data-view-invoice-images]'); if (images) openInvoiceImages('SALE', Number(images.dataset.viewInvoiceImages));
    const createReturn = event.target.closest('[data-create-return]'); if (createReturn) createSalesReturn(Number(createReturn.dataset.createReturn));
  });
  byId('customerForm').addEventListener('submit', addCustomer);  byId('accountSearch').addEventListener('input', renderAccounts);
  byId('treasury').addEventListener('click', event => { const button = event.target.closest('[data-open-treasury-voucher]'); if (button) openTreasuryVoucher(button.dataset.openTreasuryVoucher); });
  byId('accountTypeFilter').addEventListener('change', renderAccounts);
  byId('refreshAccounting').addEventListener('click', loadAccounting);
  byId('newAccount').addEventListener('click', () => openAccountDialog());
  byId('accountForm').addEventListener('submit', saveAccount);
  byId('accountsTableBody').addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-account]'); if (edit) { event.stopPropagation(); openAccountDialog(Number(edit.dataset.editAccount)); return; }
    const row = event.target.closest('[data-account-id]'); if (row) showAccountLedger(Number(row.dataset.accountId));
  });
  byId('accountLedgerBody').addEventListener('click', event => { const row = event.target.closest('[data-journal-id]'); if (row) { openPage('journalAccount'); showJournalDetails(Number(row.dataset.journalId)); } });
  byId('closeAccountLedger').addEventListener('click', () => { byId('accountLedgerPanel').hidden = true; });
  byId('journalSearch').addEventListener('input', renderJournals);
  byId('journalSourceFilter').addEventListener('change', renderJournals);
  byId('journalStatusFilter').addEventListener('change', renderJournals);
  byId('journalTableBody').addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-journal]'); if (edit) { event.stopPropagation(); editJournal(Number(edit.dataset.editJournal)); return; }
    const remove = event.target.closest('[data-delete-journal]'); if (remove) { event.stopPropagation(); deleteJournal(Number(remove.dataset.deleteJournal)); return; }
    const row = event.target.closest('[data-journal-id]'); if (row) showJournalDetails(Number(row.dataset.journalId));
  });
  byId('closeJournalDetail').addEventListener('click', () => { byId('journalDetailPanel').hidden = true; });
  byId('journalOpenSource').addEventListener('click', openJournalSource);
  byId('manualJournalDate').addEventListener('change', () => { refreshManualJournalNumber(); updateManualJournalTotals(); });
  byId('manualJournalDescription').addEventListener('input', updateManualJournalTotals);
  byId('manualJournalLines').addEventListener('input', handleManualJournalLineInput);
  byId('manualJournalLines').addEventListener('change', handleManualJournalAccountChange);
  byId('manualJournalLines').addEventListener('click', removeManualJournalLine);
  byId('addManualJournalLine').addEventListener('click', () => addManualJournalLine());
  byId('selectJournalAttachments').addEventListener('click', selectManualJournalAttachments);
  byId('clearJournalAttachments').addEventListener('click', clearManualJournalAttachments);
  byId('resetManualJournal').addEventListener('click', resetManualJournalForm);
  byId('manualJournalForm').addEventListener('submit', saveManualJournal);
  document.querySelector('.journal-tabs').addEventListener('click', event => { const button = event.target.closest('[data-journal-view]'); if (button) showJournalView(button.dataset.journalView); });
  ['receipt', 'payment'].forEach(type => {
    byId(`${type}VoucherForm`).addEventListener('submit', event => saveCashVoucher(event, type));
    byId(`select${type[0].toUpperCase() + type.slice(1)}Images`).addEventListener('click', () => selectRecordImages(type));
    byId(`clear${type[0].toUpperCase() + type.slice(1)}Images`).addEventListener('click', () => clearRecordImages(type));
    byId(`reset${type[0].toUpperCase() + type.slice(1)}Voucher`).addEventListener('click', () => resetCashVoucher(type));
    byId(`${type}VoucherDate`).addEventListener('change', () => refreshCashVoucherNumber(type));
    byId(`${type}VoucherCurrency`).addEventListener('change', () => { updateCashVoucherCurrency(type); updateCashVoucherPreview(type); });
    byId(`${type}VoucherMethod`).addEventListener('change', () => { updateCashVoucherBankFee(type); updateCashVoucherPreview(type); });
    byId(`${type}VoucherAccount`).addEventListener('change', () => { updateCashVoucherParty(type); updateCashVoucherBankFee(type); updateCashVoucherPreview(type); });
    byId(`${type}VoucherRate`).addEventListener('input', () => updateCashVoucherPreview(type));
    byId(`${type}VoucherAmount`).addEventListener('input', () => updateCashVoucherPreview(type));
  });
  byId('paymentVoucherBankFee').addEventListener('input', () => updateCashVoucherPreview('payment'));
  byId('accountBank').addEventListener('change', updateAccountBankFeeSelector);
  byId('journalAttachmentList').addEventListener('click', viewJournalImageAttachment);
  byId('journalAttachmentList').addEventListener('click', exportJournalAttachment);
  byId('invoiceAttachmentList').addEventListener('click', viewInvoiceImage);
  byId('invoiceAttachmentList').addEventListener('click', exportInvoiceAttachment);
  byId('journalImageDialog').addEventListener('close', () => {
    byId('journalImagePreview').removeAttribute('src'); byId('journalPdfPreview').removeAttribute('src');
  });
}

async function handleLogin(event) {
  event.preventDefault();
  try {
    const user = await window.appBridge.login({ username: byId('loginUsername').value.trim(), password: byId('loginPassword').value });
    if (!user) { byId('loginError').textContent = 'Incorrect username or password.'; return; }
    state.currentUser = user;
    // Migrate the administrator's local preference from older releases once;
    // afterwards every Electron and LAN client reads the shared database value.
    await window.i18n.synchronizeLocale({ migrateLocalPreference: user.role === ADMIN_ROLE });
    byId('loginError').textContent = '';
    byId('loginScreen').hidden = true;
    byId('appShell').hidden = false;
    byId('currentUser').textContent = `${user.username} - ${user.job_profile || user.role}`;
    const firstPage = applyUserAccess();
    const loads = [renderUsers(), loadBusinessBranding()];
    if (state.currentUser.role === ADMIN_ROLE || canViewScreen('accounting') || canViewScreen('treasury') || canViewScreen('journalAccount') || hasCapability('financial_reports_view')) loads.push(loadAccounting());
    if (canViewScreen('inventory') && ['product_create','purchase_order_view','purchase_order_create','purchase_order_commercial_approve','purchase_order_commercial_reject','purchase_order_finance_approve','purchase_order_finance_reject','purchase_order_accounting_view','purchase_invoice_view','purchase_invoice_create','purchase_funding_view','purchase_disbursement_view'].some(hasCapability)) loads.push(loadPurchaseSetup());
    if (canViewScreen('inventory') && ['purchase_invoice_view','purchase_invoice_create','purchase_funding_view'].some(hasCapability)) loads.push(loadPurchases());
    if (canViewScreen('inventory') && ['purchase_order_view','purchase_order_create','purchase_order_commercial_approve','purchase_order_commercial_reject','purchase_order_finance_approve','purchase_order_finance_reject','purchase_order_accounting_view'].some(hasCapability)) loads.push(loadPurchaseOrders());
    if (canViewScreen('inventory') && ['stock_quantity_view','stock_cost_view','pricing_view','purchase_invoice_view'].some(hasCapability)) loads.push(loadInventory());
    if (canViewScreen('sales') && ['sale_create','sale_view_own','sale_view_all','sales_return_create'].some(hasCapability)) loads.push(loadSalesSetup(), loadSales());
    if (canViewScreen('hr')) loads.push(loadHr());
    await Promise.all(loads);
    openPage(firstPage);
    if (firstPage === 'dashboard') await renderDashboard();
  } catch (error) { byId('loginError').textContent = readableError(error, 'Unable to sign in.'); }
}

async function logout() {
  await window.appBridge.logout();
  state.currentUser = null; state.users = []; state.branding = { businessName: 'Holool ERP Enterprise', logoDataUrl: '', address: '', phone: '', secondaryPhone: '', email: '' }; state.brandingDraftLogo = null; state.purchaseSetup = null; state.purchases = []; state.purchaseOrders = []; state.purchaseFunding = []; state.purchaseDisbursements = []; state.goodsReceiptQueue = []; state.pricing = []; state.salesReturns = []; state.editingPurchaseId = null; state.editingPurchaseOrderId = null; state.receivingPurchaseOrder = null; state.hr.activeRun = null;
  state.heldInvoices = { sale: [], purchase: [] }; state.nextHeldInvoiceId = 1;
  ['sale', 'purchase', 'receipt', 'payment'].forEach(type => { state.recordImages[type] = { token: null, files: [] }; renderRecordImages(type); });
  renderHeldInvoices('sale'); renderHeldInvoices('purchase');
  byId('appShell').hidden = true; byId('loginScreen').hidden = false; byId('loginPassword').value = ''; byId('loginPassword').focus();
}

function applyUserAccess() {
  const isAdmin = state.currentUser?.role === ADMIN_ROLE;
  const allowed = Object.keys(SCREEN_LABELS).filter(canViewScreen);
  document.querySelectorAll('#navigation button[data-page]').forEach(button => {
    const screen = button.dataset.page;
    button.hidden = screen === 'settings' ? !isAdmin : !canViewScreen(screen);
  });
  const hrGroup = document.querySelector('#navigation .nav-group');
  if (hrGroup) hrGroup.hidden = !canViewScreen('hr');
  document.querySelectorAll('[data-hr-view="employees"], [data-hr-view="attendance"]').forEach(element => { element.hidden = !hasCapability('employee_manage'); });
  document.querySelectorAll('[data-hr-view="payroll"]').forEach(element => { element.hidden = !['payroll_prepare','payroll_submit','payroll_approve','payroll_payment_execute'].some(hasCapability); });
  byId('addEmployee').hidden = !hasCapability('employee_manage'); byId('addSalaryGrade').hidden = !hasCapability('employee_manage');
  byId('newPurchaseOrder').hidden = !hasCapability('purchase_order_create');
  const setInventoryNavVisibility = (view, hidden) => document.querySelectorAll(`.inventory-page-tabs [data-inventory-view="${view}"]`).forEach(element => { element.hidden = hidden; });
  setInventoryNavVisibility('stock', !['product_create','stock_quantity_view','stock_cost_view','pricing_view','purchase_invoice_view'].some(hasCapability));
  setInventoryNavVisibility('orders', !['purchase_order_view','purchase_order_create','purchase_order_commercial_approve','purchase_order_commercial_reject','purchase_order_finance_approve','purchase_order_finance_reject','purchase_order_accounting_view'].some(hasCapability));
  setInventoryNavVisibility('direct', true);
  setInventoryNavVisibility('history', !['purchase_invoice_view','purchase_invoice_create','purchase_funding_view'].some(hasCapability));
  setInventoryNavVisibility('funding', !['purchase_funding_view','purchase_disbursement_view'].some(hasCapability));
  setInventoryNavVisibility('receipts', !hasCapability('goods_receipt_view'));
  setInventoryNavVisibility('pricing', !hasCapability('pricing_view'));
  document.querySelectorAll('[data-requires-any]').forEach(element => { element.hidden = !element.dataset.requiresAny.split(',').some(hasCapability); });
  document.querySelector('[data-sales-view="checkout"]').hidden = !hasCapability('sale_create');
  document.querySelector('[data-sales-view="returns"]').hidden = !['sales_return_create','sales_return_approve','purchase_funding_approve','sales_return_settle','sale_view_all'].some(hasCapability);
  document.querySelectorAll('[data-requires-capability]').forEach(element => { element.hidden = !hasCapability(element.dataset.requiresCapability); });
  document.querySelectorAll('[data-report-id]').forEach(card => { const operational = card.dataset.reportId === 'operational_workflow'; card.hidden = operational ? !hasCapability('operational_reports_view') : !hasCapability('financial_reports_view'); });
  const dashboardAccess = {
    financial: hasCapability('financial_reports_view'),
    cost: hasCapability('sensitive_cost_reports_view'),
    sales: ['sale_view_own', 'sale_view_all'].some(hasCapability),
    purchases: ['purchase_invoice_view', 'purchase_funding_view'].some(hasCapability),
    stock: ['stock_quantity_view', 'goods_receipt_view'].some(hasCapability)
  };
  document.querySelectorAll('[data-dashboard-scope]').forEach(element => { element.hidden = !dashboardAccess[element.dataset.dashboardScope]; });
  byId('openInventoryValuationReport').hidden = !hasCapability('sensitive_cost_reports_view');
  document.querySelectorAll('.dashboard-quick-actions [data-go-page]').forEach(element => {
    if (!element.dataset.requiresCapability) element.hidden = !canViewScreen(element.dataset.goPage);
  });
  document.querySelector('[data-journal-view="manual"]').hidden = !canViewScreen('journalAccount');
  document.querySelector('[data-journal-view="history"]').hidden = !canViewScreen('journalAccount');
  document.querySelector('[data-journal-view="receipt"]').hidden = !canViewScreen('journalAccount') && !hasCapability('treasury_receipt_post');
  document.querySelector('[data-journal-view="payment"]').hidden = !canViewScreen('journalAccount') && !hasCapability('treasury_payment_post');
  return isAdmin ? 'dashboard' : allowed[0];
}

function openPage(pageId) {
  const authorized = pageId === 'settings' ? state.currentUser?.role === ADMIN_ROLE : canViewScreen(pageId);
  if (!authorized) return;

  document.querySelectorAll('.page').forEach(page => { page.hidden = page.id !== pageId; });
  document.querySelectorAll('#navigation > button, #navigation > .nav-group > button').forEach(button => button.classList.toggle('active', button.dataset.page === pageId));
  const copy = {
    dashboard: ['Dashboard', 'A clear view of your business.'], sales: ['Sales', 'Point of sale and customer invoices.'],
    inventory: ['Inventory', 'Stock, purchase orders, invoices and stock posting.'], treasury: ['Treasury', 'Cash, bank, receipt and payment voucher operations.'], journalAccount: ['Journal Account', 'Create balanced manual entries and review the journal audit trail.'], accounting: ['Accounting', 'Chart of accounts, balances and account ledgers.'], hr: ['HR & Payroll', 'Employees, attendance, leave, and monthly payroll.'], reports: ['Reports', 'Review and export business information.'],
    settings: ['Settings', 'Users, permissions and application configuration.']
  }[pageId];
  if (copy) { byId('pageTitle').textContent = copy[0]; byId('pageSubtitle').textContent = copy[1]; }
  document.querySelectorAll('.page-access-note').forEach(note => note.remove());
  if (SCREEN_LABELS[pageId] && !canManageScreen(pageId)) {
    const note = document.createElement('p');
    note.className = 'notice page-access-note';
    note.textContent = 'View-only access: changes to this screen are not permitted.';
    byId(pageId).prepend(note);
  }
  if (pageId === 'dashboard' && state.currentUser && state.accounting.accounts.length) renderDashboard();
  if (pageId === 'treasury') renderTreasury();
  if (pageId === 'sales') setTimeout(() => byId('salesProductSearch').focus(), 0);
  if (pageId === 'hr') {
    const current = document.querySelector('.hr-tabs [data-hr-view].active:not([hidden])'); const first = document.querySelector('.hr-tabs [data-hr-view]:not([hidden])');
    if (!current && first) showHrView(first.dataset.hrView);
  }
  if (pageId === 'inventory') {
    const active = document.querySelector('[data-inventory-view].active:not([hidden])');
    const first = document.querySelector('[data-inventory-view]:not([hidden])');
    if (!active && first) showInventoryView(first.dataset.inventoryView);
  }
}

function renderTreasury() {
  const cash = Number(state.accounting.accounts.find(account => account.code === '1110')?.balance || 0);
  byId('treasuryCashBalance').textContent = `${formatMoney(cash)} SDG`;
  const rows = state.accounting.journals.filter(row => ['RECEIPT', 'PAYMENT'].includes(row.source_type)).slice(0, 20);
  byId('treasuryReceiptCount').textContent = state.accounting.journals.filter(row => row.source_type === 'RECEIPT').length;
  byId('treasuryPaymentCount').textContent = state.accounting.journals.filter(row => row.source_type === 'PAYMENT').length;
  byId('treasuryVoucherBody').innerHTML = rows.map(row => `<tr><td><strong>${escapeHtml(row.entry_number)}</strong></td><td>${escapeHtml(row.entry_date)}</td><td>${escapeHtml(row.description)}</td><td><span class="source-pill">${escapeHtml(row.source_type)}</span></td><td class="number">${formatMoney(row.total_debit)}</td><td class="number">${formatMoney(row.total_credit)}</td></tr>`).join('');
  byId('treasuryVoucherEmpty').hidden = rows.length > 0;
  const receiptButton = byId('treasury').querySelector('[data-open-treasury-voucher="receipt"]');
  const paymentButton = byId('treasury').querySelector('[data-open-treasury-voucher="payment"]');
  receiptButton.disabled = !hasCapability('treasury_receipt_post'); paymentButton.disabled = !hasCapability('treasury_payment_post');
}

function openTreasuryVoucher(type) {
  byId('treasury').hidden = true; byId('journalAccount').hidden = false;
  document.querySelectorAll('#navigation button[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === 'treasury'));
  byId('pageTitle').textContent = type === 'receipt' ? 'Receipt Voucher' : 'Payment Voucher';
  byId('pageSubtitle').textContent = 'Treasury cash and bank posting.';
  showJournalView(type);
}

function dashboardAccountBalance(code) {
  return Number(state.accounting.accounts.find(account => account.code === code)?.balance || 0);
}

function setDashboardMoney(id, value) {
  const element = byId(id); element.textContent = `${formatMoney(value)} SDG`;
  element.classList.toggle('negative-number', Number(value) < 0);
}

async function renderDashboard() {
  if (!state.currentUser) return;
  const fromDate = byId('dashboardFromDate').value; const toDate = byId('dashboardToDate').value;
  const message = byId('dashboardMessage'); const button = byId('refreshDashboard');
  if (fromDate && toDate && fromDate > toDate) { message.textContent = 'The start date must be on or before the end date.'; message.hidden = false; return; }
  const request = ++dashboardRequest; button.disabled = true; message.hidden = true;
  try {
    const inPeriod = row => (!fromDate || row.invoice_date >= fromDate) && (!toDate || row.invoice_date <= toDate);
    const sales = state.sales.filter(row => row.status === 'COMPLETED' && inPeriod(row));
    const purchases = state.purchases.filter(row => row.status === 'RECEIVED' && inPeriod(row));
    const income = hasCapability('financial_reports_view')
      ? await window.appBridge.runReport('profit_loss', { fromDate, toDate })
      : { summary: [] };
    if (request !== dashboardRequest) return;
    const incomeValue = label => Number(income.summary.find(item => item.label === label)?.value || 0);
    const salesTotal = sales.reduce((sum, row) => sum + Number(row.invoice_total_base || 0), 0);
    const inventoryValue = state.inventory.reduce((sum, row) => sum + Number(row.movement_value_base || 0), 0);
    const inventoryUnits = state.inventory.reduce((sum, row) => sum + Number(row.quantity_on_hand || 0), 0);
    setDashboardMoney('dashboardSales', salesTotal);
    setDashboardMoney('dashboardGrossProfit', incomeValue('Gross profit')); setDashboardMoney('dashboardNetIncome', incomeValue('Net income'));
    const cashBalance = dashboardAccountBalance('1110');
    const bankMethods = state.accounting.paymentMethods.filter(method => method.method_type === 'BANK');
    const uniqueBanks = [...new Map(bankMethods.map(method => [Number(method.account_id), method])).values()];
    byId('dashboardBankCards').innerHTML = uniqueBanks.length ? uniqueBanks.map(method => {
      const account = state.accounting.accounts.find(item => Number(item.id) === Number(method.account_id));
      const balance = Number(account?.balance || 0);
      return `<article class="metric-card dashboard-bank-card"><span>${escapeHtml(method.name)}</span><strong class="${balance < 0 ? 'negative-number' : ''}">${formatMoney(balance)} SDG</strong><small>${escapeHtml(account?.code || method.code)} - bank balance</small></article>`;
    }).join('') : '<article class="metric-card dashboard-bank-card"><span>Bank accounts</span><strong>0.00 SDG</strong><small>No active bank accounts</small></article>';
    setDashboardMoney('dashboardInventoryValue', inventoryValue); setDashboardMoney('dashboardCash', cashBalance);
    setDashboardMoney('dashboardReceivables', dashboardAccountBalance('1200')); setDashboardMoney('dashboardPayables', dashboardAccountBalance('2100'));
    byId('dashboardSalesCount').textContent = `${sales.length} invoice${sales.length === 1 ? '' : 's'} in period`;
    byId('dashboardStockCount').textContent = `${formatQuantity(inventoryUnits)} units currently on hand`;
    const fromLabel = fromDate || 'first record'; const toLabel = toDate || 'today';
    byId('dashboardPeriodLabel').textContent = `Showing activity from ${fromLabel} to ${toLabel}. Current balance and inventory cards are as of now.`;
    const recentSales = sales.slice(0, 5);
    byId('dashboardSalesBody').innerHTML = recentSales.map(row => `<tr><td><strong>${escapeHtml(row.invoice_number)}</strong></td><td>${escapeHtml(row.invoice_date)}</td><td>${escapeHtml(row.customer_name)}</td><td class="number"><strong>${formatMoney(row.invoice_total_base)}</strong></td></tr>`).join('');
    byId('dashboardSalesEmpty').hidden = recentSales.length > 0;
    const recentPurchases = purchases.slice(0, 5);
    byId('dashboardPurchasesBody').innerHTML = recentPurchases.map(row => `<tr><td><strong>${escapeHtml(row.invoice_code)}</strong></td><td>${escapeHtml(row.invoice_date)}</td><td>${escapeHtml(row.supplier_name)}</td><td class="number"><strong>${formatMoney(row.landed_total_base)}</strong></td></tr>`).join('');
    byId('dashboardPurchasesEmpty').hidden = recentPurchases.length > 0;
    const stockAttention = state.inventory.filter(row => Number(row.quantity_on_hand || 0) <= 0).slice(0, 8);
    byId('dashboardStockBody').innerHTML = stockAttention.map(row => `<tr><td><strong>${escapeHtml(row.product_name)}</strong><small class="dashboard-sku">${escapeHtml(row.sku || 'No SKU')}</small></td><td>${escapeHtml(row.warehouse_name)}</td><td class="number"><span class="stock-quantity empty-stock">${formatQuantity(row.quantity_on_hand)}</span></td></tr>`).join('');
    byId('dashboardStockEmpty').hidden = stockAttention.length > 0;
  } catch (error) {
    if (request === dashboardRequest) { message.textContent = readableError(error, 'Unable to refresh the dashboard.'); message.hidden = false; }
  } finally { if (request === dashboardRequest) button.disabled = false; }
}

async function loadPurchaseSetup() {
  state.purchaseSetup = await window.appBridge.getPurchaseSetup();
  renderSetupOptions();
  if (hasCapability('purchase_invoice_create')) await refreshPurchaseCode();
}

async function refreshPurchaseCode() {
  if (!state.currentUser) return;
  byId('purchaseCode').value = await window.appBridge.getNextPurchaseCode(byId('purchaseDate').value);
}

function renderSetupOptions() {
  const setup = state.purchaseSetup;
  if (!setup) return;
  setOptions('purchaseSupplier', setup.suppliers, item => item.name, 'Select supplier');
  setOptions('purchaseCurrency', setup.currencies, item => `${item.code} - ${item.name}`);
  setOptions('supplierCurrency', setup.currencies, item => item.code);
  setOptions('purchaseWarehouse', setup.warehouses, item => item.name);
  setOptions('purchaseOrderSupplier', setup.suppliers, item => item.name, 'Select supplier');
setOptions('purchaseOrderCurrency', setup.currencies, item => `${item.code} - ${item.name}`);
  setOptions('purchaseOrderWarehouse', setup.warehouses, item => item.name);
  setOptions('productCategory', setup.categories.filter(item => !item.parent_id), item => item.name, 'Select main category');
  setOptions('productUnit', setup.units, item => item.name, 'Select unit');
  refreshDynamicOptions();
  handlePurchaseCurrency();
}

function setOptions(id, items, label, placeholder = '') {
  const select = byId(id); const current = select.value;
  select.innerHTML = `${placeholder ? `<option value="">${escapeHtml(placeholder)}</option>` : ''}${items.map(item => `<option value="${item.id}">${escapeHtml(label(item))}</option>`).join('')}`;
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

async function refreshPurchaseOrderNumber() {
  if (!state.currentUser || state.editingPurchaseOrderId) return;
  byId('purchaseOrderNumber').value = await window.appBridge.getNextPurchaseOrderNumber(byId('purchaseOrderDate').value);
}

async function loadPurchaseOrders() {
  state.purchaseOrders = await window.appBridge.listPurchaseOrders(); renderPurchaseOrders();
}

function renderPurchaseOrders() {
  const query = byId('purchaseOrderSearch').value.trim().toLowerCase(); const status = byId('purchaseOrderStatusFilter').value;
  const rows = state.purchaseOrders.filter(row => (!status || row.status === status || row.approval_state === status) && (!query || `${row.po_number} ${row.supplier_name} ${row.order_date} ${row.expected_delivery_date || ''} ${row.status} ${row.approval_state || ''} ${row.supplier_reference || ''}`.toLowerCase().includes(query)));
  byId('purchaseOrderBody').innerHTML = rows.map(row => {
    const draft = row.status === 'DRAFT'; const open = row.status === 'OPEN'; const partial = row.status === 'PARTIALLY_RECEIVED';
    const pendingCommercial = row.approval_state === 'PENDING_COMMERCIAL'; const pendingFinance = row.approval_state === 'PENDING_FINANCE';
    const finalized = row.approval_state === 'FINANCE_APPROVED';
    const editable = canManageScreen('inventory') && draft && !['PENDING_COMMERCIAL', 'PENDING_FINANCE', 'FINANCE_APPROVED'].includes(row.approval_state);
    const commercialActions = pendingCommercial ? `${hasCapability('purchase_order_commercial_approve') ? `<button type="button" class="compact-button" data-po-decision="COMMERCIAL_APPROVE" data-po-id="${row.id}">Commercial Approve</button>` : ''}${hasCapability('purchase_order_commercial_reject') ? `<button type="button" class="danger compact-button" data-po-decision="COMMERCIAL_REJECT" data-po-id="${row.id}">Commercial Reject</button>` : ''}` : '';
    const financeActions = pendingFinance ? `${hasCapability('purchase_order_finance_approve') ? `<button type="button" class="compact-button" data-po-decision="FINANCE_APPROVE" data-po-id="${row.id}">Financial Approve</button>` : ''}${hasCapability('purchase_order_finance_reject') ? `<button type="button" class="danger compact-button" data-po-decision="FINANCE_REJECT" data-po-id="${row.id}">Financial Reject</button>` : ''}` : '';
    const actions = `<button type="button" class="secondary compact-button" data-view-po="${row.id}">View</button>${editable ? `<button type="button" class="secondary compact-button" data-edit-po="${row.id}">Edit</button>` : ''}${editable && hasCapability('purchase_order_submit') ? `<button type="button" class="secondary compact-button" data-po-action="SUBMIT" data-po-id="${row.id}">Submit to Commercial</button>` : ''}${commercialActions}${financeActions}${editable ? `<button type="button" class="danger compact-button" data-delete-po="${row.id}">Delete</button>` : ''}${(open || partial) && finalized && hasCapability('purchase_invoice_create') ? `<button type="button" class="compact-button" data-receive-po="${row.id}">Create Invoice</button>` : ''}${(open || partial) && canManageScreen('inventory') && hasCapability('purchase_order_edit') ? `<button type="button" class="secondary compact-button" data-po-action="CLOSE" data-po-id="${row.id}">Close</button>` : ''}${(draft || open) && !pendingCommercial && !pendingFinance && canManageScreen('inventory') && hasCapability('purchase_order_edit') ? `<button type="button" class="danger compact-button" data-po-action="CANCEL" data-po-id="${row.id}">Cancel</button>` : ''}<button type="button" class="secondary compact-button" data-export-po="${row.id}">Export PDF</button>`;
    const approvals = [row.commercial_approved_by_name ? `Commercial: ${row.commercial_approved_by_name}` : '', row.financial_approved_by_name ? `Finance: ${row.financial_approved_by_name}` : '', row.accounting_handoff_at ? 'Sent to Accounting' : ''].filter(Boolean).join(' · ');
    return `<tr><td><strong>${escapeHtml(row.po_number)}</strong></td><td>${escapeHtml(row.supplier_name)}</td><td>${escapeHtml(row.order_date)}</td><td>${escapeHtml(row.expected_delivery_date || '-')}</td><td><span class="status-pill ${String(row.approval_state || row.status).toLowerCase()}">${escapeHtml((row.approval_state || row.status).replaceAll('_', ' '))}</span><small class="cell-subtitle">${escapeHtml(approvals || row.status.replaceAll('_', ' '))}</small></td><td>${escapeHtml(row.currency_code)}</td><td class="number"><strong>${formatMoney(row.total)}</strong></td><td><div class="table-actions">${actions}</div></td></tr>`;
  }).join('');
  byId('purchaseOrderEmpty').textContent = query || status ? 'No purchase orders match these filters.' : 'No purchase orders have been created.';
  byId('purchaseOrderEmpty').hidden = rows.length > 0;
}

function addPurchaseOrderLine(line = null) {
  if (!state.purchaseSetup?.products.length) {
    if (hasCapability('product_create')) byId('productDialog').showModal();
    else byId('purchaseOrderMessage').textContent = 'No products are available. Ask an administrator to grant product creation permission.';
    return;
  }
  const product = state.purchaseSetup.products.find(item => Number(item.id) === Number(line?.product_id)) || state.purchaseSetup.products[0];
  const row = document.createElement('tr');
  row.innerHTML = `<td><select class="po-product-select"></select></td><td><input class="po-description" placeholder="Optional"></td><td><input class="po-quantity" type="number" min="0.000001" step="any" value="1"></td><td><select class="po-unit-select"></select></td><td><input class="po-unit-quantity" type="number" min="0.000001" step="any" value="1"></td><td><input class="po-unit-price" type="number" min="0.000001" step="any" value="0.01"></td><td class="po-line-total number">0.00</td><td><button type="button" class="remove-row" title="Remove">&times;</button></td>`;
  byId('purchaseOrderLines').appendChild(row); refreshDynamicOptions();
  row.querySelector('.po-product-select').value = product.id; row.querySelector('.po-unit-select').value = line?.unit_id || product.default_unit_id;
  if (line) { row.querySelector('.po-description').value = line.description || ''; row.querySelector('.po-quantity').value = line.ordered_quantity; row.querySelector('.po-unit-quantity').value = line.unit_quantity; row.querySelector('.po-unit-price').value = line.unit_price; }
  renderPurchaseOrderTotal();
}

function handlePurchaseOrderLineChange(event) {
  if (event.target.classList.contains('po-product-select')) { const row = event.target.closest('tr'); const product = state.purchaseSetup.products.find(item => String(item.id) === event.target.value); if (product) row.querySelector('.po-unit-select').value = product.default_unit_id; }
  renderPurchaseOrderTotal();
}

function collectPurchaseOrderLines() {
  return [...byId('purchaseOrderLines').rows].map(row => ({ productId: Number(row.querySelector('.po-product-select').value), description: row.querySelector('.po-description').value, quantity: numberValue(row.querySelector('.po-quantity')), unitId: Number(row.querySelector('.po-unit-select').value), unitQuantity: numberValue(row.querySelector('.po-unit-quantity'), 1), unitPrice: numberValue(row.querySelector('.po-unit-price')) }));
}

function renderPurchaseOrderTotal() {
  const total = collectPurchaseOrderLines().reduce((sum, line) => sum + line.quantity * line.unitQuantity * line.unitPrice, 0);
  const currency = state.purchaseSetup?.currencies.find(item => String(item.id) === byId('purchaseOrderCurrency').value)?.code || '';
  [...byId('purchaseOrderLines').rows].forEach((row, index) => { const line = collectPurchaseOrderLines()[index]; row.querySelector('.po-line-total').textContent = formatMoney(line.quantity * line.unitQuantity * line.unitPrice); });
  byId('purchaseOrderTotal').textContent = `${formatMoney(total)} ${currency}`; byId('purchaseOrderLinesEmpty').hidden = byId('purchaseOrderLines').rows.length > 0;
}

function handlePurchaseOrderCurrency() {
  const currency = state.purchaseSetup?.currencies.find(item => String(item.id) === byId('purchaseOrderCurrency').value); if (currency?.is_base) byId('purchaseOrderRate').value = '1'; renderPurchaseOrderTotal();
}

async function openPurchaseOrderEditor(id = null) {
  state.editingPurchaseOrderId = Number(id) || null; byId('purchaseOrderForm').reset(); byId('purchaseOrderLines').innerHTML = ''; byId('purchaseOrderMessage').textContent = ''; renderSetupOptions();
  byId('purchaseOrderDate').value = new Date().toISOString().slice(0, 10); byId('purchaseOrderRate').value = '1'; byId('purchaseOrderStatus').textContent = 'DRAFT';
  if (state.editingPurchaseOrderId) {
    const order = await window.appBridge.getPurchaseOrder(state.editingPurchaseOrderId); if (!order) return;
    byId('purchaseOrderEditorTitle').textContent = `Edit ${order.po_number}`; byId('purchaseOrderNumber').value = order.po_number; byId('purchaseOrderStatus').textContent = order.status;
    byId('purchaseOrderSupplier').value = order.supplier_id; byId('purchaseOrderDate').value = order.order_date; byId('purchaseOrderExpectedDate').value = order.expected_delivery_date || ''; byId('purchaseOrderSupplierReference').value = order.supplier_reference || ''; byId('purchaseOrderCurrency').value = order.currency_id; byId('purchaseOrderRate').value = order.exchange_rate_to_base; byId('purchaseOrderWarehouse').value = order.warehouse_id; byId('purchaseOrderNotes').value = order.notes || ''; order.lines.forEach(addPurchaseOrderLine);
  } else { byId('purchaseOrderEditorTitle').textContent = 'New Purchase Order'; await refreshPurchaseOrderNumber(); }
  byId('purchaseOrderList').hidden = true; byId('purchaseOrderForm').hidden = false; renderPurchaseOrderTotal();
}

function closePurchaseOrderEditor() { state.editingPurchaseOrderId = null; byId('purchaseOrderForm').hidden = true; byId('purchaseOrderList').hidden = false; }

async function savePurchaseOrder(event) {
  event.preventDefault(); const message = byId('purchaseOrderMessage'); message.textContent = '';
  try {
    const input = { supplierId: byId('purchaseOrderSupplier').value, orderDate: byId('purchaseOrderDate').value, expectedDeliveryDate: byId('purchaseOrderExpectedDate').value, supplierReference: byId('purchaseOrderSupplierReference').value, currencyId: byId('purchaseOrderCurrency').value, exchangeRate: byId('purchaseOrderRate').value, warehouseId: byId('purchaseOrderWarehouse').value, notes: byId('purchaseOrderNotes').value, confirm: event.submitter?.dataset.poSave === 'confirm', lines: collectPurchaseOrderLines() };
    const saved = await window.appBridge.savePurchaseOrder(state.editingPurchaseOrderId, input); closePurchaseOrderEditor(); await loadPurchaseOrders();
    alert(`${saved.po_number} was ${input.confirm ? 'submitted to the Commercial Manager' : 'saved as a draft'}. No stock or accounting entries were created.`);
  } catch (error) { message.textContent = readableError(error, 'Unable to save the purchase order.'); }
}

async function handlePurchaseOrderAction(event) {
  const view = event.target.closest('[data-view-po]'); if (view) { await openPurchaseOrderDetails(Number(view.dataset.viewPo)); return; }
  const edit = event.target.closest('[data-edit-po]'); if (edit) { await openPurchaseOrderEditor(Number(edit.dataset.editPo)); return; }
  const receive = event.target.closest('[data-receive-po]'); if (receive) { await receivePurchaseOrder(Number(receive.dataset.receivePo)); return; }
  const pdf = event.target.closest('[data-export-po]'); if (pdf) { try { const result = await window.appBridge.exportPurchaseOrderPdf(Number(pdf.dataset.exportPo), window.i18n.locale); if (!result.canceled) alert(`PDF saved to ${result.filePath}.`); } catch (error) { alert(readableError(error, 'Unable to export the purchase order PDF.')); } return; }
  const remove = event.target.closest('[data-delete-po]'); if (remove) { if (!confirm('Delete this draft purchase order?')) return; try { await window.appBridge.deletePurchaseOrder(Number(remove.dataset.deletePo)); await loadPurchaseOrders(); } catch (error) { alert(readableError(error, 'Unable to delete the purchase order.')); } return; }
  const decision = event.target.closest('[data-po-decision]');
  if (decision) { openPurchaseOrderDecision(Number(decision.dataset.poId), decision.dataset.poDecision); return; }
  const action = event.target.closest('[data-po-action]'); if (!action) return;
  if (!confirm(`${action.dataset.poAction === 'CANCEL' ? 'Cancel' : action.dataset.poAction === 'CLOSE' ? 'Close' : 'Confirm'} this purchase order?`)) return;
  try { await window.appBridge.setPurchaseOrderStatus(Number(action.dataset.poId), action.dataset.poAction); await loadPurchaseOrders(); } catch (error) { alert(readableError(error, 'Unable to update the purchase order.')); }
}

async function openPurchaseOrderDetails(id) {
  try {
    const order = await window.appBridge.getPurchaseOrder(id); if (!order) throw new Error('Purchase order was not found.');
    byId('purchaseOrderDetailsTitle').textContent = order.po_number;
    byId('purchaseOrderDetailsSummary').innerHTML = `<span>${escapeHtml(order.supplier_name)}</span> · <span>${escapeHtml(order.order_date)}</span> · <span>${escapeHtml(String(order.approval_state).replaceAll('_', ' '))}</span>`;
    const meta = [
      ['Procurement Manager', order.created_by_name || '-'], ['Warehouse', order.warehouse_name],
      ['Commercial approval', order.commercial_approved_by_name ? `${order.commercial_approved_by_name} · ${order.commercial_approved_at || ''}` : '-'],
      ['Financial approval', order.financial_approved_by_name ? `${order.financial_approved_by_name} · ${order.financial_approved_at || ''}` : '-'],
      ['Accounting handoff', order.accounting_handoff_at || '-'], ['Order total', `${formatMoney(order.total)} ${order.currency_code}`]
    ];
    byId('purchaseOrderDetailsMeta').innerHTML = meta.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
    byId('purchaseOrderDetailsLines').innerHTML = order.lines.map(line => `<tr><td>${escapeHtml(line.product_name)}</td><td>${escapeHtml(line.description || '-')}</td><td class="number">${formatQuantity(line.ordered_quantity)}</td><td>${escapeHtml(line.unit_name)}</td><td class="number">${formatMoney(line.unit_price)}</td><td class="number">${formatMoney(line.line_total)}</td></tr>`).join('');
    byId('purchaseOrderDetailsHistory').innerHTML = order.approvalHistory.map(item => `<tr><td>${escapeHtml(item.action.replaceAll('_', ' '))}</td><td>${escapeHtml(item.comment || '-')}</td><td>${escapeHtml(item.acted_by_name)}</td><td>${escapeHtml(item.acted_at)}</td></tr>`).join('');
    byId('purchaseOrderDetailsDialog').showModal();
  } catch (error) { alert(readableError(error, 'Unable to open the purchase order.')); }
}

function openPurchaseOrderDecision(id, action) {
  const rejecting = action.endsWith('_REJECT'); const commercial = action.startsWith('COMMERCIAL_');
  byId('purchaseOrderDecisionForm').reset(); byId('purchaseOrderDecisionId').value = id; byId('purchaseOrderDecisionAction').value = action;
  const stage = commercial ? 'Commercial' : 'Financial';
  byId('purchaseOrderDecisionTitle').textContent = `${rejecting ? 'Reject' : 'Approve'} Purchase Order — ${stage}`;
  byId('purchaseOrderDecisionHelp').textContent = rejecting ? `Enter the reason for the ${stage} rejection.` : commercial ? 'Approval automatically routes the complete order to the Financial Manager.' : 'Final approval opens the order and automatically hands it to Accounting.';
  byId('purchaseOrderDecisionCommentLabel').firstChild.data = rejecting ? 'Rejection reason' : 'Approval comment (optional)';
  byId('purchaseOrderDecisionComment').required = rejecting; byId('purchaseOrderDecisionSubmit').textContent = rejecting ? 'Reject' : 'Approve';
  byId('purchaseOrderDecisionSubmit').classList.toggle('danger', rejecting); byId('purchaseOrderDecisionMessage').textContent = '';
  byId('purchaseOrderDecisionDialog').showModal(); byId('purchaseOrderDecisionComment').focus();
}

async function savePurchaseOrderDecision(event) {
  event.preventDefault(); const action = byId('purchaseOrderDecisionAction').value; const comment = byId('purchaseOrderDecisionComment').value.trim();
  if (action === 'REJECT' && !comment) { byId('purchaseOrderDecisionMessage').textContent = 'A rejection reason is required.'; return; }
  const button = byId('purchaseOrderDecisionSubmit'); button.disabled = true; byId('purchaseOrderDecisionMessage').textContent = '';
  try {
    await window.appBridge.decidePurchaseOrder(Number(byId('purchaseOrderDecisionId').value), action, comment);
    byId('purchaseOrderDecisionDialog').close(); await loadPurchaseOrders();
  } catch (error) { byId('purchaseOrderDecisionMessage').textContent = readableError(error, 'Unable to record the purchase-order decision.'); }
  finally { button.disabled = false; }
}

async function receivePurchaseOrder(id) {
  const order = await window.appBridge.getPurchaseOrder(id); if (!order || !['OPEN', 'PARTIALLY_RECEIVED'].includes(order.status)) return;
  const remainingLines = order.lines.filter(line => Number(line.ordered_quantity) - Number(line.cancelled_quantity) - Number(line.received_quantity) > 0.000001);
  if (!remainingLines.length) { alert('This purchase order has no remaining quantity to receive.'); return; }
  await resetPurchaseForm(); state.receivingPurchaseOrder = order; byId('purchaseOrderReferenceField').hidden = false; byId('purchaseOrderReference').value = order.po_number;
  byId('purchaseSupplier').value = order.supplier_id; byId('purchaseCurrency').value = order.currency_id; byId('purchaseRate').value = order.exchange_rate_to_base; byId('purchaseWarehouse').value = order.warehouse_id;
  remainingLines.forEach(line => addProductLine(line)); showInventoryView('direct'); byId('purchaseMessage').textContent = `Creating a purchase invoice from ${order.po_number}. Enter the invoiced quantity for each line; remove any line not included in this invoice.`;
}
const recordImagePrefix = type => type === 'sale' ? 'sales' : type;
function renderRecordImages(type) {
  const selection = state.recordImages[type]; const prefix = recordImagePrefix(type);
  byId(`${prefix}ImageSelection`).hidden = !selection.files.length;
  byId(`${prefix}ImageSummary`).textContent = selection.files.length ? `${selection.files.length} file${selection.files.length === 1 ? '' : 's'} selected` : '';
  byId(`${prefix}ImageList`).innerHTML = selection.files.map(file => `<li><span>${escapeHtml(file.name)}</span><small>${file.mimeType === 'application/pdf' ? 'PDF' : 'Image'} - ${formatFileSize(Number(file.size))}</small></li>`).join('');
}
async function selectRecordImages(type) {
  try {
    const result = await window.appBridge.selectRecordImages(); if (result.canceled) return;
    if (state.recordImages[type].token) await window.appBridge.releaseRecordImages(state.recordImages[type].token);
    state.recordImages[type] = { token: result.token, files: result.files }; renderRecordImages(type);
  } catch (error) {
    const message = type === 'sale' ? 'salesMessage' : type === 'purchase' ? 'purchaseMessage' : `${type}VoucherMessage`;
    byId(message).textContent = readableError(error, 'Unable to select attachments.');
  }
}
async function clearRecordImages(type, release = true) {
  const token = state.recordImages[type].token;
  state.recordImages[type] = { token: null, files: [] }; renderRecordImages(type);
  if (release && token) await window.appBridge.releaseRecordImages(token);
}

function invoiceHasWork(type) {
  if (type === 'sale') return Boolean(state.saleCart.length || state.editingSaleId || state.recordImages.sale.files.length
    || byId('salesNumber').value.trim() || byId('salesCustomer').value || byId('salesNotes').value.trim());
  return Boolean(byId('purchaseLines').rows.length || byId('costLines').rows.length || state.editingPurchaseId
    || state.recordImages.purchase.files.length || byId('purchaseSupplier').value
    || byId('purchaseDeclaredTotal').value || byId('purchaseNotes').value.trim());
}

function captureHeldSale() {
  const id = state.nextHeldInvoiceId++;
  const currency = state.salesSetup?.currencies.find(item => String(item.id) === byId('salesCurrency').value)?.code || '';
  const customer = byId('salesCustomer').selectedOptions[0]?.textContent || 'Walk-in customer';
  const total = state.saleCart.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  return { id, editingId: state.editingSaleId, customerId: byId('salesCustomer').value, invoiceNumber: byId('salesNumber').value,
    invoiceDate: byId('salesDate').value, warehouseId: byId('salesWarehouse').value, paymentMethodId: byId('salesPayment').value,
    currencyId: byId('salesCurrency').value, exchangeRate: byId('salesRate').value, notes: byId('salesNotes').value,
    cart: state.saleCart.map(item => ({ ...item })), attachments: state.recordImages.sale,
    title: byId('salesNumber').value.trim() || `${customer} sale`, summary: `${state.saleCart.length} item${state.saleCart.length === 1 ? '' : 's'} · ${formatMoney(total)} ${currency}` };
}

function captureHeldPurchase() {
  const id = state.nextHeldInvoiceId++;
  const currency = state.purchaseSetup?.currencies.find(item => String(item.id) === byId('purchaseCurrency').value)?.code || '';
  const supplier = byId('purchaseSupplier').selectedOptions[0]?.textContent || 'Unassigned supplier';
  const lines = collectLines().map(({ row, ...line }) => line);
  const costs = collectCosts();
  const goodsTotal = lines.reduce((sum, line) => sum + line.quantity * line.unitQuantity * line.unitPrice, 0);
  const invoiceRate = numberValue(byId('purchaseRate'), 1);
  const costsTotal = costs.reduce((sum, cost) => sum + cost.amount * cost.exchangeRate / invoiceRate, 0);
  return { id, editingId: state.editingPurchaseId, supplierId: byId('purchaseSupplier').value, invoiceCode: byId('purchaseCode').value,
    invoiceDate: byId('purchaseDate').value, currencyId: byId('purchaseCurrency').value, exchangeRate: byId('purchaseRate').value,
    warehouseId: byId('purchaseWarehouse').value, declaredTotal: byId('purchaseDeclaredTotal').value, notes: byId('purchaseNotes').value,
    lines, costs, attachments: state.recordImages.purchase, title: `${supplier} purchase`,
    summary: `${lines.length} item${lines.length === 1 ? '' : 's'} · ${formatMoney(goodsTotal + costsTotal)} ${currency}` };
}

function renderHeldInvoices(type) {
  const isSale = type === 'sale'; const drafts = state.heldInvoices[type];
  const panel = byId(isSale ? 'heldSalesPanel' : 'heldPurchasesPanel');
  const count = byId(isSale ? 'heldSalesCount' : 'heldPurchasesCount');
  const list = byId(isSale ? 'heldSalesList' : 'heldPurchasesList');
  panel.hidden = drafts.length === 0; count.textContent = String(drafts.length);
  list.innerHTML = drafts.map(draft => `<article class="held-invoice"><button type="button" class="held-invoice-main" data-resume-held="${draft.id}" title="Resume this invoice"><strong>${escapeHtml(draft.title)}</strong><small>${escapeHtml(draft.summary)}</small></button><button type="button" class="discard-held-invoice" data-discard-held="${draft.id}" title="Discard held invoice">&times;</button></article>`).join('');
}

function holdSale(silent = false) {
  if (!invoiceHasWork('sale')) { byId('salesMessage').textContent = 'Add a customer, note, attachment, or product before putting this sale on hold.'; return false; }
  if (!validateSaleCartPrices()) { byId('salesMessage').textContent = 'Correct the invalid selling prices before continuing.'; return false; }
  const draft = captureHeldSale(); state.heldInvoices.sale.push(draft);
  state.recordImages.sale = { token: null, files: [] }; resetSalesForm(false); renderHeldInvoices('sale');
  if (!silent) byId('salesMessage').textContent = `${draft.title} is on hold. A new sale is ready.`;
  return true;
}

async function holdPurchase(silent = false) {
  if (state.receivingPurchaseOrder) { byId('purchaseMessage').textContent = 'A purchase-order invoice cannot be held. Save it or clear it and return to the order later.'; return false; }
  if (!invoiceHasWork('purchase')) { byId('purchaseMessage').textContent = 'Add a supplier, note, attachment, product, or cost before putting this purchase on hold.'; return false; }
  const draft = captureHeldPurchase(); state.heldInvoices.purchase.push(draft);
  state.recordImages.purchase = { token: null, files: [] }; await resetPurchaseForm(false); renderHeldInvoices('purchase');
  if (!silent) byId('purchaseMessage').textContent = `${draft.title} is on hold. A new direct purchase is ready.`;
  return true;
}

async function resumeHeldInvoice(type, id) {
  const draft = state.heldInvoices[type].find(item => item.id === id); if (!draft) return;
  if (invoiceHasWork(type)) {
    const held = type === 'sale' ? holdSale(true) : await holdPurchase(true); if (!held) return;
  } else if (type === 'sale') resetSalesForm(); else await resetPurchaseForm();
  state.heldInvoices[type] = state.heldInvoices[type].filter(item => item.id !== id); renderHeldInvoices(type);
  if (type === 'sale') {
    state.editingSaleId = draft.editingId; byId('salesCustomer').value = draft.customerId; byId('salesNumber').value = draft.invoiceNumber;
    byId('salesDate').value = draft.invoiceDate; byId('salesWarehouse').value = draft.warehouseId; byId('salesPayment').value = draft.paymentMethodId;
    byId('salesCurrency').value = draft.currencyId; byId('salesRate').value = draft.exchangeRate; byId('salesNotes').value = draft.notes;
    state.saleCart = draft.cart.map(item => { const product = state.salesSetup?.products.find(product => Number(product.id) === Number(item.productId) && String(product.warehouse_id) === draft.warehouseId); return { ...item, available: Number(product?.quantity_on_hand ?? item.available) }; });
    state.recordImages.sale = draft.attachments; renderRecordImages('sale'); renderSalesCatalog(); renderSalesCart(); updateSalesPostingPreview();
    byId('salesMessage').textContent = `${draft.title} resumed.`; byId('salesProductSearch').focus();
  } else {
    state.editingPurchaseId = draft.editingId; byId('purchaseCode').value = draft.invoiceCode; byId('purchaseSupplier').value = draft.supplierId;
    byId('purchaseDate').value = draft.invoiceDate; byId('purchaseCurrency').value = draft.currencyId; byId('purchaseRate').value = draft.exchangeRate;
    byId('purchaseWarehouse').value = draft.warehouseId; byId('purchaseDeclaredTotal').value = draft.declaredTotal; byId('purchaseNotes').value = draft.notes;
    draft.lines.forEach(line => { addProductLine(); const row = byId('purchaseLines').lastElementChild;
      row.querySelector('.product-select').value = line.productId; row.querySelector('.line-quantity').value = line.quantity;
      row.querySelector('.unit-select').value = line.unitId; row.querySelector('.line-unit-quantity').value = line.unitQuantity;
      row.querySelector('.line-unit-price').value = line.unitPrice; row.querySelector('.pricing-method').value = line.pricingMethod;
      row.querySelector('.sales-value').value = line.pricingMethod === 'MARKUP' ? line.markupPercent ?? '' : line.manualSalesPrice ?? '';
    });
    draft.costs.forEach(cost => { addCostLine(); const row = byId('costLines').lastElementChild;
      row.querySelector('.cost-type-select').value = cost.costTypeId; row.querySelector('.cost-description').value = cost.description;
      row.querySelector('.cost-amount').value = cost.amount; row.querySelector('.cost-currency-select').value = cost.currencyId;
      row.querySelector('.cost-rate').value = cost.exchangeRate; row.querySelector('.cost-reference').value = cost.referenceCode;
    });
    state.recordImages.purchase = draft.attachments; renderRecordImages('purchase'); updatePurchasePreview();
    byId('purchaseMessage').textContent = `${draft.title} resumed.`;
  }
}

async function handleHeldInvoiceAction(type, event) {
  const resume = event.target.closest('[data-resume-held]');
  if (resume) { await resumeHeldInvoice(type, Number(resume.dataset.resumeHeld)); return; }
  const discard = event.target.closest('[data-discard-held]'); if (!discard) return;
  const id = Number(discard.dataset.discardHeld); const draft = state.heldInvoices[type].find(item => item.id === id); if (!draft) return;
  if (!confirm(`Discard "${draft.title}"? This held invoice has not been saved and cannot be recovered.`)) return;
  state.heldInvoices[type] = state.heldInvoices[type].filter(item => item.id !== id); renderHeldInvoices(type);
  if (draft.attachments.token) await window.appBridge.releaseRecordImages(draft.attachments.token);
}
function refreshDynamicOptions() {
  document.querySelectorAll('.product-select').forEach(select => replaceSelectOptions(select, state.purchaseSetup.products, item => `${item.name}${item.sku ? ` - ${item.sku}` : ''}`));
  document.querySelectorAll('.unit-select').forEach(select => replaceSelectOptions(select, state.purchaseSetup.units, item => item.name));
  document.querySelectorAll('.po-product-select').forEach(select => replaceSelectOptions(select, state.purchaseSetup.products, item => `${item.name}${item.sku ? ` - ${item.sku}` : ''}`));
  document.querySelectorAll('.po-unit-select').forEach(select => replaceSelectOptions(select, state.purchaseSetup.units, item => item.name));
  document.querySelectorAll('.cost-type-select').forEach(select => replaceSelectOptions(select, state.purchaseSetup.costTypes, item => item.name));
  document.querySelectorAll('.cost-currency-select').forEach(select => replaceSelectOptions(select, state.purchaseSetup.currencies, item => item.code));
}

function replaceSelectOptions(select, items, label) {
  const current = select.value;
  select.innerHTML = items.map(item => `<option value="${item.id}">${escapeHtml(label(item))}</option>`).join('');
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

function addProductLine(sourceLine = null) {
  if (!state.purchaseSetup?.products.length) {
    if (hasCapability('product_create')) byId('productDialog').showModal();
    else byId('purchaseMessage').textContent = 'No products are available. Ask an administrator to grant product creation permission.';
    return;
  }
  const product = state.purchaseSetup.products.find(item => Number(item.id) === Number(sourceLine?.product_id)) || state.purchaseSetup.products[0];
  const row = document.createElement('tr');
  const remaining = sourceLine ? Math.max(0, Number(sourceLine.ordered_quantity) - Number(sourceLine.cancelled_quantity || 0) - Number(sourceLine.received_quantity || 0)) : 1;
  row.dataset.purchaseOrderLineId = sourceLine?.id || '';
  row.innerHTML = `<td><select class="product-select" aria-label="Product" ${sourceLine ? 'disabled' : ''}></select></td>
    <td class="po-receipt-column number" ${sourceLine ? '' : 'hidden'}>${sourceLine ? formatQuantity(sourceLine.ordered_quantity) : '-'}</td>
    <td class="po-receipt-column number" ${sourceLine ? '' : 'hidden'}>${sourceLine ? formatQuantity(sourceLine.received_quantity) : '-'}</td>
    <td class="po-receipt-column number" ${sourceLine ? '' : 'hidden'}>${sourceLine ? formatQuantity(remaining) : '-'}</td>
    <td><input class="line-quantity" type="number" min="0.000001" step="any" value="${remaining}" aria-label="Quantity receiving now"></td>
    <td><select class="unit-select" aria-label="Unit" ${sourceLine ? 'disabled' : ''}></select></td>
    <td><input class="line-unit-quantity" type="number" min="0.000001" step="any" value="${sourceLine?.unit_quantity || 1}" aria-label="Units each" ${sourceLine ? 'readonly' : ''}></td>
    <td><input class="line-unit-price" type="number" min="0.000001" step="any" value="${sourceLine?.unit_price || 0.01}" aria-label="Unit price"></td>
    <td class="line-total number">0.00</td>
    <td><select class="pricing-method" aria-label="Pricing method"><option value="MANUAL">Manual</option><option value="MARKUP">Markup %</option></select></td>
    <td><input class="sales-value" type="number" min="0" step="any" value="${product.manual_sales_price ?? product.default_markup_percent ?? ''}" aria-label="Sales value"></td>
    <td><button type="button" class="remove-row" title="Remove">&times;</button></td>`;
  byId('purchaseLines').appendChild(row); refreshDynamicOptions(); row.querySelector('.product-select').value = product.id;
  row.querySelector('.unit-select').value = sourceLine?.unit_id || product.default_unit_id;
  if (product.default_markup_percent != null && product.manual_sales_price == null) row.querySelector('.pricing-method').value = 'MARKUP';
  if (!hasCapability('pricing_publish')) {
    row.querySelector('.pricing-method').disabled = true; row.querySelector('.pricing-method').title = 'Pricing is published by the Pricing Manager after receipt.';
    row.querySelector('.sales-value').value = ''; row.querySelector('.sales-value').disabled = true; row.querySelector('.sales-value').placeholder = 'Pricing Manager';
  }
  document.querySelectorAll('thead .po-receipt-column').forEach(cell => { cell.hidden = !state.receivingPurchaseOrder; });
  updatePurchasePreview();
}

function addCostLine() {
  const row = document.createElement('tr');
  row.innerHTML = `<td><select class="cost-type-select" aria-label="Cost type"></select></td><td><input class="cost-description" placeholder="Optional"></td>
    <td><input class="cost-amount" type="number" min="0" step="any" value="0"></td><td><select class="cost-currency-select"></select></td>
    <td><input class="cost-rate" type="number" min="0.000001" step="any" value="${numberValue(byId('purchaseRate'), 1)}"></td><td><input class="cost-reference" placeholder="Optional"></td>
    <td><button type="button" class="remove-row" title="Remove">&times;</button></td>`;
  byId('costLines').appendChild(row); refreshDynamicOptions(); row.querySelector('.cost-currency-select').value = byId('purchaseCurrency').value; updatePurchasePreview();
}

function handleProductLineChange(event) {
  const row = event.target.closest('tr'); if (!row) return;
  if (event.target.classList.contains('product-select')) {
    const product = state.purchaseSetup.products.find(item => String(item.id) === event.target.value);
    if (product) { row.querySelector('.unit-select').value = product.default_unit_id; row.querySelector('.pricing-method').value = product.manual_sales_price != null ? 'MANUAL' : 'MARKUP'; row.querySelector('.sales-value').value = product.manual_sales_price ?? product.default_markup_percent ?? ''; }
  }
  updatePurchasePreview();
}

function removeLine(event) { const button = event.target.closest('.remove-row'); if (button) { button.closest('tr').remove(); updatePurchasePreview(); } }

function handlePurchaseCurrency() {
  const currency = state.purchaseSetup?.currencies.find(item => String(item.id) === byId('purchaseCurrency').value);
  if (currency?.is_base) byId('purchaseRate').value = '1';
  byId('previewCurrency').textContent = currency?.code || 'Currency';
  updatePurchasePreview();
}

function collectLines() {
  return [...byId('purchaseLines').rows].map(row => ({
    productId: Number(row.querySelector('.product-select').value), unitId: Number(row.querySelector('.unit-select').value),
    quantity: numberValue(row.querySelector('.line-quantity')), unitQuantity: numberValue(row.querySelector('.line-unit-quantity'), 1), unitPrice: numberValue(row.querySelector('.line-unit-price')),
    pricingMethod: row.querySelector('.pricing-method').value,
    manualSalesPrice: row.querySelector('.pricing-method').value === 'MANUAL' ? nullableNumber(row.querySelector('.sales-value')) : null,
    markupPercent: row.querySelector('.pricing-method').value === 'MARKUP' ? nullableNumber(row.querySelector('.sales-value')) : null,
    purchaseOrderLineId: Number(row.dataset.purchaseOrderLineId) || null,
    row
  }));
}

function collectCosts() {
  return [...byId('costLines').rows].map(row => ({ costTypeId: Number(row.querySelector('.cost-type-select').value), description: row.querySelector('.cost-description').value,
    amount: numberValue(row.querySelector('.cost-amount')), currencyId: Number(row.querySelector('.cost-currency-select').value), exchangeRate: numberValue(row.querySelector('.cost-rate'), 1),
    referenceCode: row.querySelector('.cost-reference').value }));
}

function updatePurchasePreview() {
  if (!state.purchaseSetup) return;
  const invoiceRate = numberValue(byId('purchaseRate'), 1);
  const lines = collectLines().map(line => ({ ...line, baseQuantity: line.quantity * line.unitQuantity, lineTotal: line.quantity * line.unitQuantity * line.unitPrice }));
  const goodsTotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const costsTotal = collectCosts().reduce((sum, cost) => sum + (cost.amount * cost.exchangeRate / invoiceRate), 0);
  const currency = state.purchaseSetup.currencies.find(item => String(item.id) === byId('purchaseCurrency').value)?.code || '';
  byId('costPreviewBody').innerHTML = lines.map(line => {
    const product = state.purchaseSetup.products.find(item => item.id === line.productId);
    const allocated = goodsTotal ? line.lineTotal / goodsTotal * costsTotal : 0;
    const landedTotal = line.lineTotal + allocated;
    const landedUnit = line.baseQuantity ? landedTotal / line.baseQuantity : 0;
    const suggested = line.pricingMethod === 'MARKUP' ? landedUnit * (1 + Number(line.markupPercent || 0) / 100) : Number(line.manualSalesPrice || 0);
    line.row.querySelector('.line-total').textContent = formatMoney(line.lineTotal);
    return `<tr><td>${escapeHtml(product?.name || 'Select product')}</td><td class="number">${formatMoney(line.lineTotal)}</td><td class="number">${formatMoney(allocated)}</td><td class="number">${formatMoney(landedTotal)}</td><td class="number">${formatMoney(landedUnit)}</td><td class="number">${formatMoney(suggested)}</td></tr>`;
  }).join('') || '<tr><td colspan="6">Add product lines to calculate landed cost.</td></tr>';
  byId('goodsTotal').textContent = `${formatMoney(goodsTotal)} ${currency}`; byId('costsTotal').textContent = `${formatMoney(costsTotal)} ${currency}`; byId('landedTotal').textContent = `${formatMoney(goodsTotal + costsTotal)} ${currency}`;
  const baseTotal = (goodsTotal + costsTotal) * invoiceRate; byId('postingDebit').textContent = `${formatMoney(baseTotal)} SDG`; byId('postingCredit').textContent = `${formatMoney(baseTotal)} SDG`;
  byId('emptyProducts').hidden = lines.length > 0; byId('emptyCosts').hidden = byId('costLines').rows.length > 0;
}

async function savePurchase(event, confirmations = {}) {
  event.preventDefault();
  const status = 'DRAFT'; const message = byId('purchaseMessage'); message.textContent = '';
  try {
    const input = { supplierId: byId('purchaseSupplier').value, supplierInvoiceNumber: byId('purchaseSupplierInvoiceNumber').value,
      purchaseOrderId: state.receivingPurchaseOrder?.id || null, invoiceDate: byId('purchaseDate').value,
      currencyId: byId('purchaseCurrency').value, exchangeRate: byId('purchaseRate').value, warehouseId: byId('purchaseWarehouse').value,
      declaredTotal: byId('purchaseDeclaredTotal').value, notes: byId('purchaseNotes').value, status,
      allowDuplicateSupplierInvoice: Boolean(confirmations.allowDuplicateSupplierInvoice), allowOverDelivery: Boolean(confirmations.allowOverDelivery),
      attachmentToken: state.recordImages.purchase.token,
      lines: collectLines().map(({ row, ...line }) => line), costs: collectCosts() };
    const saved = state.editingPurchaseId ? await window.appBridge.updatePurchase(state.editingPurchaseId, input) : await window.appBridge.createPurchase(input);
    const sourcePo = state.receivingPurchaseOrder?.po_number; await resetPurchaseForm();
    await Promise.all([loadPurchases(), loadPurchaseOrders(), loadInventory(), loadAccounting(), loadSalesSetup()]); await renderDashboard(); showInventoryView('direct');
    byId('purchaseMessage').textContent = `${saved.invoice_code} was saved${sourcePo ? ` against ${sourcePo}` : ''}. Submit it to Finance for funding authorization.`;
  } catch (error) {
    const detail = String(error?.message || error);
    if (detail.includes('DUPLICATE_SUPPLIER_INVOICE') && !confirmations.allowDuplicateSupplierInvoice && confirm('This supplier invoice number already exists for this supplier. Save this purchase invoice anyway?')) return savePurchase(event, { ...confirmations, allowDuplicateSupplierInvoice: true });
    if (detail.includes('OVER_DELIVERY') && !confirmations.allowOverDelivery && confirm('The receiving quantity exceeds the remaining purchase-order quantity. Confirm this over-delivery and continue?')) return savePurchase(event, { ...confirmations, allowOverDelivery: true });
    message.textContent = readableError(error, 'Unable to save the purchase invoice.');
  }
}

async function resetPurchaseForm(releaseAttachments = true) {
  state.editingPurchaseId = null; state.receivingPurchaseOrder = null; await clearRecordImages('purchase', releaseAttachments); byId('purchaseForm').reset(); byId('purchaseDate').value = new Date().toISOString().slice(0, 10); byId('purchaseRate').value = '1';
  byId('purchaseOrderReferenceField').hidden = true; byId('purchaseOrderReference').value = ''; document.querySelectorAll('.po-receipt-column').forEach(cell => { cell.hidden = true; });
  byId('purchaseLines').innerHTML = ''; byId('costLines').innerHTML = ''; byId('purchaseMessage').textContent = ''; renderSetupOptions(); updatePurchasePreview(); await refreshPurchaseCode();
}

function showInventoryView(view) {
  const ids = { stock: 'inventoryStockOverview', orders: 'inventoryPurchaseOrders', direct: 'inventoryDirectPurchase', funding: 'inventoryFunding', receipts: 'inventoryStockReceipts', pricing: 'inventoryPricing', history: 'inventoryPurchaseHistory' };
  Object.entries(ids).forEach(([key, id]) => { byId(id).hidden = key !== view; });
  document.querySelectorAll('[data-inventory-view]').forEach(button => button.classList.toggle('active', button.dataset.inventoryView === view));
  if (view === 'orders') loadPurchaseOrders();
  if (view === 'funding') loadPurchaseFunding();
  if (view === 'receipts') loadGoodsReceiptQueue();
  if (view === 'pricing') loadPricing();
  if (view === 'history') loadPurchases();
}

function showPurchaseView(view) {
  openPage('inventory'); showInventoryView(view === 'history' ? 'history' : 'direct');
}

async function loadPurchases() {
  state.purchases = await window.appBridge.listPurchases();
  renderPurchases();
}

function renderPurchases() {
  const query = byId('purchaseSearch').value.trim().toLowerCase();
  const rows = state.purchases.filter(row => !query || `${row.invoice_code} ${row.supplier_invoice_number || ''} ${row.po_number || ''} ${row.invoice_date} ${row.supplier_name} ${row.status} ${row.currency_code}`.toLowerCase().includes(query));
  byId('purchaseHistoryBody').innerHTML = purchaseRows(rows);
  byId('purchaseHistoryEmpty').textContent = query ? 'No purchase invoices match your search.' : 'No purchase invoices have been created.';
  byId('purchaseHistoryEmpty').hidden = rows.length > 0;
  renderStockReceipts();
}

function renderStockReceipts() {
  const rows = state.goodsReceiptQueue;
  byId('stockReceiptBody').innerHTML = rows.map(row => { const remaining = Math.max(0, Number(row.expected_quantity) - Number(row.received_quantity)); return `<tr><td><strong>${escapeHtml(row.invoice_code)}</strong></td><td>${escapeHtml(row.invoice_date)}</td><td><strong>${escapeHtml(row.product_name)}</strong><small>${escapeHtml(row.unit_name)}</small></td><td>${escapeHtml(row.warehouse_name)}</td><td class="number">${formatQuantity(row.expected_quantity)}</td><td class="number">${formatQuantity(row.received_quantity)}</td><td class="number"><strong>${formatQuantity(remaining)}</strong></td><td>${remaining > 0 ? `<button type="button" data-confirm-goods-receipt="${row.purchase_invoice_line_id}">Receive</button>` : '<span class="status-pill received">Complete</span>'}</td></tr>`; }).join('');
  byId('stockReceiptEmpty').hidden = rows.length > 0;
}

async function loadGoodsReceiptQueue() {
  if (!hasCapability('goods_receipt_view')) return;
  try { state.goodsReceiptQueue = await window.appBridge.listGoodsReceiptQueue(); renderStockReceipts(); }
  catch (error) { alert(readableError(error, 'Unable to load warehouse receipts.')); }
}

function handleGoodsReceiptAction(event) {
  const button = event.target.closest('[data-confirm-goods-receipt]'); if (!button) return;
  const row = state.goodsReceiptQueue.find(item => Number(item.purchase_invoice_line_id) === Number(button.dataset.confirmGoodsReceipt)); if (!row) return;
  const remaining = Math.max(0, Number(row.expected_quantity) - Number(row.received_quantity));
  byId('goodsReceiptPurchaseId').value = row.purchase_invoice_id; byId('goodsReceiptLineId').value = row.purchase_invoice_line_id;
  byId('goodsReceiptSummary').textContent = `${row.invoice_code} - ${row.product_name}; ${formatQuantity(remaining)} ${row.unit_name} remaining.`;
  byId('goodsReceiptDate').value = new Date().toISOString().slice(0, 10); byId('goodsReceiptAccepted').value = remaining;
  byId('goodsReceiptDamaged').value = 0; byId('goodsReceiptRejected').value = 0; byId('goodsReceiptDeliveryNote').value = '';
  byId('goodsReceiptBatch').value = ''; byId('goodsReceiptExpiry').value = ''; byId('goodsReceiptNotes').value = ''; byId('goodsReceiptMessage').textContent = '';
  byId('goodsReceiptDialog').showModal();
}

async function submitGoodsReceipt(event) {
  event.preventDefault(); byId('goodsReceiptMessage').textContent = '';
  try {
    await window.appBridge.confirmGoodsReceipt({ purchaseInvoiceId: byId('goodsReceiptPurchaseId').value, receiptDate: byId('goodsReceiptDate').value,
      deliveryNoteNumber: byId('goodsReceiptDeliveryNote').value, notes: byId('goodsReceiptNotes').value,
      lines: [{ purchaseInvoiceLineId: byId('goodsReceiptLineId').value, acceptedQuantity: byId('goodsReceiptAccepted').value,
        damagedQuantity: byId('goodsReceiptDamaged').value, rejectedQuantity: byId('goodsReceiptRejected').value,
        batchCode: byId('goodsReceiptBatch').value, expiryDate: byId('goodsReceiptExpiry').value }] });
    byId('goodsReceiptDialog').close();
    await Promise.all([loadGoodsReceiptQueue(), loadInventory(), hasCapability('purchase_invoice_view') ? loadPurchases() : Promise.resolve(), loadSalesSetup().catch(() => {})]);
  } catch (error) { byId('goodsReceiptMessage').textContent = readableError(error, 'Unable to confirm this goods receipt.'); }
}

async function loadPurchaseFunding() {
  if (!['purchase_funding_view','purchase_disbursement_view'].some(hasCapability)) return;
  try {
    state.purchaseFunding = await window.appBridge.listPurchaseFunding();
    state.purchaseDisbursements = hasCapability('purchase_disbursement_view') ? await window.appBridge.listPurchaseDisbursements() : [];
    renderPurchaseFunding(); renderPurchaseDisbursements();
  }
  catch (error) { alert(readableError(error, 'Unable to load funding requests.')); }
}

function renderPurchaseFunding() {
  byId('fundingBody').innerHTML = state.purchaseFunding.map(row => `<tr><td><strong>${escapeHtml(row.invoice_code)}</strong></td><td>${escapeHtml(row.supplier_name)}</td><td class="number">${formatMoney(row.requested_amount)} ${escapeHtml(row.currency_code)}</td><td class="number">${formatMoney(row.paid_amount)}</td><td class="number">${formatMoney(row.ordered_amount)}</td><td><span class="status-pill">${escapeHtml(row.status)}</span></td><td>${escapeHtml(row.requested_by_name)}</td><td><div class="table-actions">${row.status === 'PENDING' && hasCapability('purchase_funding_approve') ? `<button data-funding-action="AUTHORIZE" data-funding-id="${row.id}">Authorize</button>` : ''}${row.status === 'PENDING' && hasCapability('purchase_funding_reject') ? `<button class="danger" data-funding-action="REJECT" data-funding-id="${row.id}">Reject</button>` : ''}${['AUTHORIZED','PARTIALLY_PAID'].includes(row.status) && hasCapability('purchase_disbursement_create') && Number(row.requested_amount) > Number(row.paid_amount) + Number(row.ordered_amount) ? `<button data-funding-action="ORDER" data-funding-id="${row.id}">Issue disbursement</button>` : ''}</div></td></tr>`).join('');
  byId('fundingEmpty').hidden = state.purchaseFunding.length > 0;
}

function renderPurchaseDisbursements() {
  byId('disbursementBody').innerHTML = state.purchaseDisbursements.map(row => `<tr><td><strong>${escapeHtml(row.order_number)}</strong></td><td>${escapeHtml(row.invoice_code)}</td><td>${escapeHtml(row.supplier_name)}</td><td>${escapeHtml(row.debit_account_code)} - ${escapeHtml(row.debit_account_name)}</td><td class="number">${formatMoney(row.amount)} ${escapeHtml(row.currency_code)}</td><td>${escapeHtml(row.payment_account_name || '-')}</td><td><span class="status-pill">${escapeHtml(row.status)}</span>${row.payment_number ? `<small>${escapeHtml(row.payment_number)}</small>` : ''}</td><td>${escapeHtml(row.instructed_by_name)}</td><td><div class="table-actions">${['PENDING_TREASURY','PARTIALLY_EXECUTED'].includes(row.status) && hasCapability('purchase_disbursement_execute') ? `<button data-pay-disbursement="${row.id}">Issue voucher</button>` : ''}${row.status === 'EXECUTED' ? `<button class="secondary" data-export-disbursement="${row.id}">Export voucher</button>` : ''}</div></td></tr>`).join('');
  byId('disbursementEmpty').hidden = state.purchaseDisbursements.length > 0;
}

function handleFundingAction(event) {
  const button = event.target.closest('[data-funding-action]'); if (!button) return; const id = Number(button.dataset.fundingId); const action = button.dataset.fundingAction;
  const request = state.purchaseFunding.find(row => Number(row.id) === id); if (!request) return;
  if (action === 'AUTHORIZE' || action === 'REJECT') {
    byId('fundingDecisionId').value = id; byId('fundingDecisionAction').value = action;
    byId('fundingDecisionTitle').textContent = action === 'REJECT' ? 'Reject Funding Request' : 'Authorize Funding Request';
    byId('fundingDecisionSummary').textContent = `${request.invoice_code} - ${request.supplier_name} - ${formatMoney(request.requested_amount)} ${request.currency_code}`;
    byId('fundingDecisionComment').value = ''; byId('fundingDecisionComment').required = action === 'REJECT'; byId('fundingDecisionMessage').textContent = '';
    byId('fundingDecisionDialog').showModal();
  } else if (action === 'ORDER') {
    const outstanding = Number(request.requested_amount) - Number(request.paid_amount) - Number(request.ordered_amount);
    byId('disbursementOrderFundingId').value = id; byId('disbursementOrderSummary').textContent = `${request.invoice_code} - unallocated ${formatMoney(outstanding)} ${request.currency_code}`;
    byId('disbursementOrderAmount').value = outstanding; byId('disbursementOrderMode').value = 'SUPPLIER';
    byId('disbursementOrderNotes').value = ''; byId('disbursementOrderMessage').textContent = '';
    byId('disbursementOrderDialog').showModal();
  }
}

function handleDisbursementAction(event) {
  const exportButton = event.target.closest('[data-export-disbursement]');
  if (exportButton) { window.appBridge.exportDisbursementPdf(Number(exportButton.dataset.exportDisbursement)).catch(error => alert(readableError(error, 'Unable to export the payment voucher.'))); return; }
  const button = event.target.closest('[data-pay-disbursement]'); if (!button) return;
  const order = state.purchaseDisbursements.find(row => Number(row.id) === Number(button.dataset.payDisbursement)); if (!order) return;
  const outstanding = Number(order.amount) - Number(order.executed_amount);
  byId('fundingPaymentId').value = order.id;
  byId('fundingPaymentSummary').textContent = `${order.order_number} · ${order.invoice_code} · ${order.supplier_name}`;
  byId('fundingPaymentDebitAccount').value = `${order.debit_account_code} - ${order.debit_account_name}`;
  byId('fundingPaymentAmount').value = outstanding; byId('fundingPaymentDate').value = new Date().toISOString().slice(0, 10);
  byId('fundingPaymentNotes').value = ''; byId('fundingPaymentMessage').textContent = '';
  const methods = state.accounting.paymentMethods.filter(row => ['CASH','BANK'].includes(row.method_type));
  byId('fundingPaymentMethod').innerHTML = methods.map(row => `<option value="${row.id}">${escapeHtml(row.name)}</option>`).join('');
  byId('fundingPaymentDialog').showModal();
}

async function refreshFundingAfterAction() {
  await Promise.all([loadPurchaseFunding(), hasCapability('purchase_invoice_view') ? loadPurchases() : Promise.resolve(), loadAccounting().catch(() => {})]);
}

async function submitFundingDecision(event) {
  event.preventDefault(); byId('fundingDecisionMessage').textContent = '';
  try { await window.appBridge.decidePurchaseFunding(byId('fundingDecisionId').value, byId('fundingDecisionAction').value, byId('fundingDecisionComment').value);
    byId('fundingDecisionDialog').close(); await refreshFundingAfterAction(); }
  catch (error) { byId('fundingDecisionMessage').textContent = readableError(error, 'Unable to record this funding decision.'); }
}

async function submitDisbursementOrder(event) {
  event.preventDefault(); byId('disbursementOrderMessage').textContent = '';
  try {
    await window.appBridge.createPurchaseDisbursement(byId('disbursementOrderFundingId').value, {
      amount: byId('disbursementOrderAmount').value, paymentMode: byId('disbursementOrderMode').value,
      notes: byId('disbursementOrderNotes').value });
    byId('disbursementOrderDialog').close(); await refreshFundingAfterAction();
  } catch (error) { byId('disbursementOrderMessage').textContent = readableError(error, 'Unable to issue the disbursement order.'); }
}

async function submitFundingPayment(event) {
  event.preventDefault(); byId('fundingPaymentMessage').textContent = '';
  try { await window.appBridge.executeSupplierPayment(byId('fundingPaymentId').value, { amount: byId('fundingPaymentAmount').value,
      paymentMethodId: byId('fundingPaymentMethod').value, entryDate: byId('fundingPaymentDate').value, notes: byId('fundingPaymentNotes').value });
    byId('fundingPaymentDialog').close(); await refreshFundingAfterAction(); }
  catch (error) { byId('fundingPaymentMessage').textContent = readableError(error, 'Unable to post this funding payment.'); }
}

async function loadPricing() {
  if (!hasCapability('pricing_view')) return;
  try { state.pricing = await window.appBridge.listPricing(); renderPricing(); }
  catch (error) { alert(readableError(error, 'Unable to load pricing.')); }
}

function renderPricing() {
  byId('pricingBody').innerHTML = state.pricing.map(row => `<tr><td><strong>${escapeHtml(row.product_name)}</strong><small>${escapeHtml(row.sku || '')}</small></td><td>${escapeHtml(row.warehouse_name)}</td><td class="number">${formatQuantity(row.quantity_available)}</td><td class="number">${row.landed_cost_base == null ? 'Restricted' : `${formatMoney(row.landed_cost_base)} SDG`}</td><td>${escapeHtml(row.pricing_method || 'UNPRICED')}</td><td class="number">${row.markup_percent == null ? '-' : `${formatQuantity(row.markup_percent)}%`}</td><td class="number"><strong>${row.minimum_sale_price == null ? 'Not published' : `${formatMoney(row.minimum_sale_price)} SDG`}</strong></td><td>${escapeHtml(row.effective_from || '-')}</td><td>${hasCapability('pricing_publish') ? `<button data-publish-price="${row.product_id}" data-price-warehouse="${row.warehouse_id}">Publish</button>` : ''}</td></tr>`).join('');
  byId('pricingEmpty').hidden = state.pricing.length > 0;
}

function handlePricingAction(event) {
  const button = event.target.closest('[data-publish-price]'); if (!button) return;
  const row = state.pricing.find(item => Number(item.product_id) === Number(button.dataset.publishPrice) && Number(item.warehouse_id) === Number(button.dataset.priceWarehouse)); if (!row) return;
  byId('pricingPublishProductId').value = row.product_id; byId('pricingPublishWarehouseId').value = row.warehouse_id;
  byId('pricingPublishSummary').textContent = `${row.product_name} - ${row.warehouse_name}; landed cost ${formatMoney(row.landed_cost_base || 0)} SDG.`;
  byId('pricingPublishMethod').value = row.pricing_method || 'MANUAL'; byId('pricingManualPrice').value = row.minimum_sale_price || '';
  byId('pricingMarkupPercent').value = row.markup_percent ?? 15; byId('pricingPublishDate').value = new Date().toISOString().slice(0, 10);
  byId('pricingPublishNotes').value = ''; byId('pricingPublishMessage').textContent = ''; updatePricingDialogFields(); byId('pricingPublishDialog').showModal();
}

function updatePricingDialogFields() {
  const markup = byId('pricingPublishMethod').value === 'MARKUP'; byId('pricingManualField').hidden = markup; byId('pricingMarkupField').hidden = !markup;
  byId('pricingManualPrice').required = !markup; byId('pricingMarkupPercent').required = markup;
}

async function submitPublishedPrice(event) {
  event.preventDefault(); byId('pricingPublishMessage').textContent = '';
  try { await window.appBridge.publishPrice({ productId: byId('pricingPublishProductId').value, warehouseId: byId('pricingPublishWarehouseId').value,
      pricingMethod: byId('pricingPublishMethod').value, manualPrice: byId('pricingManualPrice').value,
      markupPercent: byId('pricingMarkupPercent').value, effectiveFrom: byId('pricingPublishDate').value, notes: byId('pricingPublishNotes').value });
    byId('pricingPublishDialog').close(); await Promise.all([loadPricing(), loadSalesSetup().catch(() => {})]); }
  catch (error) { byId('pricingPublishMessage').textContent = readableError(error, 'Unable to publish this price.'); }
}

function purchaseRows(rows) {
  return rows.map(row => `<tr><td><strong>${escapeHtml(row.invoice_code)}</strong></td><td>${escapeHtml(row.supplier_invoice_number || '-')}</td><td>${escapeHtml(row.po_number || '-')}</td><td>${escapeHtml(row.invoice_date)}</td><td>${escapeHtml(row.supplier_name)}</td><td><span class="status-pill ${row.status === 'RECEIVED' ? 'received' : ''}">${escapeHtml(row.workflow_state || row.status)}</span></td><td>${escapeHtml(row.currency_code)}</td><td class="number">${formatMoney(row.goods_total)}</td><td class="number">${formatMoney(row.additional_cost_total)}</td><td class="number"><strong>${formatMoney(row.landed_total)}</strong></td><td><div class="table-actions">${row.workflow_state === 'DRAFT' && hasCapability('purchase_invoice_edit') ? `<button type="button" class="secondary compact-button" data-edit-purchase="${row.id}">Edit</button><button type="button" class="danger compact-button" data-delete-purchase="${row.id}">Delete</button>` : ''}${row.workflow_state === 'DRAFT' && hasCapability('purchase_invoice_submit') ? `<button type="button" data-submit-purchase="${row.id}">Submit to Finance</button>` : ''}${row.workflow_state === 'DRAFT' && hasCapability('purchase_cost_manage') ? `<button type="button" class="secondary compact-button" data-add-purchase-cost="${row.id}">Add cost</button>` : ''}${Number(row.attachment_count) ? `<button type="button" class="secondary compact-button" data-view-invoice-images="${row.id}">Attachments (${Number(row.attachment_count)})</button>` : ''}<button type="button" class="compact-button" data-export-purchase-pdf="${row.id}">Export PDF</button></div></td></tr>`).join('');
}

async function editPurchase(id) {
  const invoice = await window.appBridge.getPurchase(id); if (!invoice) return;
  const sourceOrder = invoice.purchase_order_id ? await window.appBridge.getPurchaseOrder(invoice.purchase_order_id) : null;
  await resetPurchaseForm(); state.editingPurchaseId = id; state.receivingPurchaseOrder = sourceOrder; showPurchaseView('editor');
  byId('purchaseCode').value = invoice.invoice_code; byId('purchaseSupplier').value = invoice.supplier_id; byId('purchaseSupplierInvoiceNumber').value = invoice.supplier_invoice_number || '';
  if (sourceOrder) { byId('purchaseOrderReferenceField').hidden = false; byId('purchaseOrderReference').value = sourceOrder.po_number; }
  byId('purchaseDate').value = invoice.invoice_date; byId('purchaseCurrency').value = invoice.currency_id;
  byId('purchaseRate').value = invoice.exchange_rate_to_base; if (invoice.warehouse_id) byId('purchaseWarehouse').value = invoice.warehouse_id; byId('purchaseDeclaredTotal').value = invoice.declared_invoice_total ?? '';
  byId('purchaseNotes').value = invoice.notes || ''; byId('purchaseLines').innerHTML = ''; byId('costLines').innerHTML = '';
  invoice.lines.forEach(line => { const source = sourceOrder?.lines.find(item => Number(item.id) === Number(line.purchase_order_line_id));
    addProductLine(source ? { ...source, received_quantity: Math.max(0, Number(source.received_quantity) - Number(line.quantity)) } : null); const row = byId('purchaseLines').lastElementChild;
    row.querySelector('.product-select').value = line.product_id; row.querySelector('.line-quantity').value = line.quantity;
    row.querySelector('.unit-select').value = line.unit_id || state.purchaseSetup.products.find(item => Number(item.id) === Number(line.product_id))?.default_unit_id;
    row.querySelector('.line-unit-quantity').value = line.unit_quantity; row.querySelector('.line-unit-price').value = line.unit_price;
    row.querySelector('.pricing-method').value = line.pricing_method; row.querySelector('.sales-value').value = line.pricing_method === 'MARKUP' ? line.markup_percent ?? '' : line.manual_sales_price ?? '';
  });
  invoice.costs.forEach(cost => { addCostLine(); const row = byId('costLines').lastElementChild;
    row.querySelector('.cost-type-select').value = cost.cost_type_id; row.querySelector('.cost-description').value = cost.description || '';
    row.querySelector('.cost-amount').value = cost.amount; row.querySelector('.cost-currency-select').value = cost.currency_id;
    row.querySelector('.cost-rate').value = cost.exchange_rate_to_base; row.querySelector('.cost-reference').value = cost.reference_code || '';
  });
  updatePurchasePreview(); byId('purchaseMessage').textContent = `Editing an existing invoice. Saving will rebuild its stock and accounting posting.${invoice.attachments?.length ? ` Its ${invoice.attachments.length} saved attachment${invoice.attachments.length === 1 ? '' : 's'} will be preserved; newly selected files will be added.` : ''}`;
}
async function deletePurchase(id) {
  if (!confirm('Delete this purchase invoice and its related stock and journal entries?')) return;
  try { await window.appBridge.deletePurchase(id); await Promise.all([loadPurchases(), loadPurchaseOrders(), loadInventory(), loadAccounting(), loadSalesSetup()]); await renderDashboard(); }
  catch (error) { alert(readableError(error, 'Unable to delete the purchase invoice.')); }
}

async function submitPurchaseInvoice(id) {
  const invoice = state.purchases.find(row => Number(row.id) === id); if (!invoice || !confirm(`Submit ${invoice.invoice_code} to Finance for funding authorization?`)) return;
  try { await window.appBridge.submitPurchaseInvoice(id); await loadPurchases(); alert(`${invoice.invoice_code} was submitted to Finance.`); }
  catch (error) { alert(readableError(error, 'Unable to submit this purchase invoice.')); }
}

async function exportInvoicePdf(type, invoiceId, button) {
  const originalText = button.textContent; button.disabled = true; button.textContent = 'Preparing...';
  try {
    const result = type === 'sale' ? await window.appBridge.exportSalePdf(invoiceId, window.i18n.locale) : await window.appBridge.exportPurchasePdf(invoiceId, window.i18n.locale);
    if (!result.canceled) alert(`PDF saved to ${result.filePath}${result.attachmentCount ? ` with ${result.attachmentCount} image attachment${result.attachmentCount === 1 ? '' : 's'}` : ''}.`);
  } catch (error) { alert(readableError(error, 'Unable to export the invoice PDF.')); }
  finally { button.disabled = false; button.textContent = originalText; }
}

function showAttachmentPreview(attachment) {
  const isPdf = attachment.mimeType === 'application/pdf';
  const image = byId('journalImagePreview'); const pdf = byId('journalPdfPreview');
  byId('journalImagePreviewTitle').textContent = attachment.name;
  byId('journalImagePreviewMeta').textContent = `${attachment.mimeType} - ${formatFileSize(Number(attachment.size))}`;
  image.hidden = isPdf; pdf.hidden = !isPdf;
  if (isPdf) {
    image.removeAttribute('src'); pdf.src = attachment.dataUrl; pdf.title = attachment.name;
  } else {
    pdf.removeAttribute('src'); image.alt = attachment.name; image.src = attachment.dataUrl;
  }
  byId('journalImageDialog').showModal();
}

async function openInvoiceImages(invoiceType, invoiceId) {
  try {
    const invoice = invoiceType === 'SALE' ? await window.appBridge.getSale(invoiceId) : await window.appBridge.getPurchase(invoiceId);
    if (!invoice) return;
    const reference = invoiceType === 'SALE' ? invoice.invoice_number : invoice.invoice_code;
    byId('invoiceAttachmentTitle').textContent = `${reference} - saved attachments`;
    byId('invoiceAttachmentList').innerHTML = (invoice.attachments || []).map(item =>
      `<article><div><strong>${escapeHtml(item.original_name)}</strong><small>${escapeHtml(item.mime_type)} - ${formatFileSize(Number(item.file_size))}</small></div><span class="journal-attachment-actions"><button type="button" class="secondary compact-button" data-view-invoice-image="${item.id}" data-invoice-type="${invoiceType}" data-invoice-id="${invoiceId}">Open</button><button type="button" class="secondary compact-button" data-export-invoice-attachment="${item.id}" data-invoice-type="${invoiceType}" data-invoice-id="${invoiceId}">Save copy</button></span></article>`).join('');
    byId('invoiceAttachmentDialog').showModal();
  } catch (error) { alert(readableError(error, 'Unable to load invoice attachments.')); }
}
async function exportInvoiceAttachment(event) {
  const button = event.target.closest('[data-export-invoice-attachment]'); if (!button) return;
  button.disabled = true;
  try {
    await window.appBridge.exportInvoiceAttachment(button.dataset.invoiceType,
      Number(button.dataset.invoiceId), Number(button.dataset.exportInvoiceAttachment));
  } catch (error) { alert(readableError(error, 'Unable to save a copy of the invoice attachment.')); }
  finally { button.disabled = false; }
}

async function viewInvoiceImage(event) {
  const button = event.target.closest('[data-view-invoice-image]'); if (!button) return;
  button.disabled = true;
  try {
    const attachment = await window.appBridge.viewInvoiceImage(button.dataset.invoiceType, Number(button.dataset.invoiceId), Number(button.dataset.viewInvoiceImage));
    byId('invoiceAttachmentDialog').close();
    showAttachmentPreview(attachment);
  } catch (error) { alert(readableError(error, 'Unable to display the saved invoice attachment.')); }
  finally { button.disabled = false; }
}

async function openPurchaseCostDialog(purchaseId) {
  const purchase = await window.appBridge.getPurchase(purchaseId);
  if (!purchase) return;
  state.activePurchase = purchase;
  byId('purchaseCostTitle').textContent = `Additional costs ? ${purchase.invoice_code}`;
  byId('purchaseCostSubtitle').textContent = `${purchase.supplier_name} ? ${purchase.invoice_date} ? ${purchase.status}`;
  byId('purchaseCostSupplier').innerHTML = state.purchaseSetup.suppliers.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  byId('purchaseCostType').innerHTML = state.purchaseSetup.costTypes.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  byId('purchaseCostCurrency').innerHTML = state.purchaseSetup.currencies.map(item => `<option value="${item.id}">${escapeHtml(item.code)} ? ${escapeHtml(item.name)}</option>`).join('');
  byId('purchaseCostSupplier').value = String(purchase.supplier_id);
  byId('purchaseCostCurrency').value = String(purchase.currency_id);
  byId('purchaseCostRate').value = String(purchase.exchange_rate_to_base);
  byId('purchaseCostDate').value = new Date().toISOString().slice(0, 10);
  await refreshPurchaseCostCode();
  byId('purchaseCostAmount').value = '';
  byId('purchaseCostDescription').value = '';
  byId('purchaseCostMessage').textContent = '';
  renderPurchaseCostDialog();
  byId('purchaseCostDialog').showModal();
  byId('purchaseCostAmount').focus();
}

function renderPurchaseCostDialog() {
  const purchase = state.activePurchase; if (!purchase) return;
  byId('purchaseCostSummary').innerHTML = `<article><span>Goods</span><strong>${formatMoney(purchase.goods_total)} ${escapeHtml(purchase.currency_code)}</strong></article><article><span>Additional costs</span><strong>${formatMoney(purchase.additional_cost_total)} ${escapeHtml(purchase.currency_code)}</strong></article><article><span>Landed total</span><strong>${formatMoney(purchase.landed_total)} ${escapeHtml(purchase.currency_code)}</strong></article>`;
  byId('purchaseCostHistoryBody').innerHTML = purchase.costs.map(cost => {
    const posting = cost.journal_entry_number ? cost.journal_entry_number : (purchase.status === 'RECEIVED' ? 'Included in purchase' : 'Pending draft');
    return `<tr><td><strong>${escapeHtml(cost.reference_code || 'Initial cost')}</strong></td><td>${escapeHtml(cost.cost_invoice_date || purchase.invoice_date)}</td><td>${escapeHtml(cost.cost_supplier_name)}</td><td>${escapeHtml(cost.cost_type_name)}</td><td class="number">${formatMoney(cost.amount)} ${escapeHtml(cost.currency_code)}</td><td class="number">${formatMoney(Number(cost.amount) * Number(cost.exchange_rate_to_base))} SDG</td><td><span class="source-pill cost-posting">${escapeHtml(posting)}</span></td></tr>`;
  }).join('');
  byId('purchaseCostHistoryEmpty').hidden = purchase.costs.length > 0;
}

async function refreshPurchaseCostCode() {
  if (!state.currentUser) return;
  byId('purchaseCostInvoiceNumber').value = await window.appBridge.getNextPurchaseCostCode(byId('purchaseCostDate').value);
}

function updatePurchaseCostRate() {
  const currency = state.purchaseSetup?.currencies.find(item => String(item.id) === byId('purchaseCostCurrency').value);
  if (!currency) return;
  if (currency.is_base) byId('purchaseCostRate').value = '1';
  else if (state.activePurchase && Number(currency.id) === Number(state.activePurchase.currency_id)) byId('purchaseCostRate').value = String(state.activePurchase.exchange_rate_to_base);
}

async function savePurchaseCost(event) {
  event.preventDefault();
  if (!state.activePurchase) return;
  const button = byId('savePurchaseCost'); const message = byId('purchaseCostMessage');
  button.disabled = true; message.textContent = '';
  try {
    state.activePurchase = await window.appBridge.addPurchaseCost(state.activePurchase.id, {
      supplierId: byId('purchaseCostSupplier').value,
      invoiceDate: byId('purchaseCostDate').value, costTypeId: byId('purchaseCostType').value,
      amount: byId('purchaseCostAmount').value, currencyId: byId('purchaseCostCurrency').value,
      exchangeRate: byId('purchaseCostRate').value, description: byId('purchaseCostDescription').value.trim()
    });
    await Promise.all([loadPurchases(), loadInventory(), loadSalesSetup(), loadAccounting()]);
    await renderDashboard(); renderPurchaseCostDialog();
    const savedReference = state.activePurchase.costs[state.activePurchase.costs.length - 1]?.reference_code;
    byId('purchaseCostAmount').value = ''; byId('purchaseCostDescription').value = '';
    await refreshPurchaseCostCode();
    message.textContent = `Cost invoice ${savedReference} was attached successfully.`; message.className = 'notice';
  } catch (error) {
    message.textContent = readableError(error, 'Unable to attach the additional-cost invoice.'); message.className = 'form-error';
  } finally { button.disabled = false; }
}

async function addSupplier(event) {
  event.preventDefault();
  const supplierName = byId('supplierName').value.trim(); const targetId = state.supplierTarget || 'purchaseSupplier';
  try {
    await window.appBridge.addSupplier({ name: supplierName, phone: byId('supplierPhone').value.trim(), location: byId('supplierLocation').value.trim(), supplierType: byId('supplierType').value, currencyId: byId('supplierCurrency').value });
    event.target.reset(); byId('supplierError').textContent = ''; byId('supplierDialog').close(); await loadPurchaseSetup();
    const named = [...state.purchaseSetup.suppliers].reverse().find(item => item.name.toLowerCase() === supplierName.toLowerCase());
    if (named && byId(targetId)) byId(targetId).value = named.id;
  } catch (error) { byId('supplierError').textContent = readableError(error, 'Unable to add supplier.'); }
}

async function addProduct(event) {
  event.preventDefault(); const productName = byId('productName').value.trim();
  try {
    await window.appBridge.addProduct({ name: productName, sku: byId('productSku').value.trim(), categoryId: byId('productCategory').value, unitId: byId('productUnit').value, markupPercent: byId('productMarkup').value });
    event.target.reset(); byId('productError').textContent = ''; byId('productDialog').close(); await loadPurchaseSetup(); addProductLine();
    const row = byId('purchaseLines').lastElementChild; const product = state.purchaseSetup.products.find(item => item.name === productName); if (row && product) { row.querySelector('.product-select').value = product.id; row.querySelector('.unit-select').value = product.default_unit_id; }
    updatePurchasePreview();
  } catch (error) { byId('productError').textContent = readableError(error, 'Unable to add product.'); }
}

const reportModes = {
  journal_account: 'period', trial_balance: 'as-of', profit_loss: 'period', balance_sheet: 'as-of',
  cash_flow: 'period', owners_equity: 'period', sales_register: 'period', purchase_register: 'period', operational_workflow: 'period', inventory_valuation: 'current'
};

async function selectReport(reportId) {
  state.activeReportId = reportId;
  const inventoryReport = reportId === 'inventory_valuation';
  const reportViewer = byId('reportViewer');
  (inventoryReport ? byId('inventoryReportHost') : byId('generalReportHost')).appendChild(reportViewer);
  document.querySelectorAll('[data-report-id]').forEach(card => card.classList.toggle('selected-report', card.dataset.reportId === reportId));
  const mode = reportModes[reportId];
  byId('reportFromDate').disabled = mode !== 'period'; byId('reportToDate').disabled = mode === 'current';
  byId('reportFromDateFilter').hidden = mode !== 'period'; byId('reportToDateFilter').hidden = mode === 'current';
  byId('reportAccountFilter').hidden = reportId !== 'journal_account';
  byId('accountStatementFilters').hidden = reportId !== 'journal_account';
  byId('inventoryReportFilters').hidden = !inventoryReport;
  reportViewer.hidden = false; byId('reportMessage').hidden = true;
  await runActiveReport(); reportViewer.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function activeReportFilters() {
  const inventory = state.activeReportId === 'inventory_valuation';
  return { fromDate: byId('reportFromDate').disabled ? null : byId('reportFromDate').value,
    toDate: byId('reportToDate').disabled ? null : byId('reportToDate').value,
    accountId: byId('reportAccountFilter').hidden ? null : byId('reportAccount').value,
    accountSearch: state.activeReportId === 'journal_account' ? byId('reportAccountSearch').value : '',
    accountScope: state.activeReportId === 'journal_account' ? byId('reportAccountScope').value : 'descendants',
    accountStatus: state.activeReportId === 'journal_account' ? byId('reportAccountStatus').value : 'POSTED',
    accountSourceType: state.activeReportId === 'journal_account' ? byId('reportAccountSource').value : '',
    accountMovement: state.activeReportId === 'journal_account' ? byId('reportAccountMovement').value : '',
    accountCurrencyId: state.activeReportId === 'journal_account' ? byId('reportAccountCurrency').value : null,
    accountPartyType: state.activeReportId === 'journal_account' ? byId('reportAccountPartyType').value : '',
    accountPartyId: state.activeReportId === 'journal_account' ? byId('reportAccountParty').value : null,
    accountAmountBasis: state.activeReportId === 'journal_account' ? byId('reportAccountAmountBasis').value : 'base',
    accountMinAmount: state.activeReportId === 'journal_account' ? byId('reportAccountMinAmount').value : null,
    accountMaxAmount: state.activeReportId === 'journal_account' ? byId('reportAccountMaxAmount').value : null,
    accountSort: state.activeReportId === 'journal_account' ? byId('reportAccountSort').value : 'asc',
    search: inventory ? byId('reportInventorySearch').value : '',
    warehouseId: inventory ? byId('reportInventoryWarehouse').value : null,
    category: inventory ? byId('reportInventoryCategory').value : '',
    stockStatus: inventory ? byId('reportInventoryStatus').value : '',
    minQuantity: inventory ? byId('reportInventoryMinQuantity').value : null,
    maxQuantity: inventory ? byId('reportInventoryMaxQuantity').value : null,
    minValue: inventory ? byId('reportInventoryMinValue').value : null,
    maxValue: inventory ? byId('reportInventoryMaxValue').value : null,
    hasSalvage: inventory && byId('reportInventoryHasSalvage').checked };
}

async function runActiveReport() {
  if (!state.activeReportId) return;
  const button = byId('runActiveReport'); button.disabled = true;
  try {
    state.activeReport = await window.appBridge.runReport(state.activeReportId, activeReportFilters());
    renderActiveReport();
  } catch (error) {
    byId('reportMessage').textContent = readableError(error, 'Unable to run this report.'); byId('reportMessage').hidden = false;
  } finally { button.disabled = false; }
}

function reportValue(value, type) {
  if (type === 'money') return formatMoney(value);
  if (type === 'quantity') return formatQuantity(value);
  return escapeHtml(value ?? '');
}

function renderActiveReport() {
  const report = state.activeReport; if (!report) return;
  byId('activeReportTitle').textContent = report.title; byId('activeReportSubtitle').textContent = `${report.subtitle} - ${report.filterDescription}`;
  byId('reportSummary').innerHTML = report.summary.map(item => `<article><span>${escapeHtml(item.label)}</span><strong>${reportValue(item.value, item.type)}${item.suffix ? ` ${escapeHtml(item.suffix)}` : ''}</strong></article>`).join('');
  byId('reportTableHead').innerHTML = `<tr>${report.columns.map(column => `<th class="${column.type === 'money' || column.type === 'quantity' ? 'number' : ''}">${escapeHtml(column.label)}</th>`).join('')}</tr>`;
  byId('reportTableBody').innerHTML = report.rows.map(row => `<tr>${report.columns.map(column => `<td class="${column.type === 'money' || column.type === 'quantity' ? 'number' : ''}">${reportValue(row[column.key], column.type)}</td>`).join('')}</tr>`).join('');
  byId('reportEmpty').hidden = report.rows.length > 0; byId('reportMessage').hidden = true;
}

async function exportActiveReportPdf() {
  if (!state.activeReportId) return;
  const button = byId('exportActiveReportPdf'); button.disabled = true; byId('reportMessage').hidden = true;
  try {
    const result = await window.appBridge.exportReportPdf(state.activeReportId, activeReportFilters());
    if (!result.canceled) { byId('reportMessage').textContent = `PDF saved to ${result.filePath}`; byId('reportMessage').hidden = false; }
  } catch (error) {
    byId('reportMessage').textContent = readableError(error, 'Unable to export the PDF.'); byId('reportMessage').hidden = false;
  } finally { button.disabled = false; }
}

async function loadSalesSetup() {
  state.salesSetup = await window.appBridge.getSalesSetup();
  setOptions('salesWarehouse', state.salesSetup.warehouses, item => item.name);
  setOptions('salesPayment', state.salesSetup.paymentMethods, item => item.name);
  setOptions('salesCurrency', state.salesSetup.currencies, item => `${item.code} - ${item.name}`);
  const customer = byId('salesCustomer').value;
  byId('salesCustomer').innerHTML = `<option value="">Walk-in customer</option>${state.salesSetup.customers.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}`;
  if ([...byId('salesCustomer').options].some(option => option.value === customer)) byId('salesCustomer').value = customer;
  renderSalesCatalog(); updateSalesPostingPreview();
}

function showSalesView(view) {
  byId('salesCheckout').hidden = view !== 'checkout'; byId('salesHistory').hidden = view !== 'history'; byId('salesReturns').hidden = view !== 'returns';
  document.querySelectorAll('[data-sales-view]').forEach(button => button.classList.toggle('active', button.dataset.salesView === view));
  if (view === 'history') loadSales();
  if (view === 'returns') loadSalesReturns();
}

function renderSalesCatalog() {
  if (!state.salesSetup) return;
  const query = byId('salesProductSearch').value.trim().toLowerCase();
  const warehouse = byId('salesWarehouse').value;
  const rate = numberValue(byId('salesRate'), 1);
  const currency = state.salesSetup.currencies.find(item => String(item.id) === byId('salesCurrency').value)?.code || '';
  const categories = [...new Set(state.salesSetup.products.filter(product => !warehouse || String(product.warehouse_id) === warehouse).map(product => product.category_name))].sort();
  if (state.salesCategory && !categories.includes(state.salesCategory)) state.salesCategory = '';
  byId('salesCategoryFilters').innerHTML = `<button type="button" data-sales-category="" class="${state.salesCategory ? '' : 'active'}">All products</button>${categories.map(category => `<button type="button" data-sales-category="${escapeHtml(category)}" class="${state.salesCategory === category ? 'active' : ''}">${escapeHtml(category)}</button>`).join('')}`;
  const rows = state.salesSetup.products.filter(product => (!warehouse || String(product.warehouse_id) === warehouse)
    && (!state.salesCategory || product.category_name === state.salesCategory)
    && (!query || `${product.name} ${product.sku || ''} ${product.barcode || ''} ${product.category_name}`.toLowerCase().includes(query)));
  byId('salesProductBody').innerHTML = rows.map(product => `<article class="pos-product-card"><button type="button" data-add-sale-product="${product.id}" ${Number(product.quantity_on_hand) <= 0 ? 'disabled' : ''}><span class="pos-product-visual" aria-hidden="true">${escapeHtml(String(product.name || '?').trim().slice(0, 2).toUpperCase())}</span><span class="pos-product-copy"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.category_name)}</small><span class="pos-product-meta"><b>${formatMoney(Number(product.sales_price_base || 0) / rate)} ${escapeHtml(currency)}</b><em>${formatQuantity(product.quantity_on_hand)} ${escapeHtml(product.unit_name)}</em></span></span><span class="pos-add-mark" aria-hidden="true">+</span></button></article>`).join('');
  byId('salesProductEmpty').hidden = rows.length > 0;
}

function scanSalesBarcode(event) {
  if (event.key !== 'Enter') return;
  const barcode = event.currentTarget.value.trim();
  const warehouse = byId('salesWarehouse').value;
  const product = state.salesSetup?.products.find(item => item.barcode === barcode && String(item.warehouse_id) === warehouse);
  if (!product) {
    if (/^\d{8,14}$/.test(barcode)) {
      event.preventDefault();
      byId('salesMessage').textContent = 'Barcode not found in the selected warehouse, or the item has no available stock.';
    }
    return;
  }
  event.preventDefault();
  addSaleProduct(Number(product.id));
  event.currentTarget.value = '';
  byId('salesMessage').textContent = '';
  renderSalesCatalog();
}

function addSaleProduct(productId) {
  const warehouse = byId('salesWarehouse').value;
  const product = state.salesSetup.products.find(item => item.id === productId && String(item.warehouse_id) === warehouse);
  if (!product || Number(product.quantity_on_hand) <= 0) return;
  const existing = state.saleCart.find(item => item.productId === productId);
  if (existing) existing.quantity += 1;
  else state.saleCart.push({ productId, name: product.name, unitName: product.unit_name, available: Number(product.quantity_on_hand), quantity: 1,
    floorPrice: Number(product.minimum_sale_price_base || product.sales_price_base || 0) / numberValue(byId('salesRate'), 1), unitPrice: Number(product.sales_price_base || 0) / numberValue(byId('salesRate'), 1) });
  renderSalesCart();
}

function renderSalesCart() {
  const currency = state.salesSetup?.currencies.find(item => String(item.id) === byId('salesCurrency').value)?.code || '';
  const canIncreasePrice = hasCapability('sale_price_increase');
  byId('salesCartBody').innerHTML = state.saleCart.map((item, index) => `<tr data-cart-index="${index}"><td><strong>${escapeHtml(item.name)}</strong><small class="cell-subtitle">${escapeHtml(item.unitName)} - ${formatQuantity(item.available)} available</small></td><td><input class="cart-quantity" type="number" min="0.000001" max="${item.available}" step="any" value="${item.quantity}"></td><td><input class="cart-price" type="number" inputmode="decimal" step="any" value="${item.unitPrice}" aria-describedby="cart-price-help-${index} cart-price-error-${index}" ${canIncreasePrice ? '' : 'readonly'}><small id="cart-price-help-${index}" class="cell-subtitle">Approved price ${formatMoney(item.floorPrice || 0)}</small><small id="cart-price-error-${index}" class="cart-price-error" hidden></small></td><td class="cart-line-total number">${formatMoney(item.quantity * item.unitPrice)}</td><td><button type="button" class="remove-row remove-cart-item">&times;</button></td></tr>`).join('');
  byId('salesCartEmpty').hidden = state.saleCart.length > 0;
  byId('salesCartCount').textContent = state.saleCart.length ? `${state.saleCart.length} product${state.saleCart.length === 1 ? '' : 's'}` : 'No items added';
  updateSalesTotals(currency);
}

function updateSalesTotals(currency) {
  const total = state.saleCart.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  byId('salesTotal').textContent = `${formatMoney(total)} ${currency}`;
  const baseTotal = total * numberValue(byId('salesRate'), 1);
  byId('salesDebitPreview').textContent = `${formatMoney(baseTotal)} SDG`; byId('salesCreditPreview').textContent = `${formatMoney(baseTotal)} SDG`;
}

function updateSaleCartValue(event) {
  const row = event.target.closest('[data-cart-index]'); if (!row) return;
  const item = state.saleCart[Number(row.dataset.cartIndex)];
  if (event.target.matches('.cart-quantity')) item.quantity = Math.max(0, numberValue(row.querySelector('.cart-quantity')));
  if (event.target.matches('.cart-price')) {
    const enteredPrice = Number(event.target.value);
    if (event.target.value !== '' && Number.isFinite(enteredPrice)) item.unitPrice = enteredPrice;
    clearSalePriceError(event.target);
  }
  row.querySelector('.cart-line-total').textContent = formatMoney(item.quantity * item.unitPrice);
  const currency = state.salesSetup?.currencies.find(value => String(value.id) === byId('salesCurrency').value)?.code || '';
  updateSalesTotals(currency);
}

function salePriceValidationMessage(input) {
  const row = input.closest('[data-cart-index]');
  const item = row ? state.saleCart[Number(row.dataset.cartIndex)] : null;
  const enteredPrice = Number(input.value);
  if (!item || input.value.trim() === '' || !Number.isFinite(enteredPrice)) return 'Enter a valid selling price.';
  if (enteredPrice + 0.000001 < Number(item.floorPrice || 0)) {
    return window.i18n.t('The entered price is below the approved price of {price}.', { price: formatMoney(item.floorPrice || 0) });
  }
  if (enteredPrice > Number(item.floorPrice || 0) + 0.000001 && !hasCapability('sale_price_increase')) {
    return 'You do not have permission to increase the approved price.';
  }
  return '';
}

function clearSalePriceError(input) {
  input.removeAttribute('aria-invalid');
  const error = input.closest('td')?.querySelector('.cart-price-error');
  if (error) { error.textContent = ''; error.hidden = true; }
}

function validateSalePriceInput(input) {
  const validationMessage = salePriceValidationMessage(input);
  const error = input.closest('td')?.querySelector('.cart-price-error');
  input.toggleAttribute('aria-invalid', Boolean(validationMessage));
  if (error) { error.textContent = validationMessage; error.hidden = !validationMessage; }
  if (validationMessage) return false;
  const row = input.closest('[data-cart-index]');
  const item = state.saleCart[Number(row.dataset.cartIndex)];
  item.unitPrice = Number(input.value);
  row.querySelector('.cart-line-total').textContent = formatMoney(item.quantity * item.unitPrice);
  return true;
}

function validateChangedSalePrice(event) {
  if (!event.target.matches('.cart-price')) return;
  validateSalePriceInput(event.target);
  const currency = state.salesSetup?.currencies.find(value => String(value.id) === byId('salesCurrency').value)?.code || '';
  updateSalesTotals(currency);
}

function validateSaleCartPrices() {
  const inputs = [...byId('salesCartBody').querySelectorAll('.cart-price')];
  const invalidInputs = inputs.filter(input => !validateSalePriceInput(input));
  invalidInputs[0]?.focus();
  return invalidInputs.length === 0;
}

function removeSaleCartItem(event) {
  const button = event.target.closest('.remove-cart-item'); if (!button) return;
  const row = button.closest('[data-cart-index]'); state.saleCart.splice(Number(row.dataset.cartIndex), 1); renderSalesCart();
}

function handleSalesCurrency() {
  const currency = state.salesSetup?.currencies.find(item => String(item.id) === byId('salesCurrency').value);
  if (currency?.is_base) byId('salesRate').value = '1';
  renderSalesCatalog(); renderSalesCart();
}

function updateSalesPostingPreview() {
  const payment = state.salesSetup?.paymentMethods.find(item => String(item.id) === byId('salesPayment').value);
  byId('salesPaymentPosting').textContent = `Debit - ${payment?.name || 'Payment account'}`;
}

async function saveSale(event) {
  event.preventDefault(); const status = event.submitter?.dataset.salesStatus || 'COMPLETED'; const message = byId('salesMessage'); message.textContent = '';
  if (!validateSaleCartPrices()) { message.textContent = 'Correct the invalid selling prices before continuing.'; return; }
  try {
    const sale = await (state.editingSaleId ? window.appBridge.updateSale(state.editingSaleId, { invoiceNumber: byId('salesNumber').value, invoiceDate: byId('salesDate').value,
      customerId: byId('salesCustomer').value, warehouseId: byId('salesWarehouse').value, paymentMethodId: byId('salesPayment').value,
      currencyId: byId('salesCurrency').value, exchangeRate: byId('salesRate').value, notes: byId('salesNotes').value, status,
      attachmentToken: state.recordImages.sale.token,
      lines: state.saleCart.map(item => ({ productId: item.productId, quantity: item.quantity, unitPrice: item.unitPrice })) })
      : window.appBridge.createSale({ invoiceNumber: byId('salesNumber').value, invoiceDate: byId('salesDate').value,
      customerId: byId('salesCustomer').value, warehouseId: byId('salesWarehouse').value, paymentMethodId: byId('salesPayment').value,
      currencyId: byId('salesCurrency').value, exchangeRate: byId('salesRate').value, notes: byId('salesNotes').value, status,
      attachmentToken: state.recordImages.sale.token,
      lines: state.saleCart.map(item => ({ productId: item.productId, quantity: item.quantity, unitPrice: item.unitPrice })) }));
    resetSalesForm(); await Promise.all([loadSales(), loadInventory(), loadSalesSetup(), loadAccounting()]); await renderDashboard(); showSalesView('checkout');
    byId('salesMessage').textContent = `${sale.invoice_number} was completed and posted. The checkout is ready for the next customer.`;
  } catch (error) { message.textContent = readableError(error, 'Unable to save the sale.'); }
}

function resetSalesForm(releaseAttachments = true) {
  state.editingSaleId = null; clearRecordImages('sale', releaseAttachments); byId('salesForm').reset(); byId('salesDate').value = new Date().toISOString().slice(0, 10); byId('salesRate').value = '1';
  state.saleCart = []; byId('salesMessage').textContent = ''; renderSalesCatalog(); renderSalesCart(); updateSalesPostingPreview();
}

async function loadSales() {
  state.sales = await window.appBridge.listSales();
  byId('salesHistoryBody').innerHTML = state.sales.map(row => `<tr><td><strong>${escapeHtml(row.invoice_number)}</strong></td><td>${escapeHtml(row.invoice_date)}</td><td>${escapeHtml(row.customer_name)}</td><td>${escapeHtml(row.payment_method)}</td><td><span class="status-pill ${row.status === 'COMPLETED' ? 'received' : ''}">${escapeHtml(row.status)}</span></td><td>${escapeHtml(row.currency_code)}</td><td class="number">${formatMoney(row.invoice_total)}</td><td class="number"><strong>${formatMoney(row.invoice_total_base)} SDG</strong></td><td><div class="table-actions">${row.status === 'DRAFT' ? `<button type="button" class="secondary compact-button" data-edit-sale="${row.id}">Edit</button><button type="button" class="danger compact-button" data-delete-sale="${row.id}">Delete</button>` : ''}${row.status === 'COMPLETED' && hasCapability('sales_return_create') ? `<button type="button" data-create-return="${row.id}">Create Return</button>` : ''}${Number(row.attachment_count) ? `<button type="button" class="secondary compact-button" data-view-invoice-images="${row.id}">Attachments (${Number(row.attachment_count)})</button>` : ''}<button type="button" class="compact-button" data-export-sale-pdf="${row.id}">Export PDF</button></div></td></tr>`).join('');
  byId('salesHistoryEmpty').hidden = state.sales.length > 0;
}

async function loadSalesReturns() {
  if (!['sales_return_create','sales_return_approve','purchase_funding_approve','sales_return_settle','sale_view_all'].some(hasCapability)) return;
  try { state.salesReturns = await window.appBridge.listSalesReturns(); renderSalesReturns(); }
  catch (error) { alert(readableError(error, 'Unable to load sales returns.')); }
}

function renderSalesReturns() {
  byId('salesReturnBody').innerHTML = state.salesReturns.map(row => `<tr><td><strong>${escapeHtml(row.return_number)}</strong></td><td>${escapeHtml(row.invoice_number)}</td><td>${escapeHtml(row.return_date)}</td><td>${escapeHtml(row.customer_name)}</td><td><span class="status-pill">${escapeHtml(row.status)}</span></td><td class="number">${formatMoney(row.return_total)}</td><td><div class="table-actions">${row.status === 'SUBMITTED' && hasCapability('sales_return_approve') ? `<button data-return-action="COMMERCIAL_APPROVE" data-return-id="${row.id}">Commercial Approve</button><button class="danger" data-return-action="REJECT" data-return-id="${row.id}">Reject</button>` : ''}${row.status === 'COMMERCIAL_APPROVED' && hasCapability('purchase_funding_approve') ? `<button data-return-action="FINANCE_APPROVE" data-return-id="${row.id}">Finance Approve</button><button class="danger" data-return-action="REJECT" data-return-id="${row.id}">Reject</button>` : ''}${row.status === 'FINANCE_APPROVED' && hasCapability('sales_return_settle') ? `<button data-return-action="SETTLE" data-return-id="${row.id}">Refund</button>` : ''}</div></td></tr>`).join('');
  byId('salesReturnsEmpty').hidden = state.salesReturns.length > 0;
}

async function createSalesReturn(saleId) {
  try {
    const sale = await window.appBridge.getSale(saleId); if (!sale) return;
    byId('salesReturnSaleId').value = sale.id; byId('salesReturnCreateSummary').textContent = `${sale.invoice_number} - ${sale.customer_name}`;
    byId('salesReturnDate').value = new Date().toISOString().slice(0, 10); byId('salesReturnReason').value = ''; byId('salesReturnCreateMessage').textContent = '';
    byId('salesReturnCreateLines').innerHTML = sale.lines.map(line => `<tr data-return-source-line="${line.id}"><td><strong>${escapeHtml(line.product_name)}</strong></td><td class="number">${formatQuantity(line.quantity)}</td><td><input class="return-line-quantity" type="number" min="0" max="${Number(line.quantity)}" step="any" value="0"></td><td><select class="return-line-status"><option value="AVAILABLE">AVAILABLE</option><option value="DAMAGED">DAMAGED</option><option value="SALVAGE">SALVAGE</option><option value="DISPOSED">DISPOSED</option></select></td></tr>`).join('');
    byId('salesReturnCreateDialog').showModal();
  } catch (error) { alert(readableError(error, 'Unable to create the sales return.')); }
}

async function submitSalesReturn(event) {
  event.preventDefault(); byId('salesReturnCreateMessage').textContent = '';
  const lines = Array.from(byId('salesReturnCreateLines').rows).map(row => ({ salesInvoiceLineId: row.dataset.returnSourceLine,
    quantity: row.querySelector('.return-line-quantity').value, restockStatus: row.querySelector('.return-line-status').value })).filter(line => Number(line.quantity) > 0);
  if (!lines.length) { byId('salesReturnCreateMessage').textContent = 'Enter at least one return quantity.'; return; }
  try { await window.appBridge.createSalesReturn({ salesInvoiceId: byId('salesReturnSaleId').value, returnDate: byId('salesReturnDate').value,
      reason: byId('salesReturnReason').value, lines }); byId('salesReturnCreateDialog').close(); await loadSalesReturns(); showSalesView('returns'); }
  catch (error) { byId('salesReturnCreateMessage').textContent = readableError(error, 'Unable to create the sales return.'); }
}

function handleSalesReturnAction(event) {
  const button = event.target.closest('[data-return-action]'); if (!button) return; const id = Number(button.dataset.returnId); const action = button.dataset.returnAction;
  const record = state.salesReturns.find(row => Number(row.id) === id); byId('salesReturnActionId').value = id; byId('salesReturnActionValue').value = action;
  byId('salesReturnActionTitle').textContent = action === 'SETTLE' ? 'Post Customer Refund' : action === 'REJECT' ? 'Reject Sales Return' : 'Approve Sales Return';
  byId('salesReturnActionSummary').textContent = `${record?.return_number || ''} - ${record?.invoice_number || ''} - ${formatMoney(record?.return_total || 0)}`;
  byId('salesReturnActionComment').value = ''; byId('salesReturnActionComment').required = action === 'REJECT';
  byId('salesReturnCommentField').hidden = action === 'SETTLE'; byId('salesReturnPaymentField').hidden = action !== 'SETTLE'; byId('salesReturnActionMessage').textContent = '';
  if (action === 'SETTLE') { const methods = state.accounting.paymentMethods.filter(row => ['CASH','BANK'].includes(row.method_type));
    byId('salesReturnPaymentMethod').innerHTML = methods.map(row => `<option value="${row.id}">${escapeHtml(row.name)}</option>`).join(''); }
  byId('salesReturnActionDialog').showModal();
}

async function submitSalesReturnAction(event) {
  event.preventDefault(); const id = byId('salesReturnActionId').value; const action = byId('salesReturnActionValue').value; byId('salesReturnActionMessage').textContent = '';
  try { if (action === 'SETTLE') await window.appBridge.settleSalesReturn(id, byId('salesReturnPaymentMethod').value);
    else await window.appBridge.decideSalesReturn(id, action, byId('salesReturnActionComment').value);
    byId('salesReturnActionDialog').close(); await Promise.all([loadSalesReturns(), loadSales(), loadInventory().catch(() => {}), loadAccounting().catch(() => {})]); }
  catch (error) { byId('salesReturnActionMessage').textContent = readableError(error, 'Unable to complete the return action.'); }
}

async function editSale(id) {
  const invoice = await window.appBridge.getSale(id); if (!invoice) return;
  resetSalesForm(); state.editingSaleId = id; showSalesView('checkout');
  byId('salesNumber').value = invoice.invoice_number; byId('salesDate').value = invoice.invoice_date;
  byId('salesCustomer').value = invoice.customer_id || ''; byId('salesPayment').value = invoice.payment_method_id;
  byId('salesCurrency').value = invoice.currency_id; byId('salesRate').value = invoice.exchange_rate_to_base;
  byId('salesNotes').value = invoice.notes || '';
  if (invoice.warehouse_id) byId('salesWarehouse').value = invoice.warehouse_id;
  state.saleCart = invoice.lines.map(line => {
    const product = state.salesSetup.products.find(item => Number(item.id) === Number(line.product_id) && String(item.warehouse_id) === byId('salesWarehouse').value)
      || state.salesSetup.products.find(item => Number(item.id) === Number(line.product_id));
    return { productId: Number(line.product_id), name: line.product_name, unitName: line.unit_name,
      available: Number(product?.quantity_on_hand || 0) + Number(line.quantity), quantity: Number(line.quantity),
      floorPrice: Number(line.published_unit_price || product?.minimum_sale_price_base || 0), unitPrice: Number(line.unit_price) };
  });
  renderSalesCart(); byId('salesMessage').textContent = `Editing an existing invoice. Saving will rebuild its inventory and accounting posting.${invoice.attachments?.length ? ` Its ${invoice.attachments.length} saved attachment${invoice.attachments.length === 1 ? '' : 's'} will be preserved; newly selected files will be added.` : ''}`;
}
async function deleteSale(id) {
  if (!confirm('Delete this sales invoice and its related inventory and journal entries?')) return;
  try { await window.appBridge.deleteSale(id); await Promise.all([loadSales(), loadInventory(), loadAccounting(), loadSalesSetup()]); await renderDashboard(); }
  catch (error) { alert(readableError(error, 'Unable to delete the sales invoice.')); }
}

async function addCustomer(event) {
  event.preventDefault(); const name = byId('customerName').value.trim();
  try {
    const created = await window.appBridge.addCustomer({ name, phone: byId('customerPhone').value.trim(), location: byId('customerLocation').value.trim() });
    event.target.reset(); byId('customerError').textContent = ''; byId('customerDialog').close(); await loadSalesSetup();
    if (created?.id) {
      byId('salesCustomer').value = String(created.id);
      byId('salesCustomer').refreshSearchableValue?.();
      byId('salesMessage').textContent = `${created.name} is selected as the invoice customer.`;
    }
  } catch (error) { byId('customerError').textContent = readableError(error, 'Unable to add customer.'); }
}

async function loadInventory() {
  state.inventory = await window.appBridge.getInventorySummary();
  const warehouses = [...new Map(state.inventory.map(row => [row.warehouse_id, row.warehouse_name])).entries()];
  const current = byId('inventoryWarehouse').value;
  byId('inventoryWarehouse').innerHTML = `<option value="">All warehouses</option>${warehouses.map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('')}`;
  if ([...byId('inventoryWarehouse').options].some(option => option.value === current)) byId('inventoryWarehouse').value = current;
  const reportWarehouse = byId('reportInventoryWarehouse').value;
  byId('reportInventoryWarehouse').innerHTML = `<option value="">All warehouses</option>${warehouses.map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('')}`;
  if ([...byId('reportInventoryWarehouse').options].some(option => option.value === reportWarehouse)) byId('reportInventoryWarehouse').value = reportWarehouse;
  const categories = [...new Set(state.inventory.map(row => row.category_name))].sort((a, b) => a.localeCompare(b));
  const reportCategory = byId('reportInventoryCategory').value;
  byId('reportInventoryCategory').innerHTML = `<option value="">All categories</option>${categories.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}`;
  if ([...byId('reportInventoryCategory').options].some(option => option.value === reportCategory)) byId('reportInventoryCategory').value = reportCategory;
  renderInventory();
}

function showJournalView(view) {
  document.querySelectorAll('[data-journal-view-panel]').forEach(panel => {
    if (panel.id === 'journalDetailPanel') { if (view !== 'history') panel.hidden = true; }
    else panel.hidden = panel.dataset.journalViewPanel !== view;
  });
  document.querySelectorAll('[data-journal-view]').forEach(button => button.classList.toggle('active', button.dataset.journalView === view));
  if (view === 'history') renderJournals();
}

function cashVoucherAccountOptions() {
  const accounts = state.accounting.accounts.filter(account => account.is_active && (!account.is_control
    || [state.accounting.mappings.ACCOUNTS_RECEIVABLE, state.accounting.mappings.ACCOUNTS_PAYABLE].includes(Number(account.id))));
  return `<option value="">Select account</option>${accounts.map(account => `<option value="${account.id}">${escapeHtml(account.code)} - ${escapeHtml(account.name)}</option>`).join('')}`;
}

function renderCashVoucherSetup(type) {
  const method = byId(`${type}VoucherMethod`); const methodValue = method.value;
  method.innerHTML = `<option value="">Select cash / bank</option>${(state.accounting.paymentMethods || []).map(item => `<option value="${item.id}">${escapeHtml(item.code)} - ${escapeHtml(item.name)}</option>`).join('')}`;
  if ([...method.options].some(option => option.value === methodValue)) method.value = methodValue;
  const currency = byId(`${type}VoucherCurrency`); const currencyValue = currency.value;
  currency.innerHTML = state.accounting.currencies.map(item => `<option value="${item.id}">${escapeHtml(item.code)} - ${escapeHtml(item.name)}</option>`).join('');
  const baseCurrency = state.accounting.currencies.find(item => Number(item.is_base));
  currency.value = [...currency.options].some(option => option.value === currencyValue) ? currencyValue : String(baseCurrency?.id || '');
  const account = byId(`${type}VoucherAccount`); const accountValue = account.value;
  account.innerHTML = cashVoucherAccountOptions();
  const preferredAccount = type === 'receipt' ? state.accounting.mappings.ACCOUNTS_RECEIVABLE : state.accounting.mappings.ACCOUNTS_PAYABLE;
  account.value = [...account.options].some(option => option.value === accountValue) ? accountValue : String(preferredAccount || '');
  updateCashVoucherCurrency(type); updateCashVoucherParty(type); updateCashVoucherBankFee(type); updateCashVoucherPreview(type);
  if (!byId(`${type}VoucherNumber`).value) refreshCashVoucherNumber(type);
}

function updateCashVoucherCurrency(type) {
  const currencyId = Number(byId(`${type}VoucherCurrency`).value);
  const currency = state.accounting.currencies.find(item => Number(item.id) === currencyId);
  const rate = byId(`${type}VoucherRate`); const isBase = Boolean(Number(currency?.is_base));
  rate.readOnly = isBase; rate.classList.toggle('locked-rate', isBase);
  if (isBase) rate.value = '1.000000'; else if (!(Number(rate.value) > 0)) rate.value = '1.000000';
}

function updateCashVoucherParty(type) {
  const accountId = Number(byId(`${type}VoucherAccount`).value); const party = byId(`${type}VoucherParty`);
  const label = byId(`${type}VoucherPartyLabel`); const empty = label.querySelector('.voucher-party-none');
  const receivable = accountId === Number(state.accounting.mappings.ACCOUNTS_RECEIVABLE);
  const payable = accountId === Number(state.accounting.mappings.ACCOUNTS_PAYABLE);
  const parties = receivable ? state.accounting.customers : payable ? state.accounting.suppliers : [];
  party.dataset.partyType = receivable ? 'customer' : payable ? 'supplier' : '';
  party.innerHTML = `<option value="">Select ${receivable ? 'customer' : payable ? 'supplier' : 'party'}</option>${parties.map(item => `<option value="${item.id}">${escapeHtml(item.code)} - ${escapeHtml(item.name)}</option>`).join('')}`;
  const partyRequired = receivable || payable;
  party.hidden = !partyRequired; party.required = partyRequired; empty.hidden = partyRequired;
  label.firstChild.textContent = receivable ? 'Customer' : payable ? 'Supplier' : 'Customer / Supplier';
}

function updateCashVoucherBankFee(type) {
  if (type !== 'payment') return;
  const method = state.accounting.paymentMethods.find(item => Number(item.id) === Number(byId('paymentVoucherMethod').value));
  const isSupplierPayment = Number(byId('paymentVoucherAccount').value) === Number(state.accounting.mappings.ACCOUNTS_PAYABLE);
  const eligible = method?.method_type === 'BANK' && isSupplierPayment;
  const configured = eligible && Number(method.bank_fee_account_id);
  const label = byId('paymentVoucherBankFeeLabel'); const input = byId('paymentVoucherBankFee');
  label.hidden = !eligible; input.disabled = !configured;
  if (!eligible) input.value = '0';
  byId('paymentVoucherBankFeeAccount').textContent = !eligible ? '' : configured
    ? `Posts to ${method.bank_fee_account_code} - ${method.bank_fee_account_name}`
    : 'Configure a Bank Fees expense account for this bank before adding fees.';
  byId('paymentVoucherBankTotal').hidden = !eligible;
}

function updateCashVoucherPreview(type) {
  const amount = Number(byId(`${type}VoucherAmount`).value || 0);
  const rate = Math.round(Number(byId(`${type}VoucherRate`).value || 0) * 1000000) / 1000000;
  const baseAmount = Number.isFinite(amount * rate) ? Math.round(amount * rate * 10000) / 10000 : 0;
  byId(`${type}VoucherBaseAmount`).textContent = `${baseAmount.toFixed(4)} SDG`;
  if (type === 'payment') {
    const fee = Number(byId('paymentVoucherBankFee').value || 0);
    const totalBase = Number.isFinite((amount + fee) * rate) ? Math.round((amount + fee) * rate * 10000) / 10000 : 0;
    byId('paymentVoucherBankTotal').querySelector('strong').textContent = `${totalBase.toFixed(4)} SDG`;
  }
}

async function refreshCashVoucherNumber(type) {
  if (!state.currentUser) return;
  try { byId(`${type}VoucherNumber`).value = await window.appBridge.getNextVoucherNumber(type, byId(`${type}VoucherDate`).value); }
  catch (error) { byId(`${type}VoucherMessage`).textContent = readableError(error, 'Unable to generate the voucher number.'); }
}

async function resetCashVoucher(type) {
  byId(`${type}VoucherForm`).reset(); byId(`${type}VoucherDate`).value = new Date().toISOString().slice(0, 10);
  await clearRecordImages(type); byId(`${type}VoucherMessage`).textContent = ''; byId(`${type}VoucherNumber`).value = '';
  renderCashVoucherSetup(type);
}

async function saveCashVoucher(event, type) {
  event.preventDefault(); const capitalized = type[0].toUpperCase() + type.slice(1);
  const party = byId(`${type}VoucherParty`); const button = event.submitter || event.currentTarget.querySelector('button[type=submit]'); button.disabled = true;
  byId(`${type}VoucherMessage`).textContent = '';
  try {
    const journal = await window.appBridge.createCashVoucher(type, { entryDate: byId(`${type}VoucherDate`).value,
      description: byId(`${type}VoucherDescription`).value.trim(), paymentMethodId: byId(`${type}VoucherMethod`).value,
      currencyId: byId(`${type}VoucherCurrency`).value, exchangeRateToBase: byId(`${type}VoucherRate`).value,
      amount: byId(`${type}VoucherAmount`).value, accountId: byId(`${type}VoucherAccount`).value,
      bankFeeAmount: type === 'payment' ? byId('paymentVoucherBankFee').value : 0,
      customerId: party.dataset.partyType === 'customer' ? party.value : null,
      supplierId: party.dataset.partyType === 'supplier' ? party.value : null,
      attachmentToken: state.recordImages[type].token });
    await resetCashVoucher(type); await loadAccounting(); showJournalView('history'); await showJournalDetails(journal.id);
  } catch (error) { byId(`${type}VoucherMessage`).textContent = readableError(error, `Unable to post the ${capitalized.toLowerCase()} voucher.`); }
  finally { button.disabled = false; }
}
async function loadAccounting() {
  state.accounting = await window.appBridge.getAccountingOverview();
  renderAccountingMetrics(); renderAccounts(); renderJournals(); renderReportAccountOptions();
  if (canViewScreen('journalAccount')) initializeManualJournalEditor();
  renderCashVoucherSetup('receipt'); renderCashVoucherSetup('payment');
}

function manualJournalAccountOptions() {
  const accounts = state.accounting.accounts.filter(account => account.is_active && (!account.is_control
    || [state.accounting.mappings.ACCOUNTS_RECEIVABLE, state.accounting.mappings.ACCOUNTS_PAYABLE].includes(Number(account.id))));
  return `<option value="">Select account</option>${accounts.map(account => `<option value="${account.id}">${escapeHtml(account.code)} - ${escapeHtml(account.name)}</option>`).join('')}`;
}

function manualJournalCurrencyOptions() {
  return state.accounting.currencies.map(currency => `<option value="${currency.id}">${escapeHtml(currency.code)} - ${escapeHtml(currency.name)}</option>`).join('');
}
function initializeManualJournalEditor() {
  if (!state.currentUser) return;
  if (!byId('manualJournalLines').children.length) { addManualJournalLine(); addManualJournalLine(); }
  if (!byId('manualJournalNumber').value) refreshManualJournalNumber();
  renderManualJournalAttachments(); updateManualJournalTotals();
}

async function refreshManualJournalNumber() {
  if (!state.currentUser) return;
  try { byId('manualJournalNumber').value = await window.appBridge.getNextManualJournalNumber(byId('manualJournalDate').value); }
  catch (error) { byId('manualJournalMessage').textContent = readableError(error, 'Unable to generate the journal number.'); }
}

function addManualJournalLine(initial = {}) {
  const baseCurrency = state.accounting.currencies.find(currency => Number(currency.is_base)) || state.accounting.currencies[0];
  const row = document.createElement('tr'); row.className = 'manual-journal-line';
  row.innerHTML = `<td><select class="manual-journal-account" aria-label="Account">${manualJournalAccountOptions()}</select></td>
    <td><select class="manual-journal-party" aria-label="Customer or supplier" hidden></select><span class="party-not-required">Not required</span></td>
    <td><input class="manual-journal-memo" maxlength="250" placeholder="Optional memo"></td>
    <td><select class="manual-journal-currency" aria-label="Currency">${manualJournalCurrencyOptions()}</select></td>
    <td><input class="manual-journal-rate number-input" type="number" min="0.000001" step="0.000001" placeholder="1.000000" aria-label="Currency rate to SDG"></td>
    <td><input class="manual-journal-debit number-input" type="number" min="0" step="0.0001" placeholder="0.0000" aria-label="Debit amount in selected currency"></td>
    <td><input class="manual-journal-credit number-input" type="number" min="0" step="0.0001" placeholder="0.0000" aria-label="Credit amount in selected currency"></td>
    <td><button type="button" class="remove-row remove-manual-journal-line" title="Remove line">&times;</button></td>`;
  byId('manualJournalLines').appendChild(row);
  row.querySelector('.manual-journal-account').value = initial.accountId || '';
  row.querySelector('.manual-journal-memo').value = initial.memo || '';
  row.querySelector('.manual-journal-currency').value = initial.currencyId || baseCurrency?.id || '';
  row.querySelector('.manual-journal-rate').value = initial.exchangeRateToBase || 1;
  row.querySelector('.manual-journal-debit').value = initial.debit || '';
  row.querySelector('.manual-journal-credit').value = initial.credit || '';
  updateManualJournalParty(row, initial.customerId || initial.supplierId || ''); enforceManualJournalAccountCurrency(row); updateManualJournalTotals();
}

function enforceManualJournalAccountCurrency(row) {
  const account = state.accounting.accounts.find(item => Number(item.id) === Number(row.querySelector('.manual-journal-account').value));
  const allowed = accountCurrencyIds(account); const select = row.querySelector('.manual-journal-currency');
  [...select.options].forEach(option => { option.disabled = allowed.length > 0 && !allowed.includes(Number(option.value)); });
  if (allowed.length === 1) { select.value = String(allowed[0]); select.disabled = true; }
  else { select.disabled = false; if (allowed.length && !allowed.includes(Number(select.value))) select.value = String(allowed[0]); }
  updateManualJournalCurrency(row);
}

function updateManualJournalCurrency(row) {
  const currencyId = Number(row.querySelector('.manual-journal-currency').value);
  const currency = state.accounting.currencies.find(item => Number(item.id) === currencyId);
  const rate = row.querySelector('.manual-journal-rate'); const isBase = Boolean(Number(currency?.is_base));
  rate.readOnly = isBase; rate.classList.toggle('locked-rate', isBase);
  if (isBase) rate.value = '1.000000';
  else if (!(Number(rate.value) > 0)) rate.value = '1.000000';
}
function updateManualJournalParty(row, selectedValue = '') {
  const accountId = Number(row.querySelector('.manual-journal-account').value);
  const select = row.querySelector('.manual-journal-party'); const empty = row.querySelector('.party-not-required');
  const receivable = accountId === Number(state.accounting.mappings.ACCOUNTS_RECEIVABLE);
  const payable = accountId === Number(state.accounting.mappings.ACCOUNTS_PAYABLE);
  const parties = receivable ? state.accounting.customers : payable ? state.accounting.suppliers : [];
  select.dataset.partyType = receivable ? 'customer' : payable ? 'supplier' : '';
  select.innerHTML = `<option value="">Select ${receivable ? 'customer' : payable ? 'supplier' : 'party'}</option>${parties.map(party => `<option value="${party.id}">${escapeHtml(party.code)} - ${escapeHtml(party.name)}</option>`).join('')}`;
  select.hidden = !parties.length; empty.hidden = Boolean(parties.length);
  if (parties.some(party => String(party.id) === String(selectedValue))) select.value = selectedValue;
}

function handleManualJournalAccountChange(event) {
  const row = event.target.closest('.manual-journal-line'); if (!row) return;
  if (event.target.classList.contains('manual-journal-account')) { updateManualJournalParty(row); enforceManualJournalAccountCurrency(row); }
  if (event.target.classList.contains('manual-journal-currency')) updateManualJournalCurrency(row);
  updateManualJournalTotals();
}

function handleManualJournalLineInput(event) {
  const row = event.target.closest('.manual-journal-line'); if (!row) return;
  if (event.target.classList.contains('manual-journal-debit') && Number(event.target.value) > 0) row.querySelector('.manual-journal-credit').value = '';
  if (event.target.classList.contains('manual-journal-credit') && Number(event.target.value) > 0) row.querySelector('.manual-journal-debit').value = '';
  updateManualJournalTotals();
}

function removeManualJournalLine(event) {
  const button = event.target.closest('.remove-manual-journal-line'); if (!button) return;
  button.closest('tr').remove();
  while (byId('manualJournalLines').children.length < 2) addManualJournalLine();
  updateManualJournalTotals();
}

function manualJournalSnapshot() {
  const rows = [...byId('manualJournalLines').querySelectorAll('.manual-journal-line')];
  let debitUnits = 0; let creditUnits = 0; let valid = rows.length >= 2;
  const lines = rows.map(row => {
    const accountId = Number(row.querySelector('.manual-journal-account').value) || null;
    const party = row.querySelector('.manual-journal-party'); const partyId = Number(party.value) || null;
    const currencyId = Number(row.querySelector('.manual-journal-currency').value) || null;
    const rawRate = Number(row.querySelector('.manual-journal-rate').value);
    const rate = Math.round(rawRate * 1000000) / 1000000;
    const debit = Number(row.querySelector('.manual-journal-debit').value || 0);
    const credit = Number(row.querySelector('.manual-journal-credit').value || 0);
    const debitTransactionUnits = Math.round(debit * 10000); const creditTransactionUnits = Math.round(credit * 10000);
    const debitLineUnits = Math.round((debitTransactionUnits / 10000) * rate * 10000);
    const creditLineUnits = Math.round((creditTransactionUnits / 10000) * rate * 10000);
    const amountValid = Number.isFinite(debit) && Number.isFinite(credit) && debit >= 0 && credit >= 0
      && ((debitTransactionUnits > 0) !== (creditTransactionUnits > 0)) && ((debitLineUnits > 0) !== (creditLineUnits > 0));
    const rateValid = Number.isFinite(rawRate) && Number.isFinite(rate) && rate > 0;
    const partyRequired = ['customer', 'supplier'].includes(party.dataset.partyType);
    valid = valid && Boolean(accountId) && Boolean(currencyId) && rateValid && amountValid && (!partyRequired || Boolean(partyId));
    debitUnits += Number.isFinite(debitLineUnits) ? debitLineUnits : 0;
    creditUnits += Number.isFinite(creditLineUnits) ? creditLineUnits : 0;
    return { accountId, currencyId, exchangeRateToBase: rate,
      customerId: party.dataset.partyType === 'customer' ? partyId : null,
      supplierId: party.dataset.partyType === 'supplier' ? partyId : null,
      memo: row.querySelector('.manual-journal-memo').value.trim(),
      debit: debitTransactionUnits / 10000, credit: creditTransactionUnits / 10000 };
  });
  valid = valid && /^\d{4}-\d{2}-\d{2}$/.test(byId('manualJournalDate').value)
    && Boolean(byId('manualJournalDescription').value.trim()) && debitUnits > 0 && debitUnits === creditUnits;
  return { lines, debitUnits, creditUnits, differenceUnits: debitUnits - creditUnits, valid };
}
function updateManualJournalTotals() {
  const snapshot = manualJournalSnapshot();
  byId('manualJournalDebitTotal').textContent = (snapshot.debitUnits / 10000).toFixed(4);
  byId('manualJournalCreditTotal').textContent = (snapshot.creditUnits / 10000).toFixed(4);
  byId('manualJournalDifference').textContent = `${(snapshot.differenceUnits / 10000).toFixed(4)} SDG`;
  const balanced = snapshot.debitUnits > 0 && snapshot.differenceUnits === 0;
  byId('manualJournalDifference').classList.toggle('positive-number', balanced);
  byId('manualJournalDifference').classList.toggle('negative-number', !balanced && snapshot.differenceUnits !== 0);
  byId('manualJournalBalanceStatus').textContent = snapshot.valid ? 'Balanced and ready to post.'
    : balanced ? 'Complete the date, narration, accounts, currencies, rates, and required parties.' : 'Converted debit and credit must match exactly in SDG.';
  byId('saveManualJournal').disabled = !snapshot.valid;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderManualJournalAttachments() {
  const selection = state.manualJournalAttachments; byId('manualJournalAttachments').hidden = !selection.files.length;
  byId('manualJournalAttachmentSummary').textContent = selection.files.length ? `${selection.files.length} file${selection.files.length === 1 ? '' : 's'} selected` : '';
  byId('manualJournalAttachmentList').innerHTML = selection.files.map(file => `<li><span>${escapeHtml(file.name)}</span><small>${formatFileSize(file.size)}</small></li>`).join('');
}

async function selectManualJournalAttachments() {
  try {
    const result = await window.appBridge.selectJournalAttachments(); if (result.canceled) return;
    if (state.manualJournalAttachments.token) await window.appBridge.releaseJournalAttachments(state.manualJournalAttachments.token);
    state.manualJournalAttachments = { token: result.token, files: result.files }; renderManualJournalAttachments();
  } catch (error) { byId('manualJournalMessage').textContent = readableError(error, 'Unable to select attachments.'); }
}

async function clearManualJournalAttachments() {
  if (state.manualJournalAttachments.token) await window.appBridge.releaseJournalAttachments(state.manualJournalAttachments.token);
  state.manualJournalAttachments = { token: null, files: [] }; renderManualJournalAttachments();
}

async function resetManualJournalForm(options = {}) {
  state.editingJournalId = null;
  if (options.release !== false) await clearManualJournalAttachments();
  else { state.manualJournalAttachments = { token: null, files: [] }; renderManualJournalAttachments(); }
  byId('manualJournalForm').reset(); byId('manualJournalDate').value = new Date().toISOString().slice(0, 10);
  byId('manualJournalLines').innerHTML = ''; addManualJournalLine(); addManualJournalLine();
  byId('manualJournalMessage').textContent = ''; await refreshManualJournalNumber(); updateManualJournalTotals();
}

async function saveManualJournal(event) {
  event.preventDefault(); const snapshot = manualJournalSnapshot();
  if (!snapshot.valid) { byId('manualJournalMessage').textContent = 'Complete every required field and balance debit and credit exactly.'; return; }
  const button = byId('saveManualJournal'); button.disabled = true; byId('manualJournalMessage').textContent = '';
  try {
    const input = { entryDate: byId('manualJournalDate').value,
      description: byId('manualJournalDescription').value.trim(), lines: snapshot.lines,
      attachmentToken: state.manualJournalAttachments.token };
    const journal = state.editingJournalId
      ? await window.appBridge.updateManualJournal(state.editingJournalId, input)
      : await window.appBridge.createManualJournal(input);
    await resetManualJournalForm({ release: false }); await loadAccounting();
    byId('manualJournalMessage').textContent = `${journal.entry_number} was balanced, posted, and saved.`;
    await showJournalDetails(journal.id);
  } catch (error) { byId('manualJournalMessage').textContent = readableError(error, 'Unable to post the journal entry.'); updateManualJournalTotals(); }
  finally { button.disabled = !manualJournalSnapshot().valid; }
}

async function viewJournalImageAttachment(event) {
  const button = event.target.closest('[data-view-journal-attachment]'); if (!button) return;
  button.disabled = true;
  try {
    const attachment = await window.appBridge.viewJournalImageAttachment(Number(button.dataset.journalId), Number(button.dataset.viewJournalAttachment));
    showAttachmentPreview(attachment);
  } catch (error) { alert(readableError(error, 'Unable to display the saved attachment.')); }
  finally { button.disabled = false; }
}
async function exportJournalAttachment(event) {
  const button = event.target.closest('[data-journal-attachment]'); if (!button) return;
  button.disabled = true;
  try { const result = await window.appBridge.exportJournalAttachment(Number(button.dataset.journalId), Number(button.dataset.journalAttachment));
    if (!result.canceled) byId('journalDetailSubtitle').textContent += ` - attachment saved to ${result.filePath}`;
  } catch (error) { alert(readableError(error, 'Unable to export the attachment.')); }
  finally { button.disabled = false; }
}
function updateReportStatementParties() {
  const type = byId('reportAccountPartyType').value;
  const select = byId('reportAccountParty'); const current = select.value;
  const parties = type === 'customer' ? state.accounting.customers : type === 'supplier' ? state.accounting.suppliers : [];
  select.disabled = !type;
  select.innerHTML = `<option value="">All ${type ? `${type}s` : 'parties'}</option>${parties.map(item =>
    `<option value="${item.id}">${escapeHtml(item.code || '')} - ${escapeHtml(item.name)}</option>`).join('')}`;
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

function clearAccountStatementFilters() {
  byId('reportAccountSearch').value = '';
  byId('reportAccountScope').value = 'descendants'; byId('reportAccountStatus').value = 'POSTED';
  byId('reportAccountSource').value = ''; byId('reportAccountMovement').value = '';
  byId('reportAccountCurrency').value = ''; byId('reportAccountPartyType').value = '';
  byId('reportAccountAmountBasis').value = 'base'; byId('reportAccountMinAmount').value = '';
  byId('reportAccountMaxAmount').value = ''; byId('reportAccountSort').value = 'asc';
  updateReportStatementParties();
}

function renderReportAccountOptions() {
  const select = byId('reportAccount'); const current = select.value;
  const accounts = state.accounting.accounts.filter(account => account.is_active);
  select.innerHTML = accounts.map(account => `<option value="${account.id}">${escapeHtml(account.code)} - ${escapeHtml(account.name)}${Number(account.is_control) ? ' (group)' : ''}</option>`).join('');
  if ([...select.options].some(option => option.value === current)) select.value = current;
  const currency = byId('reportAccountCurrency'); const currentCurrency = currency.value;
  currency.innerHTML = `<option value="">All currencies</option>${state.accounting.currencies.map(item =>
    `<option value="${item.id}">${escapeHtml(item.code)} - ${escapeHtml(item.name)}</option>`).join('')}`;
  if ([...currency.options].some(option => option.value === currentCurrency)) currency.value = currentCurrency;
  updateReportStatementParties();
}

function renderAccountingMetrics() {
  const roots = state.accounting.accounts.filter(account => account.parent_id == null);
  const balance = type => roots.filter(account => account.account_type === type).reduce((sum, account) => sum + Number(account.balance || 0), 0);
  byId('accountingAssets').textContent = formatMoney(balance('ASSET'));
  byId('accountingLiabilities').textContent = formatMoney(balance('LIABILITY'));
  byId('accountingEquity').textContent = formatMoney(balance('EQUITY'));
  byId('accountingRevenue').textContent = formatMoney(balance('REVENUE'));
  byId('accountingExpenses').textContent = formatMoney(balance('EXPENSE'));
}

function accountDepth(account, accountMap) {
  let depth = 0; let parent = account.parent_id;
  while (parent != null && accountMap.has(parent) && depth < 10) { depth += 1; parent = accountMap.get(parent).parent_id; }
  return depth;
}

function accountCurrencyIds(account) {
  return String(account?.currency_ids || '').split(',').map(Number).filter(Boolean);
}
function accountCurrencyLabels(account) {
  const ids = accountCurrencyIds(account);
  return state.accounting.currencies.filter(currency => ids.includes(Number(currency.id))).map(currency => currency.code).join(', ') || 'All';
}
function renderAccounts() {
  const query = byId('accountSearch').value.trim().toLowerCase(); const type = byId('accountTypeFilter').value;
  const accountMap = new Map(state.accounting.accounts.map(account => [account.id, account]));
  const rows = state.accounting.accounts.filter(account => (!type || account.account_type === type)
    && (!query || `${account.code} ${account.name}`.toLowerCase().includes(query)));
  byId('accountsTableBody').innerHTML = rows.map(account => `<tr data-account-id="${account.id}" class="clickable-row ${account.is_control ? 'control-account-row' : ''}"><td><strong>${escapeHtml(account.code)}</strong></td><td><div class="account-name" style="--account-depth:${accountDepth(account, accountMap)}">${account.is_control ? '<span class="tree-marker">v</span>' : '<span class="tree-marker">-</span>'}${escapeHtml(account.name)}${Number(account.is_bank) ? ' <span class="source-pill">BANK</span>' : ''}</div></td><td><span class="account-type type-${account.account_type.toLowerCase()}">${escapeHtml(account.account_type)}</span></td><td>${escapeHtml(accountCurrencyLabels(account))}</td><td class="number">${formatMoney(account.total_debit)}</td><td class="number">${formatMoney(account.total_credit)}</td><td class="number"><strong>${formatMoney(account.balance)} SDG</strong></td><td><button type="button" class="secondary compact-button" data-edit-account="${account.id}">Edit</button></td></tr>`).join('');
  byId('accountsEmpty').hidden = rows.length > 0;
}
function updateAccountBankFeeSelector() {
  const isBank = byId('accountBank').checked; const label = byId('accountBankFeeLabel'); const select = byId('accountBankFeeAccount');
  label.hidden = !isBank; select.required = isBank;
}
function openAccountDialog(accountId = null) {
  const account = state.accounting.accounts.find(item => Number(item.id) === Number(accountId));
  byId('accountForm').reset(); byId('accountId').value = account?.id || '';
  byId('accountDialogTitle').textContent = account ? `Edit ${account.code} - ${account.name}` : 'New account / bank';
  byId('accountCode').value = account?.code || ''; byId('accountName').value = account?.name || '';
  byId('accountType').value = account?.account_type || 'ASSET'; byId('accountDescription').value = account?.description || '';
  byId('accountControl').checked = Boolean(Number(account?.is_control)); byId('accountBank').checked = Boolean(Number(account?.is_bank));
  byId('accountBankFeeAccount').innerHTML = `<option value="">Select expense account</option>${state.accounting.accounts
    .filter(item => item.account_type === 'EXPENSE' && !Number(item.is_control) && Number(item.is_active))
    .map(item => `<option value="${item.id}">${escapeHtml(item.code)} - ${escapeHtml(item.name)}</option>`).join('')}`;
  byId('accountBankFeeAccount').value = account?.bank_fee_account_id || ''; updateAccountBankFeeSelector();
  byId('accountParent').innerHTML = `<option value="">No parent</option>${state.accounting.accounts.filter(item => Number(item.id) !== Number(accountId)).map(item => `<option value="${item.id}">${escapeHtml(item.code)} - ${escapeHtml(item.name)}</option>`).join('')}`;
  byId('accountParent').value = account?.parent_id || '';
  byId('accountCurrencies').innerHTML = state.accounting.currencies.map(item => `<option value="${item.id}">${escapeHtml(item.code)} - ${escapeHtml(item.name)}</option>`).join('');
  const selected = account ? accountCurrencyIds(account) : state.accounting.currencies.map(item => Number(item.id));
  [...byId('accountCurrencies').options].forEach(option => { option.selected = selected.includes(Number(option.value)); });
  byId('accountError').textContent = ''; byId('accountDialog').showModal(); byId('accountCode').focus();
}
async function saveAccount(event) {
  event.preventDefault();
  try {
    await window.appBridge.saveAccount({ id: byId('accountId').value, code: byId('accountCode').value, name: byId('accountName').value,
      accountType: byId('accountType').value, parentId: byId('accountParent').value,
      currencyIds: [...byId('accountCurrencies').selectedOptions].map(option => Number(option.value)),
      isControl: byId('accountControl').checked, isBank: byId('accountBank').checked,
      bankCode: byId('accountCode').value, bankFeeAccountId: byId('accountBankFeeAccount').value,
      description: byId('accountDescription').value });
    byId('accountDialog').close(); await Promise.all([loadAccounting(), loadSalesSetup()]);
  } catch (error) { byId('accountError').textContent = readableError(error, 'Unable to save the account.'); }
}

async function showAccountLedger(accountId) {
  const result = await window.appBridge.getAccountLedger(accountId); if (!result) return;
  byId('accountLedgerTitle').textContent = `${result.account.code} - ${result.account.name}`;
  byId('accountLedgerSubtitle').textContent = `${result.account.account_type} - ${result.account.normal_balance.toLowerCase()} normal balance${result.account.is_control ? ' - includes child accounts' : ''}`;
  byId('ledgerDebit').textContent = `${formatMoney(result.account.total_debit)} SDG`; byId('ledgerCredit').textContent = `${formatMoney(result.account.total_credit)} SDG`; byId('ledgerBalance').textContent = `${formatMoney(result.account.balance)} SDG`;
  let running = 0;
  byId('accountLedgerBody').innerHTML = result.lines.map(line => {
    running += result.account.normal_balance === 'DEBIT' ? Number(line.debit_base) - Number(line.credit_base) : Number(line.credit_base) - Number(line.debit_base);
    return `<tr data-journal-id="${line.journal_id}" class="clickable-row"><td>${escapeHtml(line.entry_date)}</td><td><strong>${escapeHtml(line.entry_number)}</strong></td><td><span class="source-pill">${escapeHtml(line.source_type)}</span></td><td>${escapeHtml(line.account_code)} - ${escapeHtml(line.account_name)}</td><td>${escapeHtml(line.memo || line.description)}</td><td class="number">${formatMoney(line.debit_base)}</td><td class="number">${formatMoney(line.credit_base)}</td><td class="number"><strong>${formatMoney(running)}</strong></td></tr>`;
  }).join('');
  byId('accountLedgerEmpty').hidden = result.lines.length > 0; byId('accountLedgerPanel').hidden = false;
  byId('accountLedgerPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderJournals() {
  const query = byId('journalSearch').value.trim().toLowerCase(); const source = byId('journalSourceFilter').value; const status = byId('journalStatusFilter').value;
  const rows = state.accounting.journals.filter(journal => (!source || journal.source_type === source) && (!status || journal.status === status)
    && (!query || `${journal.entry_number} ${journal.description} ${journal.search_text || ''}`.toLowerCase().includes(query)));
  byId('journalTableBody').innerHTML = rows.map(journal => {
    const editable = journal.source_type === 'MANUAL'; const removable = ['MANUAL', 'RECEIPT', 'PAYMENT'].includes(journal.source_type);
    return `<tr data-journal-id="${journal.id}" class="clickable-row"><td><strong>${escapeHtml(journal.entry_number)}</strong></td><td>${escapeHtml(journal.entry_date)}</td><td>${escapeHtml(journal.description)}</td><td><span class="source-pill">${escapeHtml(journal.source_type)}</span></td><td><span class="status-pill ${journal.status === 'POSTED' ? 'received' : ''}">${escapeHtml(journal.status)}</span></td><td class="number">${Number(journal.attachment_count) ? `${Number(journal.attachment_count)} file${Number(journal.attachment_count) === 1 ? '' : 's'}` : '-'}</td><td class="number">${formatMoney(journal.total_debit)}</td><td class="number">${formatMoney(journal.total_credit)}</td><td class="number ${Math.abs(Number(journal.difference)) >= .00005 ? 'negative-number' : 'positive-number'}">${formatMoney(journal.difference)}</td><td><div class="table-actions">${editable ? `<button type="button" class="secondary compact-button" data-edit-journal="${journal.id}">Edit</button>` : ''}${removable ? `<button type="button" class="danger compact-button" data-delete-journal="${journal.id}">Delete</button>` : '<small>Use source history</small>'}</div></td></tr>`;
  }).join('');
  byId('journalsEmpty').hidden = rows.length > 0;
}

async function editJournal(journalId) {
  const journal = await window.appBridge.getJournalDetails(journalId);
  if (!journal || journal.source_type !== 'MANUAL') return;
  await resetManualJournalForm(); state.editingJournalId = journalId; showJournalView('manual');
  byId('manualJournalDate').value = journal.entry_date; byId('manualJournalNumber').value = journal.entry_number;
  byId('manualJournalDescription').value = journal.description; byId('manualJournalLines').innerHTML = '';
  journal.lines.forEach(line => addManualJournalLine({ accountId: line.account_id, currencyId: line.currency_id,
    exchangeRateToBase: line.exchange_rate_to_base, customerId: line.customer_id, supplierId: line.supplier_id,
    memo: line.memo || '', debit: Number(line.debit_base) > 0 ? Math.abs(Number(line.transaction_amount)) : '',
    credit: Number(line.credit_base) > 0 ? Math.abs(Number(line.transaction_amount)) : '' }));
  byId('manualJournalMessage').textContent = journal.attachments?.length
    ? 'Editing this entry. Existing attachments are preserved unless you select replacements.'
    : 'Editing this journal entry.';
  updateManualJournalTotals();
}
async function deleteJournal(journalId) {
  if (!confirm('Delete this account-history entry? Its posted debit and credit will be removed.')) return;
  try { await window.appBridge.deleteJournal(journalId); byId('journalDetailPanel').hidden = true; await loadAccounting(); await renderDashboard(); }
  catch (error) { alert(readableError(error, 'Unable to delete the journal entry.')); }
}

async function showJournalDetails(journalId) {
  const journal = await window.appBridge.getJournalDetails(journalId); if (!journal) return;
  byId('journalDetailTitle').textContent = journal.entry_number;
  byId('journalDetailSubtitle').textContent = `${journal.entry_date} - ${journal.description} - created by ${journal.created_by_name}`;
  byId('journalDetailDebit').textContent = `${formatMoney(journal.total_debit)} SDG`; byId('journalDetailCredit').textContent = `${formatMoney(journal.total_credit)} SDG`; byId('journalDetailDifference').textContent = `${formatMoney(journal.difference)} SDG`;
  const balanced = Math.abs(Number(journal.difference)) < .00005; byId('journalBalanceStatus').textContent = balanced ? 'Balanced' : 'Out of balance'; byId('journalBalanceStatus').className = balanced ? 'balanced-label' : 'unbalanced-label';
  byId('journalDetailBody').innerHTML = journal.lines.map(line => { const party = line.customer_id ? `${line.customer_code} - ${line.customer_name}` : line.supplier_id ? `${line.supplier_code} - ${line.supplier_name}` : '-';
    return `<tr><td><strong>${escapeHtml(line.account_code)}</strong> - ${escapeHtml(line.account_name)}</td><td>${escapeHtml(party)}</td><td>${escapeHtml(line.memo || '-')}</td><td>${escapeHtml(line.transaction_currency || journal.currency_code)}</td><td class="number">${Number(line.exchange_rate_to_base || 1).toFixed(6)}</td><td class="number">${line.transaction_amount == null ? '-' : formatMoney(line.transaction_amount)}</td><td class="number">${formatMoney(line.debit_base)}</td><td class="number">${formatMoney(line.credit_base)}</td></tr>`; }).join('');
  const attachments = journal.attachments || []; byId('journalAttachmentPanel').hidden = !attachments.length;
  byId('journalAttachmentList').innerHTML = attachments.map(item => {
    const canPreview = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'].includes(String(item.mime_type || '').toLowerCase());
    const viewButton = canPreview ? `<button type="button" class="secondary compact-button" data-journal-id="${journal.id}" data-view-journal-attachment="${item.id}">View</button>` : '';
    return `<article><div><strong>${escapeHtml(item.original_name)}</strong><small>${escapeHtml(item.mime_type)} - ${formatFileSize(Number(item.file_size))}</small></div><span class="journal-attachment-actions">${viewButton}<button type="button" class="secondary compact-button" data-journal-id="${journal.id}" data-journal-attachment="${item.id}">Export</button></span></article>`;
  }).join('');
  const sourceButton = byId('journalOpenSource'); sourceButton.hidden = !['SALE', 'PURCHASE'].includes(journal.source_type); sourceButton.dataset.sourceType = journal.source_type; sourceButton.dataset.sourceId = journal.source_id || '';
  byId('journalDetailPanel').hidden = false; byId('journalDetailPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openJournalSource() {
  const source = byId('journalOpenSource').dataset.sourceType;
  if (source === 'SALE') { openPage('sales'); showSalesView('history'); }
  if (source === 'PURCHASE') { openPage('inventory'); showInventoryView('history'); }
}

function renderInventory() {
  const query = byId('inventorySearch').value.trim().toLowerCase();
  const warehouse = byId('inventoryWarehouse').value;
  const rows = state.inventory.filter(row => (!warehouse || String(row.warehouse_id) === warehouse)
    && (!query || `${row.product_name} ${row.sku || ''} ${row.barcode || ''} ${row.category_name}`.toLowerCase().includes(query)));
  const distinctProducts = new Set(rows.map(row => row.product_id)).size;
  const totalUnits = rows.reduce((sum, row) => sum + Number(row.quantity_on_hand || 0), 0);
  const availableUnits = rows.reduce((sum, row) => sum + Number(row.quantity_available || 0), 0);
  const unavailableUnits = rows.reduce((sum, row) => sum + Number(row.quantity_reserved || 0)
    + Number(row.quantity_damaged || 0) + Number(row.quantity_salvage || 0), 0);
  const totalValue = rows.reduce((sum, row) => sum + Number(row.movement_value_base || 0), 0);
  byId('inventoryProductCount').textContent = distinctProducts;
  byId('inventoryUnitCount').textContent = formatQuantity(totalUnits);
  byId('inventoryAvailableCount').textContent = formatQuantity(availableUnits);
  byId('inventoryUnavailableCount').textContent = formatQuantity(unavailableUnits);
  byId('inventoryValue').textContent = `${formatMoney(totalValue)} SDG`;
  byId('manageCategories').hidden = !canManageUsers();
  byId('inventoryTableBody').innerHTML = rows.map(row => `<tr data-product-id="${row.product_id}" class="clickable-row"><td><strong>${escapeHtml(row.product_name)}</strong><small class="cell-subtitle">${escapeHtml([row.sku, row.barcode].filter(Boolean).join(' | ') || row.unit_name)}</small></td><td>${escapeHtml(row.category_name)}</td><td>${escapeHtml(row.warehouse_name)}</td><td class="number status-available">${formatQuantity(row.quantity_available)}</td><td class="number">${formatQuantity(row.quantity_reserved)}</td><td class="number status-damaged">${formatQuantity(row.quantity_damaged)}</td><td class="number status-salvage">${formatQuantity(row.quantity_salvage)}</td><td class="number status-disposed">${formatQuantity(row.quantity_disposed)}</td><td class="number"><strong>${formatQuantity(row.quantity_on_hand)}</strong></td><td class="number">${formatMoney(row.movement_value_base)} SDG</td></tr>`).join('');
  byId('inventoryEmpty').hidden = rows.length > 0;
}

function inventoryStatusActions(status) {
  return {
    AVAILABLE: [['MARK_DAMAGED', 'Mark damaged'], ['RESERVE', 'Reserve']],
    RESERVED: [['RELEASE_RESERVE', 'Release reserve']],
    DAMAGED: [['MOVE_TO_SALVAGE', 'Move to salvage'], ['REPAIR', 'Repair to available'], ['DISPOSE_DAMAGED', 'Dispose']],
    SALVAGE: [['DISPOSE_SALVAGE', 'Dispose']]
  }[status] || [];
}

async function showInventoryProduct(productId, scroll = true) {
  const details = await window.appBridge.getProductInventoryDetails(productId);
  if (!details) return;
  state.activeInventoryDetails = details;
  const product = details.product;
  byId('inventoryDetailTitle').textContent = product.name;
  byId('inventoryDetailSubtitle').textContent = `${product.sku || 'No SKU'} - ${product.parent_category_name ? `${product.parent_category_name} / ` : ''}${product.category_name} - ${product.unit_name}`;
  byId('inventoryProductBarcode').textContent = product.barcode || 'Not assigned';
  byId('editInventoryProduct').hidden = !canManageUsers();
  const summaryItems = [['Available', details.summary.available], ['Reserved', details.summary.reserved],
    ['Damaged', details.summary.damaged], ['Salvage', details.summary.salvage],
    ['Disposed', details.summary.disposed], ['Total on-hand', details.summary.total_on_hand]];
  byId('inventoryStatusSummary').innerHTML = summaryItems.map(([label, value]) => `<article><span>${label}</span><strong>${formatQuantity(value)}</strong></article>`).join('');
  byId('inventoryBalanceBody').innerHTML = details.balances.map((row, index) => {
    const actions = inventoryStatusActions(row.status);
    return `<tr data-balance-index="${index}"><td>${escapeHtml(row.warehouse_name)}</td><td><span class="inventory-status status-${row.status.toLowerCase()}">${escapeHtml(row.status)}</span></td><td>${escapeHtml(row.batch_code || '-')}</td><td>${escapeHtml(row.expiry_date || '-')}</td><td class="number"><strong>${formatQuantity(row.quantity)}</strong></td><td class="number">${formatMoney(row.unit_cost_base)} SDG</td><td class="number">${formatMoney(row.stock_value_base)} SDG</td><td><div class="table-actions">${actions.map(([action, label]) => `<button type="button" class="secondary compact-button" data-status-action="${action}">${label}</button>`).join('')}${row.status !== 'DISPOSED' ? '<button type="button" class="secondary compact-button" data-transfer-balance>Move</button>' : ''}${canManageUsers() && row.status !== 'DISPOSED' ? '<button type="button" class="secondary compact-button" data-edit-balance>Edit</button>' : ''}</div></td></tr>`;
  }).join('');
  byId('inventoryBalanceEmpty').hidden = details.balances.length > 0;
  byId('inventoryMovementBody').innerHTML = details.movements.map(row => `<tr><td>${escapeHtml(row.movement_date)}</td><td><span class="movement-pill ${Number(row.quantity_change) < 0 ? 'movement-out' : ''}">${escapeHtml(row.movement_type.replaceAll('_', ' '))}</span></td><td><span class="inventory-status status-${String(row.inventory_status).toLowerCase()}">${escapeHtml(row.inventory_status)}</span></td><td>${escapeHtml(row.related_status || '-')}</td><td>${escapeHtml(row.warehouse_name)}</td><td>${escapeHtml([row.batch_code, row.expiry_date].filter(Boolean).join(' / ') || '-')}</td><td>${escapeHtml(row.reference_code || '-')}</td><td class="number ${Number(row.quantity_change) < 0 ? 'negative-number' : 'positive-number'}">${Number(row.quantity_change) > 0 ? '+' : ''}${formatQuantity(row.quantity_change)}</td><td class="number">${formatMoney(row.unit_cost_base)} SDG</td></tr>`).join('');
  byId('inventoryMovementEmpty').hidden = details.movements.length > 0;
  byId('inventoryDetail').hidden = false;
  if (scroll) byId('inventoryDetail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function selectedInventoryBalance(event) {
  const tr = event.target.closest('[data-balance-index]');
  return tr ? state.activeInventoryDetails?.balances[Number(tr.dataset.balanceIndex)] : null;
}
function handleInventoryBalanceAction(event) {
  const row = selectedInventoryBalance(event); if (!row) return;
  const statusButton = event.target.closest('[data-status-action]');
  if (statusButton) return openInventoryStatus(row, statusButton.dataset.statusAction);
  if (event.target.closest('[data-transfer-balance]')) return openInventoryTransfer(row);
  if (event.target.closest('[data-edit-balance]')) return openInventoryRowEditor(row);
}
function openInventoryStatus(row, action) {
  const product = state.activeInventoryDetails.product;
  byId('inventoryStatusForm').reset();
  byId('inventoryStatusProductId').value = product.id; byId('inventoryStatusWarehouseId').value = row.warehouse_id;
  byId('inventoryStatusSourceStatus').value = row.status; byId('inventoryStatusBatch').value = row.batch_code;
  byId('inventoryStatusExpiry').value = row.expiry_date; byId('inventoryStatusDate').value = new Date().toISOString().slice(0, 10);
  byId('inventoryStatusQuantity').max = row.quantity;
  byId('inventoryStatusAction').innerHTML = inventoryStatusActions(row.status).map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  byId('inventoryStatusAction').value = action; byId('inventorySalvageValueLabel').hidden = action !== 'MOVE_TO_SALVAGE';
  byId('inventoryStatusSubtitle').textContent = `${product.name}: ${formatQuantity(row.quantity)} ${row.status} at ${row.warehouse_name}`;
  byId('inventoryStatusMessage').textContent = ''; byId('inventoryStatusDialog').showModal();
}
async function saveInventoryStatus(event) {
  event.preventDefault(); byId('inventoryStatusMessage').textContent = '';
  try {
    const result = await window.appBridge.changeInventoryStatus({
      productId: byId('inventoryStatusProductId').value, warehouseId: byId('inventoryStatusWarehouseId').value,
      action: byId('inventoryStatusAction').value, operationDate: byId('inventoryStatusDate').value,
      quantity: byId('inventoryStatusQuantity').value, batchCode: byId('inventoryStatusBatch').value,
      expiryDate: byId('inventoryStatusExpiry').value, salvageUnitValue: byId('inventoryStatusSalvageValue').value,
      notes: byId('inventoryStatusNotes').value
    });
    byId('inventoryStatusDialog').close(); await refreshInventoryWorkflows();
    alert(`${result.referenceCode} posted: ${formatQuantity(result.quantity)} moved from ${result.fromStatus} to ${result.toStatus}.`);
  } catch (error) { byId('inventoryStatusMessage').textContent = readableError(error, 'Unable to change inventory status.'); }
}
function openInventoryAdjustment() {
  const details = state.activeInventoryDetails; if (!details) return;
  byId('inventoryAdjustForm').reset(); byId('inventoryAdjustProductId').value = details.product.id;
  setOptions('inventoryAdjustWarehouse', details.warehouses, item => item.name);
  byId('inventoryAdjustDate').value = new Date().toISOString().slice(0, 10);
  byId('inventoryAdjustMessage').textContent = ''; byId('inventoryAdjustDialog').showModal();
}
async function saveInventoryAdjustment(event) {
  event.preventDefault(); byId('inventoryAdjustMessage').textContent = '';
  try {
    await window.appBridge.adjustInventory({
      productId: byId('inventoryAdjustProductId').value, warehouseId: byId('inventoryAdjustWarehouse').value,
      status: byId('inventoryAdjustStatus').value, direction: byId('inventoryAdjustDirection').value,
      quantity: byId('inventoryAdjustQuantity').value, unitCostBase: byId('inventoryAdjustCost').value,
      operationDate: byId('inventoryAdjustDate').value, batchCode: byId('inventoryAdjustBatch').value,
      expiryDate: byId('inventoryAdjustExpiry').value, notes: byId('inventoryAdjustNotes').value
    });
    byId('inventoryAdjustDialog').close(); await refreshInventoryWorkflows();
  } catch (error) { byId('inventoryAdjustMessage').textContent = readableError(error, 'Unable to adjust inventory.'); }
}
function openInventoryRowEditor(row) {
  byId('inventoryEditForm').reset();
  byId('inventoryEditProductId').value = row.product_id; byId('inventoryEditWarehouseId').value = row.warehouse_id;
  byId('inventoryEditStatus').value = row.status; byId('inventoryEditOldBatch').value = row.batch_code;
  byId('inventoryEditOldExpiry').value = row.expiry_date; byId('inventoryEditBatch').value = row.batch_code;
  byId('inventoryEditExpiry').value = row.expiry_date; byId('inventoryEditCost').value = row.unit_cost_base;
  byId('inventoryEditDate').value = new Date().toISOString().slice(0, 10); byId('inventoryEditMessage').textContent = '';
  byId('inventoryEditDialog').showModal();
}
async function saveInventoryRowEdit(event) {
  event.preventDefault(); byId('inventoryEditMessage').textContent = '';
  try {
    await window.appBridge.updateInventoryBalanceMeta({
      productId: byId('inventoryEditProductId').value, warehouseId: byId('inventoryEditWarehouseId').value,
      status: byId('inventoryEditStatus').value, batchCode: byId('inventoryEditOldBatch').value,
      expiryDate: byId('inventoryEditOldExpiry').value, newBatchCode: byId('inventoryEditBatch').value,
      newExpiryDate: byId('inventoryEditExpiry').value, unitCostBase: byId('inventoryEditCost').value,
      operationDate: byId('inventoryEditDate').value, notes: byId('inventoryEditNotes').value
    });
    byId('inventoryEditDialog').close(); await refreshInventoryWorkflows();
  } catch (error) { byId('inventoryEditMessage').textContent = readableError(error, 'Unable to edit this stock row.'); }
}
function openInventoryTransfer(row) {
  byId('inventoryTransferForm').reset(); byId('inventoryTransferProductId').value = row.product_id;
  byId('inventoryTransferFromWarehouse').value = row.warehouse_id; byId('inventoryTransferStatus').value = row.status;
  byId('inventoryTransferBatch').value = row.batch_code; byId('inventoryTransferExpiry').value = row.expiry_date;
  setOptions('inventoryTransferToWarehouse', state.activeInventoryDetails.warehouses.filter(item => Number(item.id) !== Number(row.warehouse_id)), item => item.name, 'Select destination');
  byId('inventoryTransferQuantity').max = row.quantity; byId('inventoryTransferDate').value = new Date().toISOString().slice(0, 10);
  byId('inventoryTransferMessage').textContent = ''; byId('inventoryTransferDialog').showModal();
}
async function saveInventoryTransfer(event) {
  event.preventDefault(); byId('inventoryTransferMessage').textContent = '';
  try {
    await window.appBridge.transferInventory({
      productId: byId('inventoryTransferProductId').value, fromWarehouseId: byId('inventoryTransferFromWarehouse').value,
      toWarehouseId: byId('inventoryTransferToWarehouse').value, status: byId('inventoryTransferStatus').value,
      batchCode: byId('inventoryTransferBatch').value, expiryDate: byId('inventoryTransferExpiry').value,
      quantity: byId('inventoryTransferQuantity').value, operationDate: byId('inventoryTransferDate').value,
      notes: byId('inventoryTransferNotes').value
    });
    byId('inventoryTransferDialog').close(); await refreshInventoryWorkflows();
  } catch (error) { byId('inventoryTransferMessage').textContent = readableError(error, 'Unable to transfer inventory.'); }
}
function openInventoryProductEditor() {
  const product = state.activeInventoryDetails?.product; if (!product || !canManageUsers()) return;
  byId('inventoryProductForm').reset(); byId('inventoryProductId').value = product.id;
  byId('inventoryProductName').value = product.name; byId('inventoryProductSku').value = product.sku || '';
  byId('inventoryProductBarcodeField').value = product.barcode || '';
  setOptions('inventoryProductCategory', state.purchaseSetup.categories, item => item.parent_id ? `— ${item.name}` : item.name);
  setOptions('inventoryProductUnit', state.purchaseSetup.units, item => item.name);
  byId('inventoryProductCategory').value = product.category_id; byId('inventoryProductUnit').value = product.default_unit_id;
  byId('inventoryProductPrice').value = product.manual_sales_price ?? '';
  byId('inventoryProductMarkup').value = product.default_markup_percent ?? '';
  byId('inventoryProductMessage').textContent = ''; byId('inventoryProductDialog').showModal();
}
async function saveInventoryProduct(event) {
  event.preventDefault(); byId('inventoryProductMessage').textContent = '';
  try {
    await window.appBridge.updateProduct(byId('inventoryProductId').value, {
      name: byId('inventoryProductName').value, sku: byId('inventoryProductSku').value,
      categoryId: byId('inventoryProductCategory').value, unitId: byId('inventoryProductUnit').value,
      manualSalesPrice: byId('inventoryProductPrice').value, markupPercent: byId('inventoryProductMarkup').value
    });
    byId('inventoryProductDialog').close(); await loadPurchaseSetup(); await refreshInventoryWorkflows();
  } catch (error) { byId('inventoryProductMessage').textContent = readableError(error, 'Unable to update the product.'); }
}
function printInventoryBarcode() {
  const product = state.activeInventoryDetails?.product;
  const message = byId('barcodePrintMessage');
  if (!product?.barcode) {
    message.textContent = 'This product does not have a barcode.';
    byId('barcodePrintDialog').showModal();
    return;
  }
  byId('barcodePrintForm').reset();
  byId('barcodePrintProductId').value = product.id;
  byId('barcodePrintTitle').textContent = `Save labels for ${product.name}`;
  byId('barcodePrintBarcode').textContent = product.barcode;
  byId('barcodePrintCopies').value = 1;
  message.textContent = '';
  byId('barcodePrintDialog').showModal();
  setTimeout(() => { byId('barcodePrintCopies').focus(); byId('barcodePrintCopies').select(); }, 0);
}

async function saveInventoryBarcodePdf(event) {
  event.preventDefault();
  const productId = Number(byId('barcodePrintProductId').value);
  const copies = Number(byId('barcodePrintCopies').value);
  const message = byId('barcodePrintMessage');
  if (!productId) { message.textContent = 'Select a product before saving labels.'; return; }
  if (!Number.isInteger(copies) || copies < 1 || copies > 100) {
    message.textContent = 'Enter a whole number from 1 to 100.';
    return;
  }
  const button = byId('saveBarcodePdf');
  button.disabled = true;
  message.textContent = 'Opening the Save PDF dialog...';
  try {
    const result = await window.appBridge.printProductBarcode(productId, copies);
    if (result.canceled) {
      message.textContent = 'PDF save was canceled. You can try again.';
      return;
    }
    message.textContent = `Barcode-label PDF saved to ${result.filePath}`;
  } catch (error) {
    message.textContent = readableError(error, 'Unable to save the barcode-label PDF.');
  } finally { button.disabled = false; }
}

async function refreshInventoryWorkflows() {
  const productId = state.activeInventoryDetails?.product?.id;
  await Promise.all([loadInventory(), loadSalesSetup(), loadAccounting()]);
  if (productId) await showInventoryProduct(productId, false);
  await renderDashboard();
  if (state.activeReportId === 'inventory_valuation') await runActiveReport();
}
async function openCategoryManager() {
  if (!canManageUsers()) return;
  state.categories = await window.appBridge.listCategories(); renderCategories(); resetCategoryForm();
  byId('categoryDialog').showModal();
}
function renderCategories() {
  byId('categoryTableBody').innerHTML = state.categories.map(row => `<tr><td><strong>${escapeHtml(row.name)}</strong></td><td>${escapeHtml(row.parent_name || '-')}</td><td class="number">${Number(row.product_count)}</td><td class="number">${Number(row.child_count)}</td><td><div class="table-actions"><button type="button" class="secondary compact-button" data-edit-category="${row.id}">Edit</button><button type="button" class="danger compact-button" data-delete-category="${row.id}" ${Number(row.id) === 1 || Number(row.product_count) || Number(row.child_count) ? 'disabled' : ''}>Delete</button></div></td></tr>`).join('');
  setOptions('categoryParent', state.categories.filter(row => !row.parent_id && String(row.id) !== byId('categoryId').value), item => item.name, 'Top-level category');
}
function resetCategoryForm() {
  byId('categoryForm').reset(); byId('categoryId').value = ''; byId('categoryMessage').textContent = ''; renderCategories();
}
function handleCategoryAction(event) {
  const edit = event.target.closest('[data-edit-category]');
  if (edit) {
    const category = state.categories.find(row => Number(row.id) === Number(edit.dataset.editCategory));
    byId('categoryId').value = category.id; byId('categoryName').value = category.name; renderCategories();
    byId('categoryParent').value = category.parent_id || ''; return;
  }
  const remove = event.target.closest('[data-delete-category]');
  if (remove) deleteInventoryCategory(Number(remove.dataset.deleteCategory));
}
async function saveInventoryCategory(event) {
  event.preventDefault(); byId('categoryMessage').textContent = '';
  try {
    await window.appBridge.saveCategory({ id: byId('categoryId').value, name: byId('categoryName').value, parentId: byId('categoryParent').value });
    state.categories = await window.appBridge.listCategories(); resetCategoryForm(); await loadPurchaseSetup(); await loadInventory();
  } catch (error) { byId('categoryMessage').textContent = readableError(error, 'Unable to save the category.'); }
}
async function deleteInventoryCategory(id) {
  if (!confirm('Delete this unused category?')) return;
  try {
    state.categories = await window.appBridge.deleteCategory(id); resetCategoryForm(); await loadPurchaseSetup(); await loadInventory();
  } catch (error) { byId('categoryMessage').textContent = readableError(error, 'Unable to delete the category.'); }
}

function bindHrEvents() {
  document.querySelector('.hr-tabs').addEventListener('click', event => { const button = event.target.closest('[data-hr-view]'); if (button) showHrView(button.dataset.hrView); });
  byId('hrSubnav').addEventListener('click', event => { const button = event.target.closest('[data-hr-view]'); if (button) showHrView(button.dataset.hrView); });
  document.querySelector('[data-hr-toggle]').addEventListener('click', () => { byId('hrSubnav').hidden = !byId('hrSubnav').hidden; });
  byId('addEmployee').addEventListener('click', () => openEmployeeDialog());
  byId('addSalaryGrade').addEventListener('click', openSalaryGradeDialog);
  byId('salaryGradeForm').addEventListener('submit', saveSalaryGrade);
  byId('employeeForm').addEventListener('submit', saveEmployee);
  byId('addSalaryComponent').addEventListener('click', () => addSalaryComponentRow());
  byId('salaryComponentRows').addEventListener('click', event => { const button = event.target.closest('.remove-salary-component'); if (button) button.closest('.salary-component-row').remove(); });
  byId('employeeTableBody').addEventListener('click', event => {
    const edit = event.target.closest('[data-edit-employee]'); if (edit) openEmployeeDialog(Number(edit.dataset.editEmployee));
    const deactivate = event.target.closest('[data-deactivate-employee]'); if (deactivate) deactivateEmployee(Number(deactivate.dataset.deactivateEmployee));
  });
  byId('attendanceForm').addEventListener('submit', saveAttendance);
  byId('attendanceFilterEmployee').addEventListener('change', renderAttendance);
  byId('attendanceFrom').addEventListener('change', renderAttendance); byId('attendanceTo').addEventListener('change', renderAttendance);
  byId('attendanceTableBody').addEventListener('click', event => { const button = event.target.closest('[data-delete-attendance]'); if (button) deleteAttendance(Number(button.dataset.deleteAttendance)); });
  byId('leaveBalanceForm').addEventListener('submit', saveLeaveBalance);
  byId('leaveEntryForm').addEventListener('submit', saveLeaveEntry);
  byId('leaveEntryTableBody').addEventListener('click', event => { const button = event.target.closest('[data-delete-leave]'); if (button) deleteLeaveEntry(Number(button.dataset.deleteLeave)); });
  byId('createPayrollForm').addEventListener('submit', createPayrollRun);
  byId('payrollRunTableBody').addEventListener('click', event => { const button = event.target.closest('[data-open-payroll]'); if (button) openPayrollRun(Number(button.dataset.openPayroll)); });
  byId('payrollItemBody').addEventListener('input', event => { if (event.target.classList.contains('payroll-gross')) event.target.dataset.override = 'true'; if (event.target.classList.contains('payroll-net')) event.target.dataset.override = 'true'; updatePayrollPreview(); });
  byId('payrollItemBody').addEventListener('click', event => { const button = event.target.closest('[data-reset-payroll-formula]'); if (button) { const row = button.closest('tr'); delete row.querySelector('.payroll-gross').dataset.override; delete row.querySelector('.payroll-net').dataset.override; updatePayrollPreview(); } const slip = event.target.closest('[data-print-payslip]'); if (slip) printPayslip(Number(slip.dataset.printPayslip)); });
  byId('closePayrollEditor').addEventListener('click', () => { byId('payrollEditor').hidden = true; state.hr.activeRun = null; });
  byId('savePayroll').addEventListener('click', savePayrollRun);
  byId('finalizePayroll').addEventListener('click', finalizePayrollRun);
  byId('approvePayroll').addEventListener('click', () => decidePayrollRun('APPROVE'));
  byId('rejectPayroll').addEventListener('click', () => decidePayrollRun('REJECT'));
  byId('payrollDecisionForm').addEventListener('submit', submitPayrollDecision);
  byId('postPayroll').addEventListener('click', postPayrollRun);
}

function showHrView(view) {
  const selected = ['employees', 'attendance', 'payroll'].includes(view) ? view : 'employees';
  document.querySelectorAll('[data-hr-panel]').forEach(panel => { panel.hidden = panel.dataset.hrPanel !== selected; });
  document.querySelectorAll('.hr-tabs [data-hr-view]').forEach(button => button.classList.toggle('active', button.dataset.hrView === selected));
  document.querySelectorAll('#hrSubnav [data-hr-view]').forEach(button => button.classList.toggle('active', button.dataset.hrView === selected));
}

async function loadHr() {
  if (!state.currentUser) return;
  state.hr = { ...state.hr, ...(await window.appBridge.getHrData()) };
  const now = new Date();
  byId('payrollMonth').innerHTML = Array.from({ length: 12 }, (_, index) => `<option value="${index + 1}">${new Date(2000, index, 1).toLocaleString('en', { month: 'long' })}</option>`).join('');
  byId('payrollMonth').value = now.getMonth() + 1; byId('payrollYear').value = now.getFullYear();
  byId('attendanceDate').value ||= now.toISOString().slice(0, 10); byId('leaveBalanceYear').value ||= now.getFullYear();
  byId('leaveFrom').value ||= now.toISOString().slice(0, 10); byId('leaveTo').value ||= now.toISOString().slice(0, 10);
  byId('payrollWorkingDays').textContent = state.hr.workingDays;
  renderHrOptions(); renderEmployees(); renderAttendance(); renderLeave(); renderPayrollRuns();
}

function renderHrOptions() {
  const employees = state.hr.employees.map(row => `<option value="${row.id}">${escapeHtml(row.employee_code)} - ${escapeHtml(row.full_name)}</option>`).join('');
  ['attendanceEmployee', 'leaveBalanceEmployee', 'leaveEntryEmployee'].forEach(id => { const value = byId(id).value; byId(id).innerHTML = `<option value="">Select employee</option>${employees}`; byId(id).value = value; });
  const filter = byId('attendanceFilterEmployee').value; byId('attendanceFilterEmployee').innerHTML = `<option value="">All employees</option>${employees}`; byId('attendanceFilterEmployee').value = filter;
  const types = state.hr.leaveTypes.map(row => `<option value="${row.id}">${escapeHtml(row.name)}</option>`).join('');
  ['leaveBalanceType', 'leaveEntryType'].forEach(id => { const value = byId(id).value; byId(id).innerHTML = `<option value="">Select type</option>${types}`; byId(id).value = value; });
  byId('payrollPaymentMethod').innerHTML = `<option value="">Payment account</option>${state.hr.paymentMethods.map(row => `<option value="${row.id}">${escapeHtml(row.name)}</option>`).join('')}`;
  const grade = byId('employeeSalaryGrade').value; byId('employeeSalaryGrade').innerHTML = `<option value="">No grade</option>${state.hr.salaryGrades.map(row => `<option value="${row.id}">${escapeHtml(row.code)} - ${escapeHtml(row.name)}</option>`).join('')}`; byId('employeeSalaryGrade').value = grade;
}

function openSalaryGradeDialog() {
  byId('salaryGradeForm').reset(); byId('salaryGradeMinimum').value = '0'; byId('salaryGradeDefault').value = '0';
  byId('salaryGradeMessage').textContent = ''; byId('salaryGradeDialog').showModal(); byId('salaryGradeCode').focus();
}
async function saveSalaryGrade(event) {
  event.preventDefault(); const minimumSalary = numberValue(byId('salaryGradeMinimum')); const maximumText = byId('salaryGradeMaximum').value.trim();
  const maximumSalary = maximumText === '' ? null : numberValue(byId('salaryGradeMaximum')); const defaultBaseSalary = numberValue(byId('salaryGradeDefault'));
  if (maximumSalary !== null && maximumSalary < minimumSalary) { byId('salaryGradeMessage').textContent = 'Maximum salary must be greater than or equal to the minimum salary.'; return; }
  if (defaultBaseSalary < minimumSalary || (maximumSalary !== null && defaultBaseSalary > maximumSalary)) { byId('salaryGradeMessage').textContent = 'Default base salary must be within the salary band.'; return; }
  try {
    state.hr.salaryGrades = await window.appBridge.saveSalaryGrade({ code: byId('salaryGradeCode').value.trim(), name: byId('salaryGradeName').value.trim(), minimumSalary, maximumSalary, defaultBaseSalary });
    renderHrOptions(); byId('salaryGradeDialog').close();
  } catch (error) { byId('salaryGradeMessage').textContent = readableError(error, 'Unable to save the salary grade.'); }
}

function renderEmployees() {
  byId('employeeTableBody').innerHTML = state.hr.employees.map(employee => `<tr><td>${escapeHtml(employee.employee_code)}</td><td>${escapeHtml(employee.full_name)}</td><td>${escapeHtml(employee.department || '—')}</td><td>${escapeHtml(employee.job_title || '—')}</td><td><span class="status-pill ${employee.status}">${escapeHtml(employee.status)}</span></td><td>${formatMoney(employee.base_salary)} SDG</td><td class="table-actions"><button class="secondary" data-edit-employee="${employee.id}">Edit</button>${employee.status === 'active' ? `<button class="danger" data-deactivate-employee="${employee.id}">Deactivate</button>` : ''}</td></tr>`).join('');
  byId('employeesEmpty').hidden = state.hr.employees.length > 0;
}

function addSalaryComponentRow(component = {}) {
  const row = document.createElement('div'); row.className = 'salary-component-row';
  row.innerHTML = `<select class="salary-component-type"><option value="allowance">Allowance</option><option value="deduction">Deduction</option></select><input class="salary-component-name" maxlength="100" placeholder="Component name" required><input class="salary-component-amount" type="number" min="0" step="0.01" placeholder="Amount" required><button type="button" class="remove-row remove-salary-component">&times;</button>`;
  row.querySelector('.salary-component-type').value = component.type || 'allowance'; row.querySelector('.salary-component-name').value = component.name || ''; row.querySelector('.salary-component-amount').value = component.amount ?? '';
  byId('salaryComponentRows').append(row);
}

function openEmployeeDialog(employeeId = null) {
  byId('employeeForm').reset(); byId('salaryComponentRows').innerHTML = ''; byId('employeeMessage').textContent = ''; byId('employeeId').value = employeeId || '';
  byId('employeeDialogTitle').textContent = employeeId ? 'Edit Employee' : 'Add Employee'; byId('employeeHireDate').value = new Date().toISOString().slice(0, 10);
  if (employeeId) { const employee = state.hr.employees.find(row => Number(row.id) === employeeId); if (!employee) return;
    byId('employeeName').value = employee.full_name; byId('employeePhone').value = employee.phone || ''; byId('employeeEmail').value = employee.email || '';
    byId('employeeDepartment').value = employee.department || ''; byId('employeeJobTitle').value = employee.job_title || ''; byId('employeeType').value = employee.employment_type;
    byId('employeeHireDate').value = employee.hire_date; byId('employeeBaseSalary').value = employee.base_salary; byId('employeeSalaryGrade').value = employee.salary_grade_id || ''; byId('employeeNotes').value = employee.notes || '';
    state.hr.salaryComponents.filter(row => Number(row.employee_id) === employeeId && Number(row.is_active)).forEach(addSalaryComponentRow);
  }
  byId('employeeDialog').showModal();
}

async function saveEmployee(event) { event.preventDefault(); byId('employeeMessage').textContent = ''; try {
  const components = [...byId('salaryComponentRows').querySelectorAll('.salary-component-row')].map(row => ({ type: row.querySelector('.salary-component-type').value, name: row.querySelector('.salary-component-name').value, amount: row.querySelector('.salary-component-amount').value }));
  await window.appBridge.saveEmployee({ id: byId('employeeId').value, fullName: byId('employeeName').value, phone: byId('employeePhone').value, email: byId('employeeEmail').value, department: byId('employeeDepartment').value, jobTitle: byId('employeeJobTitle').value, salaryGradeId: byId('employeeSalaryGrade').value, employmentType: byId('employeeType').value, hireDate: byId('employeeHireDate').value, baseSalary: byId('employeeBaseSalary').value, notes: byId('employeeNotes').value, components });
  byId('employeeDialog').close(); await loadHr();
} catch (error) { byId('employeeMessage').textContent = readableError(error, 'Unable to save employee.'); } }

async function deactivateEmployee(id) { const employee = state.hr.employees.find(row => Number(row.id) === id); if (!employee || !confirm(`Deactivate ${employee.full_name}?`)) return; try { await window.appBridge.deactivateEmployee(id); await loadHr(); } catch (error) { alert(readableError(error, 'Unable to deactivate employee.')); } }

function renderAttendance() { const employeeId = Number(byId('attendanceFilterEmployee').value); const from = byId('attendanceFrom').value; const to = byId('attendanceTo').value; const rows = state.hr.attendance.filter(row => (!employeeId || Number(row.employee_id) === employeeId) && (!from || row.date >= from) && (!to || row.date <= to)); byId('attendanceTableBody').innerHTML = rows.map(row => `<tr><td>${escapeHtml(row.date)}</td><td>${escapeHtml(row.employee_code)} - ${escapeHtml(row.full_name)}</td><td><span class="status-pill ${row.status}">${escapeHtml(row.status.replace('_', ' '))}</span></td><td>${escapeHtml(row.notes || '—')}</td><td><button class="danger" data-delete-attendance="${row.id}">Delete</button></td></tr>`).join(''); byId('attendanceEmpty').hidden = rows.length > 0; }
async function saveAttendance(event) { event.preventDefault(); byId('attendanceMessage').textContent = ''; try { await window.appBridge.saveAttendance({ employeeId: byId('attendanceEmployee').value, date: byId('attendanceDate').value, status: byId('attendanceStatus').value, notes: byId('attendanceNotes').value }); byId('attendanceNotes').value = ''; await loadHr(); } catch (error) { byId('attendanceMessage').textContent = readableError(error, 'Unable to save attendance.'); } }
async function deleteAttendance(id) { if (!confirm('Delete this attendance record?')) return; await window.appBridge.deleteAttendance(id); await loadHr(); }

function renderLeave() { byId('leaveBalanceTableBody').innerHTML = state.hr.leaveBalances.map(row => `<tr><td>${row.year}</td><td>${escapeHtml(row.employee_code)} - ${escapeHtml(row.full_name)}</td><td>${escapeHtml(row.leave_type)}</td><td>${formatQuantity(row.allocated_days)}</td><td>${formatQuantity(row.used_days)}</td><td>${formatQuantity(row.remaining_days)}</td></tr>`).join(''); byId('leaveBalancesEmpty').hidden = state.hr.leaveBalances.length > 0; byId('leaveEntryTableBody').innerHTML = state.hr.leaveEntries.map(row => `<tr><td>${escapeHtml(row.date_from)} — ${escapeHtml(row.date_to)}</td><td>${escapeHtml(row.employee_code)} - ${escapeHtml(row.full_name)}</td><td>${escapeHtml(row.leave_type)}</td><td>${formatQuantity(row.days_count)}</td><td>${escapeHtml(row.reason || '—')}</td><td><button class="danger" data-delete-leave="${row.id}">Delete</button></td></tr>`).join(''); byId('leaveEntriesEmpty').hidden = state.hr.leaveEntries.length > 0; }
async function saveLeaveBalance(event) { event.preventDefault(); byId('leaveBalanceMessage').textContent = ''; try { await window.appBridge.saveLeaveBalance({ employeeId: byId('leaveBalanceEmployee').value, leaveTypeId: byId('leaveBalanceType').value, year: byId('leaveBalanceYear').value, allocatedDays: byId('leaveAllocated').value, usedDays: byId('leaveUsed').value }); await loadHr(); } catch (error) { byId('leaveBalanceMessage').textContent = readableError(error, 'Unable to save leave balance.'); } }
async function saveLeaveEntry(event) { event.preventDefault(); byId('leaveEntryMessage').textContent = ''; try { await window.appBridge.addLeaveEntry({ employeeId: byId('leaveEntryEmployee').value, leaveTypeId: byId('leaveEntryType').value, dateFrom: byId('leaveFrom').value, dateTo: byId('leaveTo').value, daysCount: byId('leaveDays').value, reason: byId('leaveReason').value }); byId('leaveDays').value = ''; byId('leaveReason').value = ''; await loadHr(); } catch (error) { byId('leaveEntryMessage').textContent = readableError(error, 'Unable to add leave entry.'); } }
async function deleteLeaveEntry(id) { if (!confirm('Delete this leave entry and reduce used days?')) return; await window.appBridge.deleteLeaveEntry(id); await loadHr(); }

function renderPayrollRuns() { byId('payrollRunTableBody').innerHTML = state.hr.payrollRuns.map(run => `<tr><td>${escapeHtml(run.reference)}</td><td>${String(run.period_month).padStart(2, '0')}/${run.period_year}</td><td><span class="status-pill ${run.status}">${escapeHtml(run.workflow_state || run.status)}</span></td><td>${formatMoney(run.total_gross)}</td><td>${formatMoney(run.total_deductions)}</td><td>${formatMoney(run.total_net)} SDG</td><td><button data-open-payroll="${run.id}">${run.status === 'posted' ? 'View' : 'Open'}</button></td></tr>`).join(''); byId('payrollRunsEmpty').hidden = state.hr.payrollRuns.length > 0; }
async function createPayrollRun(event) { event.preventDefault(); byId('payrollListMessage').textContent = ''; try { const run = await window.appBridge.createPayrollRun({ periodMonth: byId('payrollMonth').value, periodYear: byId('payrollYear').value }); await loadHr(); await openPayrollRun(run.id); } catch (error) { byId('payrollListMessage').textContent = readableError(error, 'Unable to create payroll run.'); } }
async function openPayrollRun(id) { const run = await window.appBridge.getPayrollRun(id); if (!run) return; state.hr.activeRun = run; byId('payrollEditor').hidden = false; byId('payrollEditorTitle').textContent = `${run.reference} — ${String(run.period_month).padStart(2, '0')}/${run.period_year}`; byId('payrollEditorStatus').textContent = run.workflow_state || run.status; byId('payrollEditorMessage').textContent = ''; renderPayrollItems(); byId('payrollEditor').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function payrollInput(name, value, disabled, extra = '') { return `<input class="${name}" type="number" min="0" step="0.01" value="${Number(value || 0).toFixed(2)}" ${disabled ? 'disabled' : ''} ${extra}>`; }
function renderPayrollItems() {
  const run = state.hr.activeRun; if (!run) return; const posted = run.status === 'posted'; const editable = ['DRAFT','REJECTED'].includes(run.workflow_state); const baseLocked = !editable;
  byId('payrollItemBody').innerHTML = run.items.map(item => {
    const formulaGross = Number(item.base_salary) + Number(item.allowances_total) + Number(item.overtime_amount) + Number(item.bonus_amount);
    const deductions = Number(item.absence_deduction) + Number(item.tax_amount) + Number(item.social_insurance_amount) + Number(item.other_deductions);
    const grossOverride = Math.abs(Number(item.gross_pay) - formulaGross) > 0.005;
    const netOverride = Math.abs(Number(item.net_pay) - (Number(item.gross_pay) - deductions)) > 0.005;
    const printButton = run.status === 'draft' ? '' : `<button type="button" class="secondary" data-print-payslip="${item.employee_id}">Print</button>`;
    return `<tr data-payroll-item="${item.id}" data-employee-id="${item.employee_id}"><td><strong>${escapeHtml(item.employee_code)}</strong><small>${escapeHtml(item.full_name)}</small></td><td>${payrollInput('payroll-base', item.base_salary, baseLocked)}</td><td>${payrollInput('payroll-allowances', item.allowances_total, baseLocked)}</td><td>${payrollInput('payroll-overtime', item.overtime_amount, !editable)}</td><td>${payrollInput('payroll-bonus', item.bonus_amount, !editable)}</td><td>${payrollInput('payroll-absence', item.absence_deduction, !editable)}</td><td>${payrollInput('payroll-tax', item.tax_amount, !editable)}</td><td>${payrollInput('payroll-social', item.social_insurance_amount, !editable)}</td><td>${payrollInput('payroll-other', item.other_deductions, !editable)}</td><td>${payrollInput('payroll-gross', item.gross_pay, !editable, grossOverride ? 'data-override="true"' : '')}</td><td>${payrollInput('payroll-net', item.net_pay, !editable, netOverride ? 'data-override="true"' : '')}</td><td><input class="payroll-notes" value="${escapeHtml(item.notes || '')}" ${editable ? '' : 'disabled'}></td><td>${printButton}${editable ? '<button type="button" class="secondary" data-reset-payroll-formula>Formula</button>' : ''}</td></tr>`;
  }).join('');
  byId('savePayroll').hidden = !editable || !hasCapability('payroll_prepare');
  byId('finalizePayroll').hidden = !editable || !hasCapability('payroll_submit');
  byId('approvePayroll').hidden = run.workflow_state !== 'SUBMITTED' || !hasCapability('payroll_approve');
  byId('rejectPayroll').hidden = run.workflow_state !== 'SUBMITTED' || !hasCapability('payroll_approve');
  byId('postPayroll').hidden = run.workflow_state !== 'APPROVED' || !hasCapability('payroll_payment_execute');
  byId('payrollPaymentMethod').hidden = run.workflow_state !== 'APPROVED' || !hasCapability('payroll_payment_execute'); updatePayrollPreview();
}
function collectPayrollItems() { return [...byId('payrollItemBody').querySelectorAll('[data-payroll-item]')].map(row => ({ id: Number(row.dataset.payrollItem), employeeId: Number(row.dataset.employeeId), baseSalary: numberValue(row.querySelector('.payroll-base')), allowancesTotal: numberValue(row.querySelector('.payroll-allowances')), overtimeAmount: numberValue(row.querySelector('.payroll-overtime')), bonusAmount: numberValue(row.querySelector('.payroll-bonus')), absenceDeduction: numberValue(row.querySelector('.payroll-absence')), taxAmount: numberValue(row.querySelector('.payroll-tax')), socialInsuranceAmount: numberValue(row.querySelector('.payroll-social')), otherDeductions: numberValue(row.querySelector('.payroll-other')), grossPay: numberValue(row.querySelector('.payroll-gross')), netPay: numberValue(row.querySelector('.payroll-net')), grossPayOverride: row.querySelector('.payroll-gross').dataset.override === 'true', netPayOverride: row.querySelector('.payroll-net').dataset.override === 'true', notes: row.querySelector('.payroll-notes').value })); }
function updatePayrollPreview() { let grossTotal = 0; let deductionTotal = 0; let netTotal = 0; byId('payrollItemBody').querySelectorAll('[data-payroll-item]').forEach(row => { const value = selector => numberValue(row.querySelector(selector)); const grossInput = row.querySelector('.payroll-gross'); const netInput = row.querySelector('.payroll-net'); const gross = grossInput.dataset.override === 'true' ? value('.payroll-gross') : value('.payroll-base') + value('.payroll-allowances') + value('.payroll-overtime') + value('.payroll-bonus'); const deductions = value('.payroll-absence') + value('.payroll-tax') + value('.payroll-social') + value('.payroll-other'); const net = netInput.dataset.override === 'true' ? value('.payroll-net') : gross - deductions; if (grossInput.dataset.override !== 'true') grossInput.value = gross.toFixed(2); if (netInput.dataset.override !== 'true') netInput.value = Math.max(0, net).toFixed(2); grossTotal += gross; deductionTotal += deductions; netTotal += Math.max(0, net); }); byId('payrollGrossTotal').textContent = `${formatMoney(grossTotal)} SDG`; byId('payrollDeductionTotal').textContent = `${formatMoney(deductionTotal)} SDG`; byId('payrollNetTotal').textContent = `${formatMoney(netTotal)} SDG`; }
async function savePayrollRun() { const run = state.hr.activeRun; if (!run) return; byId('payrollEditorMessage').textContent = ''; try { const saved = await window.appBridge.savePayrollRun(run.id, { items: collectPayrollItems() }); state.hr.activeRun = saved; await loadHr(); state.hr.activeRun = saved; renderPayrollItems(); } catch (error) { byId('payrollEditorMessage').textContent = readableError(error, 'Unable to save payroll.'); } }
async function finalizePayrollRun() { const run = state.hr.activeRun; if (!run || !confirm('Submit this payroll run for Financial Manager approval? It will be locked while pending.')) return; try { await window.appBridge.savePayrollRun(run.id, { items: collectPayrollItems() }); const saved = await window.appBridge.finalizePayrollRun(run.id); await loadHr(); state.hr.activeRun = saved; renderPayrollItems(); } catch (error) { byId('payrollEditorMessage').textContent = readableError(error, 'Unable to submit payroll.'); } }
function decidePayrollRun(action) {
  const run = state.hr.activeRun; if (!run) return;
  byId('payrollDecisionAction').value = action; byId('payrollDecisionTitle').textContent = action === 'REJECT' ? 'Reject Payroll' : 'Approve Payroll';
  byId('payrollDecisionSummary').textContent = `${run.reference} - ${formatMoney(run.net_total)} SDG`;
  byId('payrollDecisionComment').value = ''; byId('payrollDecisionComment').required = action === 'REJECT';
  byId('payrollDecisionMessage').textContent = ''; byId('payrollDecisionDialog').showModal();
}
async function submitPayrollDecision(event) {
  event.preventDefault(); const run = state.hr.activeRun; if (!run) return;
  const action = byId('payrollDecisionAction').value; const comment = byId('payrollDecisionComment').value.trim();
  if (action === 'REJECT' && !comment) { byId('payrollDecisionMessage').textContent = 'A rejection reason is required.'; return; }
  try {
    const saved = await window.appBridge.decidePayrollRun(run.id, action, comment); byId('payrollDecisionDialog').close();
    await loadHr(); state.hr.activeRun = saved; renderPayrollItems();
  } catch (error) { byId('payrollDecisionMessage').textContent = readableError(error, 'Unable to decide payroll.'); }
}
async function postPayrollRun() { const run = state.hr.activeRun; const paymentMethodId = byId('payrollPaymentMethod').value; if (!run || !paymentMethodId) { byId('payrollEditorMessage').textContent = 'Select the cash or bank account to credit.'; return; } if (!confirm(`Pay ${run.reference} and post it permanently to the journal?`)) return; try { const posted = await window.appBridge.postPayrollRun(run.id, paymentMethodId); await Promise.all([loadHr(), loadAccounting()]); state.hr.activeRun = posted; renderPayrollItems(); } catch (error) { byId('payrollEditorMessage').textContent = readableError(error, 'Unable to pay payroll.'); } }
function printPayslip(employeeId) { const run = state.hr.activeRun; const item = run?.items.find(row => Number(row.employee_id) === employeeId); if (!item) return; const logo = state.branding.logoDataUrl ? `<img src="${escapeHtml(state.branding.logoDataUrl)}" alt="">` : ''; const popup = window.open('', '_blank', 'width=800,height=900'); if (!popup) { alert('Allow popups to print the payslip.'); return; } popup.document.write(`<!doctype html><html><head><title>${escapeHtml(run.reference)} Payslip</title><style>body{font:14px Arial;color:#172033;padding:40px}header{display:flex;align-items:center;gap:12px}header img{width:54px;height:54px;object-fit:contain}h1{margin-bottom:4px}.meta{color:#64748b;margin-bottom:28px}table{width:100%;border-collapse:collapse}td{padding:10px;border-bottom:1px solid #ddd}td:last-child{text-align:right}.net{font-size:18px;font-weight:bold}footer{margin-top:28px;color:#6b7280;font-size:9px}button{margin-top:24px;padding:10px 18px}@media print{button{display:none}}</style></head><body><header>${logo}<h1>${escapeHtml(state.branding.businessName)}</h1></header><div class="meta">Payslip ${escapeHtml(run.reference)} · ${String(run.period_month).padStart(2, '0')}/${run.period_year}</div><h2>${escapeHtml(item.full_name)} <small>${escapeHtml(item.employee_code)}</small></h2><table><tr><td>Base salary</td><td>${formatMoney(item.base_salary)} SDG</td></tr><tr><td>Allowances</td><td>${formatMoney(item.allowances_total)} SDG</td></tr><tr><td>Overtime</td><td>${formatMoney(item.overtime_amount)} SDG</td></tr><tr><td>Bonus</td><td>${formatMoney(item.bonus_amount)} SDG</td></tr><tr><td>Gross pay</td><td>${formatMoney(item.gross_pay)} SDG</td></tr><tr><td>Absence deduction</td><td>-${formatMoney(item.absence_deduction)} SDG</td></tr><tr><td>Tax</td><td>-${formatMoney(item.tax_amount)} SDG</td></tr><tr><td>Social insurance</td><td>-${formatMoney(item.social_insurance_amount)} SDG</td></tr><tr><td>Other deductions</td><td>-${formatMoney(item.other_deductions)} SDG</td></tr><tr class="net"><td>Net pay</td><td>${formatMoney(item.net_pay)} SDG</td></tr></table><p>${escapeHtml(item.notes || '')}</p><footer>Powered by Holool Tech - Holool.tech</footer><button onclick="window.print()">Print payslip</button></body></html>`); popup.document.close(); }
async function loadBusinessBranding() {
  state.branding = await window.appBridge.getBusinessBranding(); state.brandingDraftLogo = null;
  byId('businessName').value = state.branding.businessName; byId('businessAddress').value = state.branding.address || '';
  byId('businessPhone').value = state.branding.phone || ''; byId('businessSecondaryPhone').value = state.branding.secondaryPhone || '';
  byId('businessEmail').value = state.branding.email || ''; byId('businessLogo').value = '';
  renderBusinessLogo();
}
function activeBusinessLogo() { return state.brandingDraftLogo === null ? state.branding.logoDataUrl : state.brandingDraftLogo; }
function renderBusinessLogo() {
  const logo = activeBusinessLogo(); const preview = byId('businessLogoPreview');
  preview.hidden = !logo; byId('businessLogoEmpty').hidden = Boolean(logo); byId('removeBusinessLogo').disabled = !logo;
  if (logo) preview.src = logo; else preview.removeAttribute('src');
}
function readImageFile(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '')); reader.onerror = () => reject(new Error('Unable to read the selected logo.')); reader.readAsDataURL(file); }); }
async function selectBusinessLogo() {
  const file = byId('businessLogo').files[0]; const message = byId('brandingSettingsMessage');
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
    byId('businessLogo').value = ''; message.textContent = 'Choose a PNG, JPEG, or WebP logo no larger than 2 MB.'; message.hidden = false; return;
  }
  try { state.brandingDraftLogo = await readImageFile(file); renderBusinessLogo(); message.hidden = true; }
  catch (error) { message.textContent = readableError(error, 'Unable to read the selected logo.'); message.hidden = false; }
}
function removeBusinessLogo() {
  state.brandingDraftLogo = ''; byId('businessLogo').value = ''; renderBusinessLogo();
  byId('brandingSettingsMessage').textContent = 'The logo will be removed when you save.'; byId('brandingSettingsMessage').hidden = false;
}
async function saveBusinessBranding(event) {
  event.preventDefault(); const message = byId('brandingSettingsMessage');
  try {
    state.branding = await window.appBridge.saveBusinessBranding({ businessName: byId('businessName').value.trim(),
      address: byId('businessAddress').value.trim(), phone: byId('businessPhone').value.trim(),
      secondaryPhone: byId('businessSecondaryPhone').value.trim(), email: byId('businessEmail').value.trim(), logoDataUrl: activeBusinessLogo() });
    state.brandingDraftLogo = null; byId('businessLogo').value = ''; renderBusinessLogo();
    message.textContent = 'PDF branding saved.'; message.hidden = false;
  } catch (error) { message.textContent = readableError(error, 'Unable to save PDF branding.'); message.hidden = false; }
}

function updatePermissionEditor() {
  const administrator = byId('newUserRole').value === ADMIN_ROLE;
  byId('userPermissions').disabled = administrator;
  byId('userCapabilities').disabled = administrator;
  byId('administratorAccessNote').hidden = !administrator;
}

const USER_PROFILE_DEFAULTS = Object.freeze({
  'System Administrator': { role: ADMIN_ROLE, permissions: {}, capabilities: [] },
  'Sales / Cashier': { role: 'Staff', permissions: { dashboard: 'view', sales: 'manage' }, capabilities: ['sale_create','sale_hold','sale_view_own','sale_reprint','sale_price_increase'] },
  'Procurement Manager': { role: 'Manager', permissions: { dashboard: 'view', inventory: 'manage', reports: 'view' }, capabilities: ['purchase_order_submit','purchase_order_view','purchase_order_create','purchase_order_edit','purchase_invoice_view','purchase_invoice_create','purchase_invoice_edit','purchase_invoice_submit','purchase_cost_manage','supplier_manage','product_create'] },
  'Warehouse Manager': { role: 'Manager', permissions: { dashboard: 'view', inventory: 'manage' }, capabilities: ['stock_quantity_view','goods_receipt_view','goods_receipt_confirm','goods_receipt_reject'] },
  'Pricing Manager': { role: 'Manager', permissions: { dashboard: 'view', inventory: 'manage', reports: 'view' }, capabilities: ['stock_quantity_view','pricing_cost_view','pricing_view','pricing_create','pricing_publish'] },
  'Treasury Manager': { role: 'Manager', permissions: { dashboard: 'view', inventory: 'view', treasury: 'manage', reports: 'view' }, capabilities: ['treasury_receipt_post', 'treasury_payment_post','purchase_disbursement_view','purchase_disbursement_execute'] },
  Accountant: { role: 'Manager', permissions: { dashboard: 'view', inventory: 'view', treasury: 'manage', journalAccount: 'manage', accounting: 'view', hr: 'view', reports: 'manage' }, capabilities: ['treasury_receipt_post','purchase_order_accounting_view','purchase_funding_view','purchase_disbursement_view','purchase_disbursement_create','payroll_payment_execute','sales_return_settle'] },
  'Financial Manager': { role: 'Manager', permissions: { dashboard: 'view', inventory: 'view', treasury: 'view', accounting: 'manage', hr: 'manage', reports: 'manage' }, capabilities: ['purchase_order_view','purchase_order_finance_approve','purchase_order_finance_reject','purchase_funding_view','purchase_funding_approve','purchase_funding_reject','employee_manage','payroll_prepare','payroll_submit','payroll_approve'] },
  'Commercial Manager': { role: 'Manager', permissions: { dashboard: 'view', sales: 'view', inventory: 'view', reports: 'view' }, capabilities: ['stock_quantity_view','pricing_cost_view','pricing_view','pricing_create','pricing_publish','sale_view_all','sales_return_create','sales_return_approve','supplier_view','purchase_order_view','purchase_order_commercial_approve','purchase_order_commercial_reject','purchase_invoice_view'] },
  'General Manager': { role: 'Manager', permissions: { dashboard: 'view', sales: 'view', inventory: 'view', treasury: 'view', journalAccount: 'view', accounting: 'view', hr: 'view', reports: 'view' }, capabilities: ['financial_reports_view','operational_reports_view','sensitive_cost_reports_view','hr_reports_view','sale_view_all','purchase_order_view','purchase_invoice_view','pricing_view','stock_cost_view'] },
  Staff: { role: 'Staff', permissions: { dashboard: 'view' }, capabilities: [] }
});

function applyUserProfileDefaults() {
  const defaults = USER_PROFILE_DEFAULTS[byId('newUserProfile').value]; if (!defaults) return;
  byId('newUserRole').value = defaults.role;
  document.querySelectorAll('#userPermissions [data-permission]').forEach(select => { select.value = defaults.permissions[select.dataset.permission] || ''; });
  document.querySelectorAll('#userCapabilities input[type="checkbox"]').forEach(input => { input.checked = defaults.capabilities.includes(input.value); });
  updatePermissionEditor();
}

function selectedUserPermissions() {
  return Object.fromEntries(
    Array.from(document.querySelectorAll('#userPermissions [data-permission]'))
      .map(select => [select.dataset.permission, select.value])
      .filter(([, level]) => level)
  );
}
function selectedUserCapabilities() { return Array.from(document.querySelectorAll('#userCapabilities input:checked')).map(input => input.value); }

function accessSummary(user) {
  if (user.role === ADMIN_ROLE) return '<span>Full access</span>';
  const entries = Object.entries(user.permissions || {});
  if (!entries.length) return '<span>No access</span>';
  const screens = entries.map(([screen, level]) => `<span>${escapeHtml(SCREEN_LABELS[screen] || screen)}: ${level === 'manage' ? 'Manage' : 'View'}</span>`);
  const capabilities = (user.capabilities || []).map(capability => `<span>${escapeHtml(capability.replaceAll('_', ' '))}</span>`);
  return [...screens, ...capabilities].join('');
}

function canManageUsers() { return state.currentUser?.role === ADMIN_ROLE; }
async function renderUsers() {
  const allowed = canManageUsers(); byId('adminOnlyContent').hidden = !allowed; byId('adminOnlyMessage').hidden = allowed; if (!allowed) return;
  state.users = await window.appBridge.listUsers(); byId('usersTableBody').innerHTML = state.users.map(user => {
    const protectedUser = user.id === 'admin' || user.id === state.currentUser?.id;
    const action = `<div class="table-actions"><button class="secondary compact-button" data-edit-user="${escapeHtml(user.id)}">Edit</button>${protectedUser ? `<span>${user.id === 'admin' ? 'Default administrator' : 'Current account'}</span>` : `<button class="danger compact-button" data-delete-user="${escapeHtml(user.id)}">Delete</button>`}</div>`;
    return `<tr><td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.role)}<small class="cell-subtitle">${escapeHtml(user.job_profile || 'Staff')}</small></td><td><div class="access-summary">${accessSummary(user)}</div></td><td>${action}</td></tr>`;
  }).join('');
}
async function addUser(event) {
  event.preventDefault(); if (!canManageUsers()) return;
  try {
    const role = byId('newUserRole').value;
    const input = { username: byId('newUsername').value.trim(), password: byId('newPassword').value, role,
      jobProfile: byId('newUserProfile').value, permissions: role === ADMIN_ROLE ? {} : selectedUserPermissions(),
      capabilities: role === ADMIN_ROLE ? [] : selectedUserCapabilities() };
    const editingId = byId('editingUserId').value;
    if (editingId) await window.appBridge.updateUser(editingId, input); else await window.appBridge.addUser(input);
    resetUserEditor(); byId('userFormError').textContent = '';
    await renderUsers();
  } catch (error) { byId('userFormError').textContent = readableError(error, 'Unable to add user.'); }
}
function editUser(userId) {
  const user = state.users.find(item => item.id === userId); if (!user) return;
  byId('editingUserId').value = user.id; byId('newUsername').value = user.username; byId('newPassword').value = '';
  byId('newUserRole').value = user.role; byId('newUserProfile').value = user.role === ADMIN_ROLE ? 'System Administrator' : (user.job_profile || 'Staff');
  document.querySelectorAll('#userPermissions [data-permission]').forEach(select => { select.value = user.permissions?.[select.dataset.permission] || ''; });
  document.querySelectorAll('#userCapabilities input[type="checkbox"]').forEach(input => { input.checked = user.capabilities?.includes(input.value); });
  byId('saveUserButton').textContent = 'Save user'; byId('cancelUserEdit').hidden = false; byId('userAdvancedSettings').open = false; updatePermissionEditor();
}
function resetUserEditor() {
  byId('userForm').reset(); byId('editingUserId').value = ''; byId('saveUserButton').textContent = 'Add user';
  byId('cancelUserEdit').hidden = true; byId('userAdvancedSettings').open = false; applyUserProfileDefaults();
}
async function deleteUser(userId) { const user = state.users.find(item => item.id === userId); if (!user || !confirm(`Delete user "${user.username}"?`)) return; try { await window.appBridge.deleteUser(userId); await renderUsers(); } catch (error) { byId('userFormError').textContent = readableError(error, 'Unable to delete user.'); } }

function numberValue(input, fallback = 0) { const value = Number(input.value); return Number.isFinite(value) ? value : fallback; }
function nullableNumber(input) { return input.value === '' ? null : numberValue(input); }
function formatMoney(value) { return window.i18n.formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function formatQuantity(value) { return window.i18n.formatNumber(value, { minimumFractionDigits: 0, maximumFractionDigits: 3 }); }
function readableError(error, fallback) {
  const message = String(error?.message || ''); if (!message) return fallback;
  const cleanMessage = message.match(/Error: (.+)$/)?.[1] || message;
  const floorError = cleanMessage.match(/PRICE_BELOW_FLOOR:.*below ([\d.]+) SDG/i);
  if (floorError) return window.i18n.t('The entered price is below the approved price of {price}.', { price: `${formatMoney(Number(floorError[1]))} SDG` });
  return cleanMessage;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }

document.addEventListener('localechange', renderTodayChip);
boot();
