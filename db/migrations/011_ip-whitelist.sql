-- IP Whitelisting: Track Dhan IP whitelist state per user.
-- Dhan requires IP whitelisting before placing orders.
-- Each user (dhanClientId) has PRIMARY + SECONDARY slots, modifiable once per 7 days.

-- UP

CREATE TABLE IF NOT EXISTS ip_whitelist (
  user_id               BIGINT PRIMARY KEY REFERENCES users(id),
  dhan_client_id        TEXT NOT NULL,

  -- Dhan-reported state (from GET /v2/ip/getIP)
  primary_ip            TEXT,
  secondary_ip          TEXT,
  detected_ip           TEXT,
  ip_match_status       TEXT,           -- PRIMARY_MATCH, SECONDARY_MATCH, NO_MATCH, etc.
  orders_allowed        BOOLEAN NOT NULL DEFAULT FALSE,

  -- Cooldown tracking (from Dhan response — earliest date the slot can be changed again)
  modify_date_primary   DATE,
  modify_date_secondary DATE,

  -- Our tracking
  system_ip             TEXT,           -- Current infrastructure outbound IP
  last_synced_at        TIMESTAMPTZ,    -- Last successful GET /v2/ip/getIP
  last_set_at           TIMESTAMPTZ,    -- Last successful POST /v2/ip/setIP
  last_set_slot         TEXT,           -- 'PRIMARY' or 'SECONDARY'
  sync_error            TEXT,           -- Last error message (NULL if OK)

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ip_whitelist_orders
  ON ip_whitelist (orders_allowed, last_synced_at);

-- DOWN
-- DROP TABLE IF EXISTS ip_whitelist;
