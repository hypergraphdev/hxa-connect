# ADR-001: Raw SQL + Custom DatabaseDriver over ORM

**Date:** 2026-03-02
**Status:** Accepted
**Participants:** Howard Zhou (owner), Zylos (evaluation), Codex/zylos01 (independent review)

## Context

PR #91 introduced an async `DatabaseDriver` interface with `SqliteDriver` as the first implementation, enabling issue #88's goal of optional PostgreSQL support. The question arose: should we adopt a mature ORM (Prisma, Drizzle, TypeORM, Sequelize) instead of implementing `PostgresDriver` ourselves?

### Codebase Profile

- `db.ts`: 2652 lines, **107 distinct SQL statements** (47 SELECT, 22 INSERT, 24 UPDATE, 14 DELETE)
- Complex patterns used:
  - Composite OR-tuple cursor pagination (3 places)
  - `rowid`-based batched deletes (5 places)
  - Derived-table subquery JOIN for artifact versioning (2 places)
  - Revision-based optimistic concurrency with `changes` check (8 places)
  - Dynamic WHERE/SET clause construction (6 places)
  - 7 explicit transaction blocks with driver pass-through
- No CTEs, no window functions, no SQLite JSON functions
- `ON CONFLICT DO UPDATE` (UPSERT) syntax is Postgres-compatible

### DatabaseDriver Interface (7 methods)

```typescript
interface DatabaseDriver {
  readonly dialect: 'sqlite' | 'postgres';
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (driver: DatabaseDriver) => Promise<T>): Promise<T>;
  isHealthy(): Promise<boolean>;
  close(): Promise<void>;
}
```

## Decision

**Keep raw SQL with custom DatabaseDriver. Implement PostgresDriver directly on node-postgres (`pg`). Do not adopt an ORM.**

## Evaluation

### Prisma — REJECTED

- Separate schema DSL (`schema.prisma`) requires rewriting all 107 queries
- Query engine binary adds ~15-25MB memory overhead
- Complex patterns (cursor pagination, revision checks, dynamic WHERE) need `$queryRaw`
- ~30-40% of queries would still be raw SQL, creating two paradigms

### TypeORM — REJECTED

- Known connection leak issues under concurrency
- Decorator-based entities require class restructuring
- Spotty maintenance history

### Sequelize — REJECTED

- Weakest type safety among all options
- Heaviest runtime dependency tree
- Complex queries need `sequelize.literal()` escape hatches

### Drizzle — VIABLE BUT MARGINAL

- SQL-first philosophy closest to existing codebase style
- Still requires rewriting 107 queries to query builder syntax
- 30-40% of queries (cursor pagination, rowid batched deletes, revision concurrency, dynamic WHERE) still need `sql` tagged template escape hatches
- Adds dependency for what is essentially a query builder over working, tested queries
- Only ORM that wouldn't actively fight the codebase, but net benefit is marginal

### Custom DatabaseDriver (CHOSEN)

- Zero migration of existing SQL queries
- 7-method interface = small attack surface
- 276 existing tests verify interface contract — PostgresDriver runs the same suite
- Only 5 dialect-specific adaptations needed (see below)
- ~200 lines for PostgresDriver vs ~2000+ lines of ORM rewrite

## SQLite → PostgreSQL Dialect Adaptations

Only 5 differences need handling. The other 102 SQL statements are standard SQL.

| # | Difference | SQLite | PostgreSQL | Where Handled |
|---|-----------|--------|------------|---------------|
| 1 | Placeholders | `?` | `$1, $2, ...` | Driver layer (automatic translation) |
| 2 | Batched deletes | `rowid` (5 places) | `id` | `db.ts` via `driver.dialect` branch |
| 3 | Auto-increment DDL | `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL PRIMARY KEY` | Separate init SQL per dialect |
| 4 | Boolean values | `0`/`1` | `true`/`false` | node-postgres handles automatically |
| 5 | PRAGMA statements | `journal_mode=WAL`, `foreign_keys=ON` | N/A | Driver constructor |

**Note:** `IN (?, ?, ...)` with dynamic parameter count requires `$N` expansion in the driver's placeholder translator, not sequential replacement. (zylos01 callout)

## Hardening Gates (Required Before PostgresDriver Rollout)

1. **Transaction-scoped client wrapper** — All queries within a transaction bound to a single pool client. Force-release (`client.release(true)`) on uncaught error to prevent connection leaks.
2. **Placeholder translator with corpus tests** — `?` → `$N` translation tested against all 107 existing SQL statements. Must handle: dynamic `IN (...)` expansion, quoted strings containing `?`, sequential indexing.
3. **Explicit type mapping policy** — Document and test handling of: boolean (`0/1` ↔ `true/false`), bigint/count return types, timestamp storage format (integer ms vs `BIGINT`/`TIMESTAMPTZ`), JSON text fields.
4. **Full test suite on PostgreSQL** — All 276 tests must pass on Postgres (GitHub Actions service container). Add concurrency stress tests for: invite-code atomic consumption, revision conflict detection, rate-limit event atomicity.

## Rollout Plan

- **PR 2A:** PostgresDriver implementation + placeholder translator + dialect shims
- **PR 2B:** Migration CLI (`hxa-connect migrate --from sqlite --to postgres`) + connection string config
- **Phase 3:** CI matrix (SQLite unit tests + PostgreSQL integration tests)

## Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Placeholder translation bugs | Medium | P1 | Corpus test over all 107 queries |
| Transaction connection leak | Low | P1 | Dedicated client + force-release |
| Type mapping mismatch | Low | P2 | Explicit policy + integration tests |
| SQLite↔Postgres concurrency semantics | Low | P2 | Revision conflict stress tests |
| Future need for ORM (codebase grows 3x) | Low | P3 | DatabaseDriver is ORM-compatible; Drizzle can wrap later |

## Reversibility

If the custom PostgresDriver proves problematic, Drizzle can be adopted incrementally by wrapping its pg adapter inside `DatabaseDriver.transaction()` / `.run()` — the interface is compatible. No db.ts changes needed for this fallback.
