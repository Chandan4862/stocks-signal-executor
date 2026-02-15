# Copilot Instructions — stocks-signal-executor

> Automated trading executor that reads trade signals from external feeds,
> places orders on the Dhan broker API, manages stop-losses / trailing SLs,
> and records audit & PnL data.

---

## 1. Project Overview

| Layer            | Tech                                                             |
| ---------------- | ---------------------------------------------------------------- |
| Language         | TypeScript 5.x (ES2020 target, CommonJS modules, `strict: true`) |
| Runtime          | Node.js + ts-node (dev), tsc build (prod)                        |
| Broker API       | Dhan v2 — `access-token` header auth                             |
| Queue / Cache    | Redis via ioredis ^5                                             |
| Persistence      | PostgreSQL via pg ^8 (port 7432 in Docker)                       |
| Config           | dotenv + zod validation (`AppConfigSchema`)                      |
| Testing          | vitest ^1.6, ioredis-mock ^8, nock ^13                           |
| Containerisation | Docker multi-stage + docker-compose (Postgres + Redis)           |
| Dev reload       | nodemon (`dev:watch` script)                                     |

---

## 2. Folder Structure

```
src/
├── config/          # Zod schema + AppConfig type
├── enums/           # TradeState, OrderState, LifecycleEvents, InstrumentType
├── models/          # Interfaces: ActiveTrade, ClosedTrade, ValidatedTrade, PnlRecord, …
├── scripts/         # One-off scripts (e.g. fetchInstruments.ts)
├── services/        # Core business logic (one class per concern)
│   ├── tradeSyncService.ts
│   ├── dhanService.ts
│   ├── instrumentLookupService.ts
│   ├── auditLogService.ts
│   ├── quantityResolverService.ts
│   ├── telegramService.ts
│   ├── tokenService.ts
│   ├── tslService.ts
│   ├── stateStore.ts
│   └── scheduler.ts          # Orchestrator — creates all services, runs tick()
├── state/           # RedisKeys namespace (key-naming helpers)
├── utils/           # Pure helpers (date, math, etc.)
└── index.ts         # Entry point
db/
└── schema.sql       # All DDLs (trades, audit_logs, pnl_records, token_store, instrument_list_nse_eq)
tests/
├── tradeSync.unit.test.ts
├── tradeSync.integration.test.ts
└── tradeSync.cap.test.ts
docs/
├── ARCHITECTURE.md
├── FLOW.md
├── PHASES.md
└── DOCKER.md
```

---

## 3. SOLID Principles — Enforcement Guide

### S — Single Responsibility Principle

Every service class owns **one** concern:

| Service                   | Sole Responsibility                                                  |
| ------------------------- | -------------------------------------------------------------------- |
| `TradeSyncService`        | Orchestrate buy/sell lifecycle per trade signal                      |
| `DhanService`             | HTTP calls to Dhan API (order placement, modification, cancellation) |
| `InstrumentLookupService` | Resolve Dhan `security_id` from Postgres instrument table            |
| `AuditLogService`         | Persist immutable event logs to Postgres (graceful console fallback) |
| `QuantityResolverService` | Calculate order quantity from capital & price                        |
| `TslService`              | Trailing stop-loss state & recalculation                             |
| `TelegramService`         | Outbound Telegram notifications                                      |
| `TokenService`            | Broker auth-token acquisition & refresh                              |
| `StateStore`              | Redis + Postgres client lifecycle (connect/disconnect)               |

**Rule:** If a new feature touches two concerns, create a new service or utility
rather than adding a second responsibility to an existing class.

When `TradeSyncService` methods grow beyond ~40 lines, extract a well-named
private helper (e.g. `validateAndResolveTrade`, `placeEntryOrder`,
`persistBuyState`, `placeLegacyStopLoss`). Keep the public method as a
**thin orchestrator**.

### O — Open/Closed Principle

- New order strategies (e.g. bracket orders) should be **new methods or
  classes**, not if/else branches stuffed into existing methods.
