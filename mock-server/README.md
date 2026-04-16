# 🧪 Mock Server

Simulates all external dependencies for local development and testing:

- **Dhan API** — orders, forever orders, holdings, positions, profile, token renewal
- **Active Trades API** — trade signal feed
- **Closed Trades API** — closed signal feed
- **Dhan Auth API** — TOTP-based token generation

## Quick Start

```bash
# Standalone
cd mock-server && npm install && npm run dev

# Via Docker Compose (starts with all services)
docker compose up
```

## Modes

| Mode         | Env                    | Behavior                                       |
| ------------ | ---------------------- | ---------------------------------------------- |
| `allSuccess` | `MOCK_MODE=allSuccess` | Always returns valid responses. Deterministic. |
| `random`     | `MOCK_MODE=random`     | Random mix of success + failures with latency. |

### Random Mode Config

| Variable         | Default | Description                           |
| ---------------- | ------- | ------------------------------------- |
| `FAILURE_RATE`   | `0.2`   | Probability of failure (0.0 – 1.0)    |
| `MAX_LATENCY_MS` | `500`   | Max random latency added to responses |

## Endpoints

### Dhan API (`/v2/...`)

| Method   | Path                     | Description                     |
| -------- | ------------------------ | ------------------------------- |
| `POST`   | `/v2/orders`             | Place order                     |
| `POST`   | `/v2/super/orders`       | Place super order               |
| `PUT`    | `/v2/orders/:id`         | Modify order                    |
| `DELETE` | `/v2/orders/:id`         | Cancel order                    |
| `GET`    | `/v2/orders`             | List all orders                 |
| `GET`    | `/v2/orders/:id`         | Get order by ID                 |
| `POST`   | `/v2/forever/orders`     | Place forever (GTT) order       |
| `PUT`    | `/v2/forever/orders/:id` | Modify forever order            |
| `DELETE` | `/v2/forever/orders/:id` | Cancel forever order            |
| `GET`    | `/v2/forever/orders`     | List forever orders             |
| `GET`    | `/v2/positions`          | List positions                  |
| `GET`    | `/v2/holdings`           | List holdings                   |
| `GET`    | `/v2/profile`            | User profile (token validation) |
| `GET`    | `/v2/RenewToken`         | Renew access token              |

### Auth API

| Method | Path                       | Description             |
| ------ | -------------------------- | ----------------------- |
| `POST` | `/app/generateAccessToken` | Generate token via TOTP |

### Signal APIs

| Method | Path                 | Description                             |
| ------ | -------------------- | --------------------------------------- |
| `GET`  | `/api/active-trades` | Active trade signals (3 default stocks) |
| `GET`  | `/api/closed-trades` | Closed trade signals (1 default)        |

### Admin / Debug APIs

| Method | Path                         | Description                             |
| ------ | ---------------------------- | --------------------------------------- |
| `POST` | `/admin/trigger-forever/:id` | Simulate forever order triggering       |
| `POST` | `/admin/reset`               | Reset all in-memory state               |
| `GET`  | `/admin/state`               | Dump all state (orders, holdings, etc.) |
| `POST` | `/admin/signals`             | Replace active/closed signals           |
| `POST` | `/admin/signals/add-active`  | Add one active signal                   |
| `POST` | `/admin/signals/close/:id`   | Move active → closed                    |
| `POST` | `/admin/signals/reset`       | Reset signals to defaults               |
| `GET`  | `/admin/signals`             | View current signals                    |
| `GET`  | `/health`                    | Health check + mode info                |

## State Consistency

The mock server maintains consistent state:

1. **Place order** → appears in `GET /v2/orders`
2. **Place forever order** → appears in `GET /v2/forever/orders`
3. **Trigger forever order** (via admin) → creates regular order + adds to holdings
4. **SELL order** → reduces holdings
5. **Idempotency** — duplicate `correlationId` returns existing order

## Testing Scenarios

```bash
# 1. View current state
curl http://localhost:4000/admin/state | jq

# 2. Add a custom signal
curl -X POST http://localhost:4000/admin/signals/add-active \
  -H "Content-Type: application/json" \
  -d '{"sc_symbol": "SBIN", "entry_price": 780, "stoploss_price": 740}'

# 3. Close a signal (simulate analyst closing a trade)
curl -X POST http://localhost:4000/admin/signals/close/1001

# 4. Trigger a forever order (simulate price breakout)
curl -X POST http://localhost:4000/admin/trigger-forever/100001

# 5. Reset everything
curl -X POST http://localhost:4000/admin/reset
curl -X POST http://localhost:4000/admin/signals/reset
```
