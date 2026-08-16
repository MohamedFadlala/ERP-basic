'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { getHardwareId } = require('./hardware-id');

const execFileAsync = promisify(execFile);
const TRIAL_LENGTH_MS = 7 * 24 * 60 * 60 * 1000;
const CLOCK_ROLLBACK_TOLERANCE_MS = 2 * 60 * 60 * 1000;
const REGISTRY_KEY = 'HKCU\\Software\\HoloolTech\\ERP';
const REGISTRY_VALUE = 'TrialData';

function emptyStatus(status, hardwareId) {
  return { status, hardwareId, trialStartedAt: null, trialEndsAt: null, trialDaysRemaining: 0, customer: null, licenseId: null };
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid license format.');
  const decoded = Buffer.from(value, 'base64url');
  if (!decoded.length || decoded.toString('base64url') !== value.replace(/=+$/, '')) throw new Error('Invalid license format.');
  return decoded;
}

function validDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }

class LicenseService {
  constructor({ app, safeStorage, publicKeyPath, now = () => new Date(), hardwareIdProvider = getHardwareId }) {
    this.app = app;
    this.safeStorage = safeStorage;
    this.publicKeyPath = publicKeyPath || path.join(__dirname, 'public-key.pem');
    this.now = now;
    this.hardwareIdProvider = hardwareIdProvider;
    this.licenseDirectory = path.join(app.getPath('userData'), 'licensing');
    this.licensePath = path.join(this.licenseDirectory, 'license.dat');
    this.trialPath = path.join(this.licenseDirectory, 'trial.dat');
    this.hardwareIdPromise = null;
  }

  getHardwareId() {
    if (!this.hardwareIdPromise) this.hardwareIdPromise = this.hardwareIdProvider().catch(error => { this.hardwareIdPromise = null; throw error; });
    return this.hardwareIdPromise;
  }

  encrypt(value) {
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable.');
    return this.safeStorage.encryptString(JSON.stringify(value)).toString('base64');
  }

  decrypt(value) { return JSON.parse(this.safeStorage.decryptString(Buffer.from(String(value || '').trim(), 'base64'))); }

  async writeSecureFile(filePath, value) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporaryPath, this.encrypt(value), { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(temporaryPath, filePath);
  }

  async readSecureFile(filePath) {
    try { return this.decrypt(await fs.promises.readFile(filePath, 'utf8')); }
    catch (error) { return error.code === 'ENOENT' ? null : { invalid: true }; }
  }

  async writeRegistryTrial(value) {
    await execFileAsync('reg.exe', ['ADD', REGISTRY_KEY, '/v', REGISTRY_VALUE, '/t', 'REG_SZ', '/d', this.encrypt(value), '/f'], { windowsHide: true, timeout: 10000 });
  }

  async readRegistryTrial() {
    try {
      const { stdout } = await execFileAsync('reg.exe', ['QUERY', REGISTRY_KEY, '/v', REGISTRY_VALUE], { windowsHide: true, timeout: 10000 });
      const match = String(stdout || '').match(/TrialData\s+REG_SZ\s+(.+)\s*$/im);
      return match ? this.decrypt(match[1]) : null;
    } catch (_error) { return null; }
  }

  async loadTrialRecords() {
    const records = await Promise.all([this.readSecureFile(this.trialPath), this.readRegistryTrial()]);
    return records.filter(record => record && !record.invalid && record.trialVersion === 1 && validDate(record.trialStartedAt) && validDate(record.lastRunAt));
  }

  async saveTrialRecord(record) {
    const results = await Promise.allSettled([this.writeSecureFile(this.trialPath, record), this.writeRegistryTrial(record)]);
    if (results.every(result => result.status === 'rejected')) throw new Error('The trial information could not be stored.');
  }

  async loadStoredLicense() {
    const stored = await this.readSecureFile(this.licensePath);
    if (!stored) return null;
    if (stored.invalid || typeof stored.licenseKey !== 'string') throw new Error('The stored license is unreadable.');
    return stored.licenseKey;
  }

