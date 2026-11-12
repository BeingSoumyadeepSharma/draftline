#!/bin/sh
# Starts Draftline in the container as the unprivileged "node" user.
#
# The database folder /app/data is mounted from the computer (./data), so its
# owner is whoever created it there: on Linux and in GitHub Actions that's
# rarely the container's "node" user, and SQLite then can't create the
# database ("unable to open database file").
#
# So the container starts as root, hands /app/data to "node" when anything in it
# belongs to another user, then drops root for good before
# starting the app. On Docker Desktop (macOS, Windows) nothing needs changing.
set -e

DATA_DIR=/app/data

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # Anything in the folder not owned by "node" (including the folder itself)?
  if [ -n "$(find "$DATA_DIR" ! -user node -print -quit)" ]; then
    echo "Draftline: giving $DATA_DIR to the container's node user so it can write the database."
    chown -R node:node "$DATA_DIR"
  fi
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

# Already running as a regular user (for example `docker run --user ...`).
exec "$@"
