# Backup and recovery

## What must be backed up

| Asset | Where | Criticality |
|---|---|---|
| MongoDB database | Atlas / your replica set | **Critical**: all tenants, orders, payments |
| `ENCRYPTION_KEY` | `server/.env` | **Critical**: without it, stored payment-provider keys cannot be decrypted (tenants would have to re-enter them) |
| JWT secrets | `server/.env` | Rotating them only signs everyone out. Not data-critical |
| Uploaded images | `UPLOAD_DIR` (or your object storage bucket) | High: logos, menu photos |
| TLS certs | `/etc/letsencrypt` or Caddy data dir | Low: re-issuable |

Store `.env` in a secrets manager (1Password, AWS Secrets Manager, Vault), **not** in git.

## MongoDB

### Atlas (recommended)
Enable **Cloud Backup** with **Continuous Cloud Backup (point-in-time restore)**. Suggested policy: snapshots every 6 h kept 7 days, daily kept 30 days, monthly kept 12 months. Test a restore to a separate cluster every quarter.

### Self-hosted: nightly logical dumps

```bash
# /etc/cron.d/tablesaas-backup  — 02:30 daily
30 2 * * * root /srv/tablesaas/tablesaas/deploy/backup.sh >> /var/log/tablesaas-backup.log 2>&1
```

`deploy/backup.sh` runs `mongodump --gzip --archive`, uploads to object storage and prunes after 30 days. For point-in-time recovery on self-hosted, run a replica set and use filesystem snapshots plus oplog, or Percona Backup for MongoDB.

### Uploads

```bash
aws s3 sync /srv/tablesaas/uploads s3://your-backup-bucket/uploads --delete   # nightly
```

Or enable versioning on the bucket if uploads already live in object storage.

## Restore procedures

### Full restore (disaster)
1. Provision MongoDB and restore the latest snapshot (Atlas UI) or `mongorestore --gzip --archive=dump.gz --drop`.
2. Restore `server/.env` (same `ENCRYPTION_KEY`).
3. Restore uploads to `UPLOAD_DIR`.
4. Deploy the app (DEPLOYMENT.md) and check `/api/health`. The server re-syncs indexes on boot.

### Single-tenant restore (one restaurant's data damaged)
All tenant data is keyed by `tenantId`, so one tenant can be restored without touching others:

```bash
# 1. Restore the snapshot to a TEMPORARY database/cluster (never over production)
mongorestore --gzip --archive=dump.gz --nsFrom='tablesaas.*' --nsTo='restore_tmp.*'

# 2. Export that tenant's documents from each tenant-scoped collection
TID=<tenant ObjectId>
for c in categories products kitchenstations tables orders counters payments reservations customers feedbacks coupons notifications suppliers inventoryitems purchaseorders stockmovements auditlogs users; do
  mongoexport --uri="$TMP_URI/restore_tmp" -c $c --query="{\"tenantId\":{\"\$oid\":\"$TID\"}}" --out=$c.json
done

# 3. In production, inside a maintenance window for that tenant (suspend it from the console):
#    delete that tenant's current docs per collection, then mongoimport each file.
# 4. Reactivate the tenant.
```

Restoring only `orders`/`payments` while keeping current menu data is also possible. Choose collections deliberately and keep `counters` consistent with the highest `orderNumber`.

### Lost ENCRYPTION_KEY
Payment provider secrets cannot be recovered. Set a new key, then ask each tenant using Stripe to re-enter keys in Settings → Payments and re-verify. No order or payment history is affected.

## Recovery objectives (suggested)

| Metric | Atlas PITR | Nightly dump |
|---|---|---|
| RPO (max data loss) | ~1 minute | up to 24 h |
| RTO (time to restore) | 30–60 min | 1–3 h depending on size |
