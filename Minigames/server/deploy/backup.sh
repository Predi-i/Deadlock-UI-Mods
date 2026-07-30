#!/bin/sh
set -eu

DATABASE=/var/lib/deadlock-minigames/minigames.sqlite
BACKUP_DIR=/var/backups/deadlock-minigames
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TEMP="$BACKUP_DIR/minigames-$STAMP.sqlite.tmp"
FINAL="$BACKUP_DIR/minigames-$STAMP.sqlite.gz"

install -d -m 0700 "$BACKUP_DIR"
sqlite3 "$DATABASE" ".timeout 5000" ".backup '$TEMP'"
gzip -9 "$TEMP"
mv "$TEMP.gz" "$FINAL"
find "$BACKUP_DIR" -type f -name 'minigames-*.sqlite.gz' -mtime +14 -delete
