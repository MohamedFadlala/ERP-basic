'use strict';

// Vendor-side activation key generator for Holool ERP Enterprise.
// This tool runs on the vendor's machine ONLY. The private key must never be
// copied into this project or shipped with the app (see production-handoff/README.txt).
//
// Usage:
//   node licensing/generate-license.js --key "D:\secure\private-key.pem" --machine "12345678-9ABCDEF0-12345678-9ABCDEF0" --id ERP-000001 --customer "Customer Name" [--days 365 | --expires 2027-12-31]
//
// The --machine value is the Installation ID shown on the application's activation screen.
// Without --days/--expires the license is perpetual.

const crypto = require('crypto');
const fs = require('fs');

const PRODUCT_ID = 'holool-erp';
const EXPECTED_FINGERPRINT = 'F21CAAA90A50AB20A5E51E8F2628DD8478A065DA01045C29C53D011709BFFB4C';

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`Missing value for --${name}`);
    args[name] = value;
    index += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.key) fail('--key <path to private-key.pem> is required.');
if (!args.machine) fail('--machine <Installation ID from the app activation screen> is required.');
if (!args.id) fail('--id <license ID, e.g. ERP-000001> is required.');
if (args.days !== undefined && args.expires !== undefined) fail('Use either --days or --expires, not both.');

const machineId = String(args.machine).trim().toUpperCase();
if (!/^[0-9A-F]{8}(-[0-9A-F]{8}){3}$/.test(machineId)) fail('The Installation ID must look like xxxxxxxx-xxxxxxxx-xxxxxxxx-xxxxxxxx (hex characters).');

let expiresAt = null;
if (args.expires !== undefined) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.expires) || !Number.isFinite(Date.parse(`${args.expires}T00:00:00Z`))) {
    fail('--expires must be a YYYY-MM-DD date.');
  }
  expiresAt = args.expires;
} else if (args.days !== undefined) {
  const days = Number(args.days);
  if (!Number.isFinite(days) || days <= 0) fail('--days must be a positive number.');
  expiresAt = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

let privateKey;
try { privateKey = crypto.createPrivateKey(fs.readFileSync(args.key, 'utf8')); }
catch (error) { fail(`Could not read the private key: ${error.message}`); }
if (privateKey.asymmetricKeyType !== 'ed25519') fail('The private key must be an Ed25519 key.');

const publicKey = crypto.createPublicKey(privateKey);
const fingerprint = crypto.createHash('sha256')
  .update(publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex').toUpperCase();

const payload = {
  licenseId: String(args.id),
  product: PRODUCT_ID,
  customer: String(args.customer || ''),
  machineId,
  issuedAt: new Date().toISOString().slice(0, 10),
  expiresAt
};

const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const signature = crypto.sign(null, Buffer.from(payloadSegment, 'utf8'), privateKey);
const activationKey = `${payloadSegment}.${signature.toString('base64url')}`;

// Self-check: the generated key must verify against the derived public key.
if (!crypto.verify(null, Buffer.from(payloadSegment, 'utf8'), publicKey, signature)) {
  fail('Internal error: the generated key did not verify.');
}

console.log('');
console.log(`License payload : ${JSON.stringify(payload)}`);
console.log(`Key fingerprint : ${fingerprint} ${fingerprint === EXPECTED_FINGERPRINT
  ? '(matches the production-handoff public key)'
  : '(WARNING: does NOT match the production-handoff fingerprint — the app will reject this key!)'}`);
console.log('');
console.log('Activation key (send this to the customer):');
console.log(activationKey);
