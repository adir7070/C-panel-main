#!/bin/bash

# ─── Configuration ─────────────────────────────────────────────────────────────
BACKUP_DIR="/home/ubuntu/backups"
DATE=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_NAME="iconiq-backup-$DATE"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"
S3_BUCKET="s3://iconiq-backups"
LOCAL_RETENTION_DAYS=7
S3_RETENTION_DAYS=30
LOG_FILE="$BACKUP_DIR/backup.log"

# MongoDB
MONGO_HOST="localhost"
MONGO_PORT="27017"
MONGO_USER="admin"
MONGO_PASS="z'87p7D[9kJV)6r"
MONGO_DB="iconiq_db"
MONGO_AUTH_DB="admin"

# App directory
APP_DIR="/var/www/iconiq-backend"

# ─── Setup ─────────────────────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "══════════════════════════════════════"
log "🚀 Starting backup: $BACKUP_NAME"
log "══════════════════════════════════════"

mkdir -p "$BACKUP_PATH"

# ─── 1. MongoDB Backup ─────────────────────────────────────────────────────────
log "📦 Backing up MongoDB..."

mongodump \
  --host "$MONGO_HOST:$MONGO_PORT" \
  --username "$MONGO_USER" \
  --password "$MONGO_PASS" \
  --authenticationDatabase "$MONGO_AUTH_DB" \
  --db "$MONGO_DB" \
  --out "$BACKUP_PATH/mongodb" \
  --gzip 2>>"$LOG_FILE"

if [ $? -eq 0 ]; then
  log "✅ MongoDB backup complete"
else
  log "❌ MongoDB backup FAILED"
  exit 1
fi

# ─── 2. App Files Backup ───────────────────────────────────────────────────────
log "📁 Backing up app files..."

tar -czf "$BACKUP_PATH/app-files.tar.gz" \
  --exclude="$APP_DIR/node_modules" \
  --exclude="$APP_DIR/.git" \
  --exclude="$APP_DIR/public/webApp/node_modules" \
  --exclude="$APP_DIR/public/webApp/dist" \
  "$APP_DIR" 2>>"$LOG_FILE"

if [ $? -eq 0 ]; then
  log "✅ App files backup complete"
else
  log "❌ App files backup FAILED"
fi

# ─── 3. PM2 Config Backup ──────────────────────────────────────────────────────
log "⚙️  Backing up PM2 config..."
pm2 save 2>>"$LOG_FILE"
cp /home/ubuntu/.pm2/dump.pm2 "$BACKUP_PATH/pm2-dump.pm2" 2>>"$LOG_FILE"
log "✅ PM2 config backup complete"

# ─── 4. Compress All ───────────────────────────────────────────────────────────
log "🗜️  Compressing backup..."

cd "$BACKUP_DIR"
tar -czf "$BACKUP_NAME.tar.gz" "$BACKUP_NAME"
rm -rf "$BACKUP_PATH"

SIZE=$(du -sh "$BACKUP_DIR/$BACKUP_NAME.tar.gz" | cut -f1)
log "✅ Compressed: $BACKUP_NAME.tar.gz ($SIZE)"

# ─── 5. Upload to S3 ───────────────────────────────────────────────────────────
log "☁️  Uploading to S3..."

aws s3 cp "$BACKUP_DIR/$BACKUP_NAME.tar.gz" \
  "$S3_BUCKET/daily/$BACKUP_NAME.tar.gz" \
  --region eu-north-1 2>>"$LOG_FILE"

if [ $? -eq 0 ]; then
  log "✅ Uploaded to S3: $S3_BUCKET/daily/$BACKUP_NAME.tar.gz"
else
  log "❌ S3 upload FAILED"
fi

# ─── 6. Clean Old Local Backups (7 days) ───────────────────────────────────────
log "🧹 Cleaning local backups older than $LOCAL_RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "iconiq-backup-*.tar.gz" -mtime +$LOCAL_RETENTION_DAYS -delete
log "✅ Local cleanup done"

# ─── 7. Clean Old S3 Backups (30 days) ────────────────────────────────────────
log "🧹 Cleaning S3 backups older than $S3_RETENTION_DAYS days..."
CUTOFF_DATE=$(date -d "$S3_RETENTION_DAYS days ago" +%Y-%m-%d)
aws s3 ls "$S3_BUCKET/daily/" --region eu-north-1 2>>"$LOG_FILE" | while read -r line; do
  FILE_DATE=$(echo "$line" | awk '{print $1}')
  FILE_NAME=$(echo "$line" | awk '{print $4}')
  if [[ "$FILE_DATE" < "$CUTOFF_DATE" ]] && [ -n "$FILE_NAME" ]; then
    aws s3 rm "$S3_BUCKET/daily/$FILE_NAME" --region eu-north-1 2>>"$LOG_FILE"
    log "🗑️  Deleted old S3 backup: $FILE_NAME"
  fi
done
log "✅ S3 cleanup done"

# ─── Done ──────────────────────────────────────────────────────────────────────
log "══════════════════════════════════════"
log "✅ Backup finished: $BACKUP_NAME"
log "══════════════════════════════════════"
