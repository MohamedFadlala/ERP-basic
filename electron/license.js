'use strict';

// Offline licensing for Holool ERP Enterprise.
// - Licenses are Ed25519-signed payloads verified with licensing/public-key.pem.
// - The matching private key is NEVER part of this project (see production-handoff/README.txt).
// - A 7-day trial runs without activation; the trial record is integrity-protected,
//   stored redundantly, and guarded against clock rollback.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PRODUCT_ID = 'holool-erp';
const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 2 * 60 * 60 * 1000; // minor clock corrections are allowed
const ENFORCEMENT_INTERVAL_MS = 30 * 60 * 1000; // re-check while the app is running
const TRIAL_STATE_FILE = 'trial-state.json';
const LICENSE_FILE = 'license.lic';

let context = null;

function readMachineGuid() {
  if (process.platform !== 'win32') return '';
  try {
    const output = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const match = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
    return match ? match[1] : '';
  } catch { return ''; }
}

function firstMacAddress() {
  try {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses || []) {
        if (address && !address.internal && address.mac && address.mac !== '00:00:00:00:00:00') return address.mac;
      }
    }
  } catch { /* fall through to the remaining machine attributes */ }
  return '';
}

function machineMaterial() {
  return [readMachineGuid(), os.hostname(), os.cpus()?.[0]?.model || '', firstMacAddress(), PRODUCT_ID].join('|');
}

function formatInstallationId(material) {
  const hex = crypto.createHash('sha256').update(material, 'utf8').digest('hex').toUpperCase();
  return hex.slice(0, 32).replace(/(.{8})(?=.)/g, '$1-');
}

function trialStatePaths() {
  const paths = [path.join(context.userDataPath, TRIAL_STATE_FILE)];
  if (process.platform === 'win32' && process.env.ProgramData) {
    paths.push(path.join(process.env.ProgramData, 'HoloolERP', TRIAL_STATE_FILE));
  }
  return paths;
}

function sealTrialState(state) {
  const body = JSON.stringify({ firstRunAt: state.firstRunAt, lastSeenAt: state.lastSeenAt });
  const mac = crypto.createHmac('sha256', context.integrityKey).update(body, 'utf8').digest('hex');
  return `${body.slice(0, -1)},"mac":"${mac}"}`;
}

function readTrialState(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return { status: 'missing' }; }
  try {
    const parsed = JSON.parse(raw);
    const mac = String(parsed?.mac || '');
    const body = JSON.stringify({ firstRunAt: parsed.firstRunAt, lastSeenAt: parsed.lastSeenAt });
    const expected = crypto.createHmac('sha256', context.integrityKey).update(body, 'utf8').digest('hex');
    if (!mac || mac !== expected) return { status: 'tampered' };
    const firstRunAt = Date.parse(parsed.firstRunAt);
    const lastSeenAt = Date.parse(parsed.lastSeenAt);
    if (!Number.isFinite(firstRunAt) || !Number.isFinite(lastSeenAt) || lastSeenAt < firstRunAt) return { status: 'tampered' };
    return { status: 'ok', state: { firstRunAt, lastSeenAt } };
  } catch { return { status: 'tampered' }; }
}
function writeTrialState() {
  if (context.tampered) return; // never overwrite evidence of tampering with a fresh trial
  const sealed = sealTrialState(context.trial);
  for (const filePath of trialStatePaths()) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, sealed, 'utf8');
    } catch { /* secondary copies are best-effort */ }
  }
}

function reconcileTrialState() {
  const results = trialStatePaths().map(readTrialState);
  const valid = results.filter(result => result.status === 'ok').map(result => result.state);
  if (valid.length) {
    context.trial = {
      firstRunAt: Math.min(...valid.map(state => state.firstRunAt)),
      lastSeenAt: Math.max(...valid.map(state => state.lastSeenAt))
    };
    writeTrialState(); // restore any missing copy from a valid one
    return;
  }
  if (results.some(result => result.status === 'tampered')) {
    context.tampered = true;
    context.trial = { firstRunAt: 0, lastSeenAt: 0 };
    return;
  }
  const now = Date.now();
  context.trial = { firstRunAt: now, lastSeenAt: now };
  writeTrialState();
}

function touchTrial() {
  if (context.tampered) return;
  const now = Date.now();
  if (now > context.trial.lastSeenAt) {
    context.trial.lastSeenAt = now;
    writeTrialState();
  }
}

function trialDurationMs() {
  if (!context.isPackaged) {
    const raw = process.env.HOLOOL_TRIAL_DAYS;
    if (raw !== undefined && String(raw).trim() !== '') {
      const override = Number(raw);
      if (Number.isFinite(override) && override >= 0) return override * DAY_MS;
    }
  }
  return TRIAL_DAYS * DAY_MS;
}

function storedLicenseText() {
  try { return fs.readFileSync(path.join(context.userDataPath, LICENSE_FILE), 'utf8'); }
  catch { return null; }
}