  async verifyLicenseKey(licenseKey) {
    const key = String(licenseKey || '').trim();
    const sections = key.split('.');
    if (sections.length !== 3 || sections[0] !== 'ERP1') throw new Error('Invalid license format.');
    const payloadBytes = decodeBase64Url(sections[1]);
    const signatureBytes = decodeBase64Url(sections[2]);
    let publicKey;
    try { publicKey = await fs.promises.readFile(this.publicKeyPath); }
    catch (_error) { throw new Error('The license signature is invalid.'); }
    if (!crypto.verify(null, payloadBytes, publicKey, signatureBytes)) throw new Error('The license signature is invalid.');
    let payload;
    try { payload = JSON.parse(payloadBytes.toString('utf8')); }
    catch (_error) { throw new Error('Invalid license format.'); }
    if (payload.version !== 1 || payload.product !== 'holool-erp' || payload.licenseType !== 'perpetual') throw new Error(payload.product && payload.product !== 'holool-erp' ? 'This license is for another product.' : 'Invalid license format.');
    if (typeof payload.licenseId !== 'string' || !payload.licenseId.trim() || !validDate(payload.issuedAt)) throw new Error('Invalid license format.');
    const hardwareId = await this.getHardwareId();
    if (payload.hardwareId !== hardwareId) throw new Error('This license belongs to another computer.');
    return { licenseKey: key, payload };
  }

  async saveLicense(licenseKey) { await this.writeSecureFile(this.licensePath, { licenseKey: String(licenseKey).trim() }); }

  async activateLicense(licenseKey) {
    const verified = await this.verifyLicenseKey(licenseKey);
    try { await this.saveLicense(verified.licenseKey); await this.verifyLicenseKey(await this.loadStoredLicense()); }
    catch (_error) { try { await fs.promises.unlink(this.licensePath); } catch (_unlinkError) {} throw new Error('The license could not be stored.'); }
    return { success: true, customer: verified.payload.customer || '', licenseId: verified.payload.licenseId };
  }

  async startTrial() {
    const status = await this.getLicenseStatus({ updateLastRun: false });
    if (status.status !== 'not_started') throw new Error(status.status === 'trial_expired' ? 'Your trial has expired. Enter a permanent license to continue.' : 'The trial has already been started.');
    const timestamp = this.now().toISOString();
    await this.saveTrialRecord({ hardwareId: status.hardwareId, trialStartedAt: timestamp, lastRunAt: timestamp, trialVersion: 1 });
    return this.getLicenseStatus();
  }

  async getLicenseStatus({ updateLastRun = true } = {}) {
    const hardwareId = await this.getHardwareId();
    let storedLicense;
    try { storedLicense = await this.loadStoredLicense(); } catch (_error) { return emptyStatus('invalid', hardwareId); }
    if (storedLicense) {
      try { const verified = await this.verifyLicenseKey(storedLicense); return { ...emptyStatus('licensed', hardwareId), customer: verified.payload.customer || '', licenseId: verified.payload.licenseId }; }
      catch (_error) { return emptyStatus('invalid', hardwareId); }
    }
    const records = (await this.loadTrialRecords()).filter(record => record.hardwareId === hardwareId);
    if (!records.length) return emptyStatus('not_started', hardwareId);
    const trialStartedMs = Math.min(...records.map(record => Date.parse(record.trialStartedAt)));
    const lastRunMs = Math.max(...records.map(record => Date.parse(record.lastRunAt)));
    const nowMs = this.now().getTime();
    const trialEndsMs = trialStartedMs + TRIAL_LENGTH_MS;
    const status = { ...emptyStatus('trial', hardwareId), trialStartedAt: new Date(trialStartedMs).toISOString(), trialEndsAt: new Date(trialEndsMs).toISOString(), trialDaysRemaining: Math.max(0, Math.ceil((trialEndsMs - nowMs) / (24 * 60 * 60 * 1000))) };
    if (nowMs < lastRunMs - CLOCK_ROLLBACK_TOLERANCE_MS || nowMs >= trialEndsMs) return { ...status, status: 'trial_expired', trialDaysRemaining: 0 };
    if (updateLastRun) await this.saveTrialRecord({ hardwareId, trialStartedAt: status.trialStartedAt, lastRunAt: new Date(Math.max(nowMs, lastRunMs)).toISOString(), trialVersion: 1 });
    return status;
  }
}

module.exports = { LicenseService, TRIAL_LENGTH_MS, CLOCK_ROLLBACK_TOLERANCE_MS };
