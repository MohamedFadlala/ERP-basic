'use strict';

const hardwareId = document.getElementById('hardwareId');
const licenseKey = document.getElementById('licenseKey');
const statusMessage = document.getElementById('statusMessage');
const startTrial = document.getElementById('startTrial');
const actionButtons = [...document.querySelectorAll('button')];

function setBusy(busy) {
  actionButtons.forEach(button => { button.disabled = busy; });
}

function showMessage(message, type = '') {
  statusMessage.textContent = message || '';
  statusMessage.className = `status ${type}`.trim();
}

function describeStatus(status) {
  startTrial.hidden = status.status !== 'not_started';
  if (status.status === 'trial_expired') {
    return 'Your trial has expired. Enter a permanent license to continue.';
  }
  if (status.status === 'invalid') {
    return 'The stored license is invalid or unreadable. Enter a valid permanent license.';
  }
  if (status.status === 'not_started') {
    return 'This computer has not started its seven-day trial.';
  }
  return '';
}

async function refresh() {
  try {
    const status = await window.licenseAPI.getStatus();
    hardwareId.value = status.hardwareId;
    showMessage(describeStatus(status), status.status === 'not_started' ? '' : 'error');
  } catch (error) {
    hardwareId.value = 'Unavailable';
    showMessage(error.message || 'Unable to initialize licensing.', 'error');
    startTrial.hidden = true;
  }
}

document.getElementById('copyHardware').addEventListener('click', async () => {
  await window.licenseAPI.copyText(hardwareId.value);
  showMessage('Hardware ID copied.', 'success');
});

document.getElementById('pasteKey').addEventListener('click', async () => {
  licenseKey.value = (await window.licenseAPI.readClipboard()).trim();
});

document.getElementById('importFile').addEventListener('click', async () => {
  const result = await window.licenseAPI.importFile();
  if (result?.licenseKey) {
    licenseKey.value = result.licenseKey;
    showMessage('License file imported. Click Activate License to continue.');
  }
});

document.getElementById('activateLicense').addEventListener('click', async () => {
  setBusy(true);
  showMessage('Verifying license...');
  try {
    const result = await window.licenseAPI.activate(licenseKey.value);
    if (!result.success) throw new Error(result.error);
    showMessage('Activation successful. Opening Holool ERP...', 'success');
  } catch (error) {
    showMessage(error.message || 'Activation failed.', 'error');
    setBusy(false);
  }
});

startTrial.addEventListener('click', async () => {
  setBusy(true);
  showMessage('Starting your seven-day trial...');
  try {
    const result = await window.licenseAPI.startTrial();
    if (!result.success) throw new Error(result.error);
    showMessage('Trial started. Opening Holool ERP...', 'success');
  } catch (error) {
    showMessage(error.message || 'The trial could not be started.', 'error');
    setBusy(false);
  }
});

document.getElementById('exitApp').addEventListener('click', () => window.licenseAPI.exit());

refresh();
