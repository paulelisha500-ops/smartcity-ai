#!/bin/bash
set -e
PGDATA=/home/user/pgdata
if [ ! -d "$PGDATA/base" ]; then
  initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
  pg_ctl -D "$PGDATA" -o "-c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp" -w start
  psql -h /tmp -U postgres -c "CREATE ROLE smartcity SUPERUSER LOGIN PASSWORD 'smartcity'"
  createdb -h /tmp -U postgres -O smartcity smartcity
  pg_ctl -D "$PGDATA" -w stop
fi
# The config default JWT secret is public (it's in the repo), so anyone could
# forge a session against a public Space. Generate one per boot unless a Space
# secret provides it.
export SMARTCITY_JWT_SECRET="${SMARTCITY_JWT_SECRET:-$(python -c 'import secrets; print(secrets.token_urlsafe(48))')}"
exec supervisord -n -c /home/user/app/hf/supervisord.conf
