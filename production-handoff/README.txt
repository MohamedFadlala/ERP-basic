Holool KDS production public-key handoff

The public-key.pem file in this folder is the only signing-key file that
Programmer 1 should add to the KDS application.

Expected SHA-256 fingerprint of the DER-encoded SPKI public key:
F21CAAA90A50AB20A5E51E8F2628DD8478A065DA01045C29C53D011709BFFB4C

Programmer 1 must:

1. Replace licensing/public-key.pem with this public-key.pem file.
2. Ensure Electron Builder includes licensing/public-key.pem.
3. Delete the old packaged build.
4. Rebuild and reinstall the KDS.
5. Confirm the public key inside the packaged app has the fingerprint above.
6. Retry the existing KDS-000001 license. It does not need to be regenerated.

Never send or copy private-key.pem to the KDS project.