- The `useSuperOrder` toggle already demonstrates this: two parallel code
  paths (`placeOrder` vs `placeSuperOrder`), selected by config, not by
  patching a monolith.
- Prefer **strategy or factory patterns** when adding new order types or
  broker integrations.

### L — Liskov Substitution Principle

- All services that accept a `Client` (pg) must work with **any** object
  satisfying the `Client` interface. Tests use a `StoreStub` whose `pg`
  provides a mock `query` — this must keep working.
- Never narrow a constructor parameter type (e.g. don't require a concrete
  `Pool` when a `Client` suffices).

### I — Interface Segregation Principle

- Models are **small, focused interfaces**: `ActiveTrade`, `ClosedTrade`,
  `ValidatedTrade`, `PnlRecord`, `PlaceOrderRequest`, `PlaceSuperOrderRequest`.
- Do not merge model interfaces. If a consumer needs only `{ id, symbol }`,
  define or pick that subset — don't force it to depend on the full 20-field
  `ActiveTrade`.

### D — Dependency Inversion Principle

- **Constructor injection** everywhere:
  ```ts
  constructor(
    private config: AppConfig,
    private store: StateStore,
    private dhan: DhanService,
    private audit: AuditLogService,
    private instrumentLookup: InstrumentLookupService,
  ) {}
  ```
- The scheduler (`scheduler.ts`) is the **composition root**: it creates
  concrete instances and wires them into service constructors.
- Services never instantiate their own dependencies or call `new` on
  siblings.
- Tests substitute stubs/mocks at the constructor boundary — no monkey-patching.

---

## 4. Coding Conventions

### TypeScript

- **Strict mode** (`strict: true` in tsconfig) — never use `any` unless
  wrapping an untyped external boundary; prefer `unknown` + narrowing.
- Use `import type { … }` for type-only imports.
- Prefer `interface` over `type` for object shapes; use `type` for unions /
  intersections.
- All public API surfaces must have **JSDoc** above the class and every
  public method.
- Enums live in `src/enums/`; use `string` enum values for readability in
  logs and DB columns.

### Config & Validation

- All runtime config is validated with **zod** (`AppConfigSchema` in
  `src/config/schema.ts`).
- Access config values through the typed `AppConfig` object — never read
  `process.env` directly in services.
- New config keys → add to the zod schema **and** `.env.example`.

### Error Handling

- Wrap Dhan API calls in try/catch; log via `AuditLogService.record()`
  with `LifecycleEvents.ERROR_OCCURRED`.
- `AuditLogService` itself must **never throw** — it catches DB failures
  and falls back to `console.log`.
- Redis lock failures → skip the trade in the current tick, do not crash.

### Idempotency

- Before placing any order, check the idempotency key in Redis:
  - `idempotency:buy:{tradeId}`, `idempotency:sell:{tradeId}`,
    `idempotency:sl:{tradeId}`
- Set the key **after** successful order placement.
- All key helpers live in `src/state/redisKeys.ts` (`RedisKeys` namespace).

### Redis Keys

- Use the `RedisKeys` namespace exclusively — never hard-code a key string
  outside `redisKeys.ts`.
- Naming pattern: `<domain>:<sub>:<id>` (e.g. `trade:42`, `lock:trade:42`).

### Postgres

- **Parameterised queries only** (`$1, $2, …`) — never interpolate values.
- Upsert with `ON CONFLICT … DO UPDATE` for idempotent writes (e.g. trades
  table).
- Table DDLs live in `db/schema.sql` — keep this file the single source of
  truth for schema.
- Default column values: `created_at TIMESTAMPTZ DEFAULT now()`.

---

## 5. Testing Standards

### Framework: vitest

```bash
npm test         # watch mode
npm run test:run # single run (CI)
```

### Patterns

