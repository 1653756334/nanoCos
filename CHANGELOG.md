# Changelog

## [v1.1.0] - 2026-11-06

### Security & Cryptography
- **Standard PBKDF2-SHA256 Password Hashing**: Upgraded admin password KDF to standard RFC 8018 (`crypto/pbkdf2`) with 600,000 iterations (`pbkdf2-sha256$600000$<hex>`) and transparent login-time migration from legacy hashes.
- **First-Run Random Admin Password & CLI Reset**: Removed hardcoded default credentials (`admin123`) and login-page credential hints; added 16-char random password generation on first boot, `cosd passwd` CLI subcommand, `-print-secret=false` flag, and online credential update (`PUT /api/v1/auth/account`).
- **S3 Signature V4 & V2 Hardening**: Implemented full HMAC-SHA1 S3 Signature V2 verification, ±15m clock skew & `X-Amz-Expires` expiration enforcement for S3 Signature V4, and query/header binding for presigned URLs.
- **Persistent Token Revocation & Anti-Bruteforce**: Persisted revoked admin tokens in SQLite (`revoked_tokens`), bounded `loginAttempts` map to 4096 entries, and restricted `X-Forwarded-For` trust to `-trust-proxy` or loopback proxies.
- **Cross-Tenant Fast-Upload Isolation**: Scoped `TryFastUploadScoped` so restricted AccessKeys can only deduplicate-bind blobs that already exist in accessible or `public-read` buckets.
- **XSS Sandbox on `/raw`**: Added `X-Content-Type-Options: nosniff`, strict `Content-Security-Policy: sandbox`, and forced `attachment` disposition for executable inline MIME types (`text/html`, `image/svg+xml`, etc.).

### Storage Consistency & S3 Compatibility
- **CAS Write-to-Temp + Atomic Commit**: Eliminated delete/write TOCTOU race conditions; added `fsync` before close, `X-Amz-Content-Sha256` & `Content-MD5` verification, and automatic self-healing when an existing disk blob size does not match `expectedSize`.
- **S3 Pagination & Folder Marker Semantics**: Fixed `ListObjects` + `delimiter` continuation token infinite loop (`max-keys=1`) and aligned S3 `DELETE /s3/{bucket}/dir/` to only delete the 0-byte marker by default (unless `x-cos-recursive: true` is passed).
- **Multipart Upload Quota Accounting**: Counted active staged multipart parts (`multipart_parts`) against bucket quota (`507 Insufficient Storage`).
- **Ordered Transactional Schema Migrations**: Replaced monolithic DDL with versioned transactional migrations (`schema_migrations` v1–v3).

### Operability & Engineering
- **Health Probes & Hot Backup**: Added `GET /healthz`, `GET /readyz`, `POST /api/v1/admin/backup`, and `cosd backup` CLI subcommand using SQLite `VACUUM INTO` for tear-free online backups.
- **Web Console & Static Serving**: Added Vite `manualChunks` code splitting, disabled Tailwind `preflight` to prevent Ant Design v6 conflicts, removed unused frontend packages, and added `Cache-Control: immutable` + transparent Gzip compression for `/assets/*`.
