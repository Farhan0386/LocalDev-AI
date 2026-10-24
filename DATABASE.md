# LocalDev AI — Data and Persistence Design

**Status:** Draft v0.1  
**MVP decision:** No database is required initially.

## 1. Principle

The core workflow can operate without persistent application data: the extension sends a request, the engine calls Ollama, and the response is shown to the user. Do not add a database until a concrete requirement justifies it.

## 2. Data handled in memory

- Current request type (explain, hint, diagnose, or patch).
- Selected code and limited relevant diagnostics.
- Runtime/model status.
- Response text and proposed patch.
- Temporary benchmark measurements.

Keep this data in memory where practical and discard it when no longer needed.

## 3. Optional future SQLite schema

If persistent benchmark history or user preferences become necessary, consider SQLite.

### `benchmark_runs`
- `id`: integer primary key
- `created_at`: timestamp
- `model_name`: text
- `task_type`: text
- `duration_ms`: integer
- `time_to_first_token_ms`: nullable integer
- `tokens_per_second`: nullable real
- `ram_peak_mb`: nullable real
- `gpu_memory_peak_mb`: nullable real
- `success`: boolean/integer
- `notes`: optional text, with no source code or secrets

### `preferences`
- `key`: text primary key
- `value`: text or JSON-encoded value
- `updated_at`: timestamp

Do not store source code, prompts, or generated patches in persistent history by default. If a future feature needs this, make it explicit, optional, documented, and user-controllable.

## 4. Retention and migration

- No persistence in the MVP means no database migrations are needed.
- If SQLite is introduced, version the schema and test upgrades.
- Provide a clear way to clear stored benchmarks/preferences.
- Store data in an appropriate user-local application data directory.
- Avoid credentials and secrets entirely.

## 5. Acceptance criteria

- MVP works when no database file exists.
- Benchmarking does not require persistence.
- No source code is written to a database by default.
- Any future persistence feature has documented purpose, retention, and deletion behavior.
