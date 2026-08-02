#!/bin/sh
# Restart the relay when it stops answering HTTP.
#
# The failure this exists for: a wedged event loop (the 1.0 poker leaveSeat infinite loop) keeps
# the process "active" from systemd's point of view, so Restart=always never fires and the relay
# stays dead until a human notices. That outage ran five hours.
#
# This probes the symptom players actually feel - no reply on /api/ping - rather than a liveness
# token the app hands out, so it also covers a stuck SQLite write or an exhausted socket pool.
set -eu

URL=http://127.0.0.1:8787/api/ping
SERVICE=deadlock-minigames
# Per-probe ceiling. /api/ping touches no storage and answers in ~10ms; 10s means "not answering",
# not "answering slowly". Kept well under the 30s timer interval so probes cannot overlap.
TIMEOUT=10
ATTEMPTS=3
GAP=5

# Never fight systemd. During its own restart backoff the service is briefly not listening, and a
# restart issued here would reset that backoff and mask a genuine crash loop.
STATE=$(systemctl show "$SERVICE" -p ActiveState --value)
if [ "$STATE" != "active" ]; then
    echo "healthcheck: service is $STATE, leaving it to systemd"
    exit 0
fi

attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
    if curl -fsS -o /dev/null --max-time "$TIMEOUT" "$URL"; then
        exit 0
    fi
    echo "healthcheck: probe $attempt/$ATTEMPTS failed"
    # A single miss is not evidence: a deploy, a GC pause, or a burst of GeoGuesser proxying can
    # lose one probe. Only a run of them across ~30s justifies killing live games.
    [ "$attempt" -lt "$ATTEMPTS" ] && sleep "$GAP"
    attempt=$((attempt + 1))
done

echo "healthcheck: $ATTEMPTS consecutive probes failed, restarting $SERVICE"
# Dump the wedged process's stack before killing it, or the next occurrence is diagnosed from
# scratch. SIGQUIT makes Node print a JS stack; harmless if it is already unresponsive.
MAIN=$(systemctl show "$SERVICE" -p MainPID --value)
if [ -n "$MAIN" ] && [ "$MAIN" != "0" ]; then
    echo "healthcheck: signalling PID $MAIN for a stack trace"
    kill -QUIT "$MAIN" 2>/dev/null || true
    sleep 2
fi
systemctl restart "$SERVICE"
