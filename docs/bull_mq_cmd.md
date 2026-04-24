#REDIS Commands:

# Alias for convenience (add to ~/.zshrc)

alias redcli='/usr/local/bin/docker exec stocks-executor-redis redis-cli'

# 1. List ALL BullMQ keys

redcli KEYS 'bull:\*'

# 2. List all queues (just meta keys)

redcli KEYS 'bull:\*:meta'

# 3. Check jobs by state (waiting, active, completed, failed, delayed)

redcli ZRANGE 'bull:token-renewal:waiting' 0 -1
redcli ZRANGE 'bull:token-renewal:failed' 0 -1
redcli ZRANGE 'bull:token-renewal:completed' 0 -1

# 4. Inspect a specific job (full data + error stacktrace)

redcli HGETALL 'bull:token-renewal:token-renew:2:2026-04-22'

# 5. Check user tokens

redcli GET 'token:2'
redcli TTL 'token:2'

# 6. See all token keys

redcli KEYS 'token:\*'

# ── List waiting jobs (pending) per queue ──

redis-cli LRANGE "bull:trade-execution:wait" 0 -1
redis-cli LRANGE "bull:trade-monitor:wait" 0 -1
redis-cli LRANGE "bull:trade-reconciliation:wait" 0 -1
redis-cli LRANGE "bull:notification:wait" 0 -1
redis-cli LRANGE "bull:token-renewal:wait" 0 -1

# ── Get job data by job ID (returned from LRANGE above) ──

redis-cli HGETALL "bull:trade-execution:<jobId>"

# ── Quick: get ALL waiting job IDs + their data for trade-execution ──

redis-cli LRANGE "bull:trade-execution:wait" 0 -1

# Then for each job ID:

redis-cli HGET "bull:trade-execution:<jobId>" "data"

# ── One-liner: dump all waiting trade-execution jobs with data ──

for id in $(redis-cli LRANGE "bull:trade-execution:wait" 0 -1); do
  echo "=== Job: $id ==="
  redis-cli HGET "bull:trade-execution:$id" "data" | python3 -m json.tool
done

# ── Count pending jobs per queue ──

redis-cli LLEN "bull:trade-execution:wait"
redis-cli LLEN "bull:notification:wait"
redis-cli LLEN "bull:trade-monitor:wait"
redis-cli LLEN "bull:trade-reconciliation:wait"

```
State	          Redis type	    Command
wait	          List	          LRANGE
active	        List	          LRANGE
completed	      Sorted Set	    ZRANGE
failed	        Sorted Set	    ZRANGE
delayed	        Sorted Set	    ZRANGE
```

# Next time you just want to flush without stopping:

docker exec stocks-executor-redis redis-cli FLUSHDB
