# Licensing

Holool ERP Enterprise is protected by offline, Ed25519-signed licenses plus a
7-day free trial. Verification uses only Node's built-in `crypto` — there are
no external dependencies and no network calls.

## Files in this folder

- `public-key.pem` — the production public key copied from `production-handoff/`.
  SHA-256 of the DER-encoded SPKI must equal
  `F21CAAA90A50AB20A5E51E8F2628DD8478A065DA01045C29C53D011709BFFB4C`.
  This is the only key file packaged with the app (see `build.files` in `package.json`).
- `generate-license.js` — vendor-side activation key generator. It is **not**
  packaged with the app. The private key never enters this project
  (`production-handoff/README.txt`).

## Activation key format

```
<base64url(JSON payload)> . <base64url(Ed25519 signature)>
```

- The signature covers the exact payload-segment string (its UTF-8 bytes).
- Payload fields: `licenseId`, `product` (`"holool-erp"`), `customer`,
  `machineId` (Installation ID), `issuedAt` (YYYY-MM-DD), `expiresAt`
  (YYYY-MM-DD or `null` for a perpetual license).

## Activation flow

1. The app's activation screen shows the **Installation ID** of the computer
   (derived from the Windows MachineGuid, hostname, CPU and MAC address).
2. The customer sends the Installation ID to Holool Technology.
3. The vendor runs, on a machine holding the private key:

   ```bash
   node licensing/generate-license.js --key "D:\secure\private-key.pem" \
     --machine "12345678-9ABCDEF0-12345678-9ABCDEF0" --id ERP-000001 --customer "Customer Name" --days 365
   ```

4. The customer pastes the activation key into the app. The app verifies the
   signature, product, machine binding and expiry, then stores the key in
   `userData/license.lic` and re-verifies it on every start.

## Trial mechanics

- 7 days (7 x 24 h) starting from the first run.
- The trial record is written to two redundant locations
  (`userData/trial-state.json` and `%ProgramData%\HoloolERP\trial-state.json`)
  and integrity-protected with an HMAC-SHA256 keyed by the machine attributes.
- Clock rollback is detected via a `lastSeenAt` timestamp; a rolled-back clock
  cannot extend the trial, and large rollbacks end it.
- When the trial ends, the app refuses to start its database/web services and
  only shows the activation screen; if it ends mid-session, the app warns and
  closes (checked every 30 minutes).
- Development override (ignored in packaged builds): set the
  `HOLOOL_TRIAL_DAYS` environment variable, e.g. `HOLOOL_TRIAL_DAYS=0` to
  simulate an expired trial or `HOLOOL_TRIAL_DAYS=0.5` for 12 hours.