function verifyLicenseKey(keyText) {
  const text = String(keyText || '').trim();
  const parts = text.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: 'The activation key format is invalid.' };
  let payload;
  let signature;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    signature = Buffer.from(parts[1], 'base64url');
  } catch { return { ok: false, error: 'The activation key could not be read.' }; }
  let signed = false;
  try { signed = crypto.verify(null, Buffer.from(parts[0], 'utf8'), context.publicKey, signature); }
  catch { return { ok: false, error: 'The activation key signature could not be verified.' }; }
  if (!signed) return { ok: false, error: 'The activation key signature is invalid.' };
  if (payload?.product !== PRODUCT_ID) return { ok: false, error: 'This activation key is for a different product.' };
  if (String(payload?.machineId || '').toUpperCase() !== context.installationId) {
    return { ok: false, error: 'This activation key belongs to a different computer.' };
  }
  if (!payload?.licenseId) return { ok: false, error: 'The activation key is missing its license ID.' };
  const expiresAt = payload.expiresAt ? String(payload.expiresAt) : null;
  if (expiresAt) {
    const expiry = Date.parse(`${expiresAt}T23:59:59.999Z`);
    if (!Number.isFinite(expiry)) return { ok: false, error: 'The activation key has an invalid expiry date.' };
    if (Date.now() > expiry) return { ok: false, error: 'This activation key has expired.', licenseExpired: true };
  }
  return {
    ok: true,
    license: {
      licenseId: String(payload.licenseId),
      customer: String(payload.customer || ''),
      issuedAt: String(payload.issuedAt || ''),
      expiresAt
    }
  };
}
function evaluate() {
  const stored = storedLicenseText();
  if (stored) {
    const result = verifyLicenseKey(stored);
    if (result.ok) return { state: 'LICENSED', license: result.license };
    if (result.licenseExpired) {
      return { state: 'EXPIRED', reason: 'Your software license has expired. Contact Holool Technology to renew it.' };
    }
    // A stored license that fails validation is ignored; the trial rules below apply.
  }
  if (context.tampered) {
    return { state: 'EXPIRED', reason: 'The trial information on this computer is invalid. Contact Holool Technology support.' };
  }
  const now = Date.now();
  const { firstRunAt, lastSeenAt } = context.trial;
  if (now + CLOCK_TOLERANCE_MS < lastSeenAt) {
    return { state: 'EXPIRED', reason: 'The system clock was moved backwards. Restore the correct date and time, then restart the application.' };
  }
  const effectiveNow = Math.max(now, lastSeenAt); // a rolled-back clock cannot extend the trial
  const endsAt = firstRunAt + trialDurationMs();
  if (effectiveNow >= endsAt) {
    return { state: 'EXPIRED', reason: 'Your 7-day trial has ended. Activate the application to continue.', trialEndsAt: new Date(endsAt).toISOString() };
  }
  const msLeft = endsAt - effectiveNow;
  return {
    state: 'TRIAL',
    trialEndsAt: new Date(endsAt).toISOString(),
    trialDaysLeft: Math.max(1, Math.ceil(msLeft / DAY_MS))
  };
}

function initialize({ userDataPath, isPackaged }) {
  const publicKeyPem = fs.readFileSync(path.join(__dirname, '..', 'licensing', 'public-key.pem'), 'utf8');
  const material = machineMaterial();
  context = {
    userDataPath,
    isPackaged: Boolean(isPackaged),
    publicKey: crypto.createPublicKey(publicKeyPem),
    installationId: formatInstallationId(material),
    integrityKey: crypto.createHash('sha256').update(`holool-trial-integrity|${material}`, 'utf8').digest(),
    trial: null,
    tampered: false,
    enforcementTimer: null
  };
  reconcileTrialState();
  touchTrial();
  return getStatus();
}

function getStatus() {
  return {
    installationId: context.installationId,
    trialDaysTotal: trialDurationMs() / DAY_MS,
    ...evaluate()
  };
}

function activate(keyText) {
  const result = verifyLicenseKey(keyText);
  if (!result.ok) return { ok: false, error: result.error, status: getStatus() };
  try {
    fs.mkdirSync(context.userDataPath, { recursive: true });
    fs.writeFileSync(path.join(context.userDataPath, LICENSE_FILE), String(keyText).trim(), 'utf8');
  } catch (error) {
    return { ok: false, error: `The license could not be saved on this computer: ${error.message}`, status: getStatus() };
  }
  return { ok: true, status: getStatus() };
}

function startEnforcement({ onExpired, intervalMs = ENFORCEMENT_INTERVAL_MS } = {}) {
  stopEnforcement();
  context.enforcementTimer = setInterval(() => {
    touchTrial();
    const status = getStatus();
    if (status.state === 'EXPIRED') {
      stopEnforcement();
      try { onExpired?.(status); } catch { /* the app is quitting anyway */ }
    }
  }, intervalMs);
  context.enforcementTimer.unref?.();
}

function stopEnforcement() {
  if (context?.enforcementTimer) {
    clearInterval(context.enforcementTimer);
    context.enforcementTimer = null;
  }
}

module.exports = { initialize, getStatus, activate, startEnforcement, stopEnforcement };
