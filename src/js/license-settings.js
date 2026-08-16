'use strict';

(() => {
  const api = window.softwareLicense;
  const section = document.getElementById('softwareLicenseSettings');
  if (!section) return;
  if (!api) {
    section.hidden = true;
    return;
  }

  const byId = id => document.getElementById(id);
  const buttons = ['softwareLicenseCopy', 'softwareLicensePaste', 'softwareLicenseImport', 'softwareLicenseActivate']
    .map(byId).filter(Boolean);

  function setBusy(busy) {
    buttons.forEach(button => { button.disabled = busy; });
  }

  function showMessage(message, error = false) {
    const element = byId('softwareLicenseMessage');
    element.textContent = message || '';
    element.classList.toggle('error', error);
  }

  function describe(status) {
    if (status.status === 'licensed') {
      return status.customer ? `Licensed to ${status.customer}.` : 'This software is permanently activated.';
    }
    if (status.status === 'trial') {
      const days = Number(status.trialDaysRemaining) || 0;
      return `Trial active - ${days} day${days === 1 ? '' : 's'} remaining.`;
    }
    if (status.status === 'trial_expired') return 'The trial has expired. Enter a permanent license to continue.';
    if (status.status === 'invalid') return 'The stored license is invalid or unreadable.';
    return 'This software is not activated.';
  }

  function renderTopStatus(status) {
    const counter = byId('softwareLicenseTopStatus');
    if (!counter) return;
    if (status.status === 'trial') {
      const days = Number(status.trialDaysRemaining) || 0;
      counter.textContent = `Trial: ${days} day${days === 1 ? '' : 's'} left`;
      counter.classList.remove('licensed');
      counter.hidden = false;
      return;
    }
    if (status.status === 'licensed') {
      counter.textContent = 'Licensed';
      counter.classList.add('licensed');
      counter.hidden = false;
      return;
    }
    counter.hidden = true;
  }

  async function refresh() {
    const status = await api.getStatus();
    renderTopStatus(status);
    byId('softwareLicenseHardwareId').value = status.hardwareId || '';
    byId('softwareLicenseStatus').textContent = describe(status);
    byId('softwareLicenseActivation').hidden = status.status === 'licensed';
    return status;
  }

  byId('softwareLicenseCopy').addEventListener('click', async () => {
    await api.copyText(byId('softwareLicenseHardwareId').value);
    showMessage('Hardware ID copied.');
  });

  byId('softwareLicensePaste').addEventListener('click', async () => {
    byId('softwareLicenseKey').value = (await api.readClipboard()).trim();
    showMessage('');
  });

  byId('softwareLicenseImport').addEventListener('click', async () => {
    try {
      const result = await api.importFile();
      if (result?.error) throw new Error(result.error);
      if (result?.licenseKey) {
        byId('softwareLicenseKey').value = result.licenseKey;
        showMessage('License file imported. Click Activate License to continue.');
      }
    } catch (error) {
      showMessage(error.message || 'The license file could not be imported.', true);
    }
  });

  byId('softwareLicenseActivate').addEventListener('click', async () => {
    const licenseKey = byId('softwareLicenseKey').value.trim();
    if (!licenseKey) {
      showMessage('Enter or import a license key first.', true);
      return;
    }
    setBusy(true);
    showMessage('Verifying license...');
    try {
      const result = await api.activate(licenseKey);
      if (!result?.success) throw new Error(result?.error || 'Activation failed.');
      byId('softwareLicenseKey').value = '';
      await refresh();
      showMessage('Activation successful.');
    } catch (error) {
      showMessage(error.message || 'Activation failed.', true);
    } finally {
      setBusy(false);
    }
  });

  refresh().catch(error => showMessage(error.message || 'Unable to load license status.', true));
})();
