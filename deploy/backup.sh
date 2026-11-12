#!/usr/bin/env bash
# Nightly logical backup of MongoDB to S3-compatible storage. Requires: mongodump, aws CLI.
# Env: MONGODB_URI, BACKUP_BUCKET (e.g. s3://my-backups/tablesaas), optional RETENTION_DAYS (default 30)
set -euo pipefail
: "${MONGODB_URI:?set MONGODB_URI}"; : "${BACKUP_BUCKET:?set BACKUP_BUCKET}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="/tmp/tablesaas-${STAMP}.archive.gz"
mongodump --uri="$MONGODB_URI" --gzip --archive="$FILE"
aws s3 cp "$FILE" "${BACKUP_BUCKET}/db/${STAMP}.archive.gz"
rm -f "$FILE"
# Uploads (skip if you already use object storage)
if [ -n "${UPLOAD_DIR:-}" ] && [ -d "$UPLOAD_DIR" ]; then aws s3 sync "$UPLOAD_DIR" "${BACKUP_BUCKET}/uploads" --only-show-errors; fi
# Retention
CUTOFF=$(date -u -d "-${RETENTION_DAYS:-30} days" +%Y%m%d)
aws s3 ls "${BACKUP_BUCKET}/db/" | awk '{print $4}' | while read -r f; do
  [ "${f:0:8}" \< "$CUTOFF" ] && aws s3 rm "${BACKUP_BUCKET}/db/$f" --only-show-errors || true
done
echo "[$(date -u)] backup ${STAMP} done"