| Pattern          | Purpose                                                                                |
| ---------------- | -------------------------------------------------------------------------------------- |
| **StoreStub**    | `{ redis: new IORedisMock(), pg: { query: vi.fn(…) } }` — shared across all tests      |
| **DhanStub**     | Extends `DhanService`, overrides `placeSuperOrder` / `placeOrder` to capture call args |
| **nock**         | Intercept external HTTP (feed URLs, Dhan API) in integration tests                     |
| **ioredis-mock** | Drop-in Redis replacement — no real Redis needed                                       |

### Rules

1. **No real infrastructure** in unit tests — always stub Redis, Postgres,
   and HTTP.
2. **One assertion theme per test** — test name describes the single
   behaviour verified.
3. `StoreStub.pg.query` must handle at minimum:
   - `SELECT COUNT` → open trade count
   - `SELECT security_id FROM instrument_list_nse_eq` → instrument resolution
   - `INSERT INTO` → return `{ rows: [], rowCount: 1 }`
4. When adding a new config field, **update the test config objects** in
   every test file (e.g. add `useSuperOrder`, `maxActiveTrades`, etc.).
5. Never `import` real `.env` in tests — build a typed `AppConfig` literal.

---

## 6. Service Implementation Checklist

When creating a **new service**:

1. Create `src/services/<serviceName>.ts`.
2. Add a top-of-file JSDoc block explaining the single responsibility.
3. Accept all dependencies via **constructor injection**.
4. Export only the class (and supporting request/response types if needed).
5. Wire the service in `scheduler.ts` (`tick()` or top-level setup).
6. Add / update unit tests — provide stubs via constructor.
7. If DB is involved, add DDL to `db/schema.sql` and run migration.
8. If config is involved, extend `AppConfigSchema` and `.env.example`.

---

## 7. Order Flow Quick-Reference

```
Feed (Active Trades URL)
  ↓  fetchActiveTrades → normalizeActive
  ↓
runBuyAndInitialSl  (orchestrator)
  ├─ getOpenTradeCount        (Postgres COUNT)
  ├─ isCashInstrument         (filter non-cash)
  ├─ isPortfolioCapReached    (maxActiveTrades guard)
  ├─ validateAndResolveTrade  (InstrumentLookupService, quantity calc)
  ├─ placeEntryOrder          (DhanService.placeSuperOrder | placeOrder)
  ├─ persistBuyState          (Redis snapshot + Postgres upsert)
  └─ placeLegacyStopLoss      (only when useSuperOrder = false)

Feed (Closed Trades URL)
  ↓  fetchClosedTrades → normalizeClosed
  ↓
runSellForClosedTrades
  ├─ SELL MARKET order
  ├─ Cancel open SL
  ├─ Update trade state → EXITED
  └─ Write PnL record
```

---

## 8. Docker / Local Dev

```bash
# Start Postgres + Redis
docker compose up -d

# Dev with live-reload
npm run dev:watch

# One-time: load instrument master
npm run script:fetch-instruments

# Run tests
npm run test:run
```

Postgres is exposed on **port 7432** (host) → 5432 (container).

---

## 9. Do's & Don'ts — Quick Summary

| ✅ Do                                             | ❌ Don't                                       |
| ------------------------------------------------- | ---------------------------------------------- |
| Inject dependencies via constructor               | Instantiate dependencies inside a service      |
| Use `RedisKeys.*` helpers for all keys            | Hard-code Redis key strings                    |
| Validate config with zod                          | Read `process.env` directly in services        |
| Use parameterised Postgres queries                | String-interpolate SQL values                  |
| Keep one responsibility per service               | Add unrelated methods to an existing service   |
| Write JSDoc on every public class/method          | Leave public API undocumented                  |
| Use `LifecycleEvents` enum for audit logs         | Pass free-form event strings                   |
| Extract private helpers when methods > ~40 lines  | Let orchestrator methods balloon               |
| Stub infrastructure in tests (ioredis-mock, nock) | Depend on running Redis/Postgres in unit tests |
| Update test config objects when adding new config | Leave test configs stale                       |
