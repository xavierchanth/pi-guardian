use std::{collections::BTreeMap, path::Path};

use pi_tai_host_protocol::HostEvent;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

const SCHEMA_VERSION: i64 = 2;
const MAX_REPLAY_EVENTS: usize = 10_000;
const MAX_CORE_TRANSACTION_EVENTS: usize = 64;
const MAX_CORE_TRANSACTION_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionProjection {
    pub session_id: String,
    pub revision: u64,
    pub runtime_generation: u64,
    pub snapshot: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationCommit {
    pub operation_id: String,
    pub session_id: String,
    pub kind: String,
    pub expected_revision: Option<u64>,
    pub response: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoreEvent {
    pub event_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoreTransaction {
    pub transaction_id: String,
    pub aggregate_id: String,
    pub expected_revision: u64,
    pub runtime_generation: u64,
    pub timestamp: String,
    pub events: Vec<CoreEvent>,
    pub state: Value,
    pub projection: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CoreAggregate {
    pub aggregate_id: String,
    pub revision: u64,
    pub runtime_generation: u64,
    pub state: Value,
    pub projection: Value,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CoreAppendOutcome {
    Committed { aggregate: CoreAggregate },
    Duplicate { aggregate: CoreAggregate },
}

#[derive(Debug, Clone, PartialEq)]
pub enum AppendOutcome {
    Committed,
    Duplicate { response: Value },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    pub usage_event_id: String,
    pub session_id: String,
    pub context_id: String,
    pub cycle_id: String,
    pub message_id: String,
    pub provider: String,
    pub model: String,
    pub role: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost_input: f64,
    pub cost_output: f64,
    pub cost_cache_read: f64,
    pub cost_cache_write: f64,
    pub cost_total: f64,
    pub recorded_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost: f64,
    pub telemetry_gap_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageBreakdown {
    pub total: UsageTotals,
    pub by_model: BTreeMap<String, UsageTotals>,
    pub by_role: BTreeMap<String, UsageTotals>,
    pub by_context: BTreeMap<String, UsageTotals>,
    pub by_execution_cycle: BTreeMap<String, UsageTotals>,
}

pub struct EventStore {
    connection: Connection,
}

impl EventStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&connection)?;
        Ok(Self { connection })
    }

    pub fn journal_mode(&self) -> Result<String, StoreError> {
        self.connection
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .map_err(StoreError::Sqlite)
    }

    pub fn append(
        &mut self,
        projection: &SessionProjection,
        event: &HostEvent,
        operation: Option<&OperationCommit>,
    ) -> Result<AppendOutcome, StoreError> {
        validate_append(projection, event, operation)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        if let Some(operation) = operation {
            let existing = transaction
                .query_row(
                    "SELECT session_id, kind, response_json FROM operations WHERE operation_id = ?1",
                    [&operation.operation_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?;
            if let Some((session_id, kind, response_json)) = existing {
                if session_id != operation.session_id || kind != operation.kind {
                    return Err(StoreError::OperationCollision(
                        operation.operation_id.clone(),
                    ));
                }
                return Ok(AppendOutcome::Duplicate {
                    response: serde_json::from_str(&response_json)?,
                });
            }
        }

        let current_revision = transaction
            .query_row(
                "SELECT revision FROM broker_sessions WHERE session_id = ?1",
                [&projection.session_id],
                |row| row.get::<_, u64>(0),
            )
            .optional()?;
        if let Some(current) = current_revision {
            if projection.revision < current {
                return Err(StoreError::RevisionRegression {
                    current,
                    incoming: projection.revision,
                });
            }
        }
        let last_sequence = transaction.query_row(
            "SELECT COALESCE(MAX(sequence), 0) FROM session_events WHERE session_id = ?1",
            [&projection.session_id],
            |row| row.get::<_, u64>(0),
        )?;
        let expected_sequence = last_sequence
            .checked_add(1)
            .ok_or(StoreError::CounterOverflow("event sequence"))?;
        if event.sequence != expected_sequence {
            return Err(StoreError::SequenceConflict {
                expected: expected_sequence,
                actual: event.sequence,
            });
        }

        transaction.execute(
            "INSERT INTO session_events (
                session_id, sequence, revision, runtime_generation, timestamp, event_type, payload_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                event.session_id,
                event.sequence,
                event.revision,
                event.runtime_generation,
                event.timestamp,
                event.event_type,
                serde_json::to_string(&event.payload)?,
            ],
        )?;
        transaction.execute(
            "INSERT INTO broker_sessions (
                session_id, revision, runtime_generation, snapshot_json, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id) DO UPDATE SET
                revision = excluded.revision,
                runtime_generation = excluded.runtime_generation,
                snapshot_json = excluded.snapshot_json,
                updated_at = excluded.updated_at",
            params![
                projection.session_id,
                projection.revision,
                projection.runtime_generation,
                serde_json::to_string(&projection.snapshot)?,
                event.timestamp,
            ],
        )?;
        if let Some(operation) = operation {
            transaction.execute(
                "INSERT INTO operations (
                    operation_id, session_id, kind, expected_revision, response_json, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    operation.operation_id,
                    operation.session_id,
                    operation.kind,
                    operation.expected_revision,
                    serde_json::to_string(&operation.response)?,
                    event.timestamp,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(AppendOutcome::Committed)
    }

    pub fn load_projection(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionProjection>, StoreError> {
        self.connection
            .query_row(
                "SELECT revision, runtime_generation, snapshot_json
                 FROM broker_sessions WHERE session_id = ?1",
                [session_id],
                |row| {
                    Ok((
                        row.get::<_, u64>(0)?,
                        row.get::<_, u64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
            .map(|(revision, runtime_generation, snapshot_json)| {
                Ok(SessionProjection {
                    session_id: session_id.into(),
                    revision,
                    runtime_generation,
                    snapshot: serde_json::from_str(&snapshot_json)?,
                })
            })
            .transpose()
    }

    pub fn list_projections(&self) -> Result<Vec<SessionProjection>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT session_id, revision, runtime_generation, snapshot_json
             FROM broker_sessions ORDER BY updated_at DESC, session_id ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;
        rows.map(|row| {
            let (session_id, revision, runtime_generation, snapshot_json) = row?;
            Ok(SessionProjection {
                session_id,
                revision,
                runtime_generation,
                snapshot: serde_json::from_str(&snapshot_json)?,
            })
        })
        .collect()
    }

    pub fn last_sequence(&self, session_id: &str) -> Result<u64, StoreError> {
        self.connection
            .query_row(
                "SELECT COALESCE(MAX(sequence), 0) FROM session_events WHERE session_id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .map_err(StoreError::Sqlite)
    }

    pub fn events_after(
        &self,
        session_id: &str,
        sequence: u64,
        limit: usize,
    ) -> Result<Vec<HostEvent>, StoreError> {
        if limit == 0 || limit > MAX_REPLAY_EVENTS {
            return Err(StoreError::InvalidReplayLimit(limit));
        }
        let mut statement = self.connection.prepare(
            "SELECT sequence, revision, runtime_generation, timestamp, event_type, payload_json
             FROM session_events
             WHERE session_id = ?1 AND sequence > ?2
             ORDER BY sequence ASC
             LIMIT ?3",
        )?;
        let rows = statement.query_map(params![session_id, sequence, limit], |row| {
            Ok((
                row.get::<_, u64>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;
        rows.map(|row| {
            let (sequence, revision, runtime_generation, timestamp, event_type, payload_json) =
                row?;
            Ok(HostEvent {
                protocol_version: pi_tai_host_protocol::CURRENT_PROTOCOL_VERSION,
                session_id: session_id.into(),
                sequence,
                revision,
                runtime_generation,
                timestamp,
                event_type,
                payload: serde_json::from_str(&payload_json)?,
            })
        })
        .collect()
    }

    pub fn operation(&self, operation_id: &str) -> Result<Option<OperationCommit>, StoreError> {
        self.connection
            .query_row(
                "SELECT session_id, kind, expected_revision, response_json
                 FROM operations WHERE operation_id = ?1",
                [operation_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<u64>>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?
            .map(|(session_id, kind, expected_revision, response_json)| {
                Ok(OperationCommit {
                    operation_id: operation_id.into(),
                    session_id,
                    kind,
                    expected_revision,
                    response: serde_json::from_str(&response_json)?,
                })
            })
            .transpose()
    }

    pub fn operation_response(&self, operation_id: &str) -> Result<Option<Value>, StoreError> {
        Ok(self
            .operation(operation_id)?
            .map(|operation| operation.response))
    }

    pub fn record_usage(&self, entry: &UsageEntry) -> Result<bool, StoreError> {
        validate_usage(entry)?;
        let changed = self.connection.execute(
            "INSERT OR IGNORE INTO usage_entries (usage_event_id, session_id, context_id, cycle_id, message_id, provider, model, role, input, output, cache_read, cache_write, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total, recorded_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![entry.usage_event_id, entry.session_id, entry.context_id, entry.cycle_id, entry.message_id, entry.provider, entry.model, entry.role, entry.input, entry.output, entry.cache_read, entry.cache_write, entry.cost_input, entry.cost_output, entry.cost_cache_read, entry.cost_cache_write, entry.cost_total, entry.recorded_at],
        )?;
        Ok(changed == 1)
    }

    pub fn record_usage_gap(&self, gap_id: &str, session_id: &str, context_id: &str, cycle_id: &str, reason: &str, observed_at: &str) -> Result<bool, StoreError> {
        if [gap_id, session_id, context_id, cycle_id, reason, observed_at].iter().any(|value| value.is_empty()) { return Err(StoreError::InvalidUsage("usage gap fields are required")); }
        Ok(self.connection.execute(
            "INSERT OR IGNORE INTO usage_gaps (gap_id, session_id, context_id, cycle_id, reason, observed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![gap_id, session_id, context_id, cycle_id, reason, observed_at],
        )? == 1)
    }

    pub fn usage_totals(&self, session_id: &str) -> Result<UsageTotals, StoreError> {
        let (input, output, cache_read, cache_write, cost) = self.connection.query_row(
            "SELECT COALESCE(SUM(input),0), COALESCE(SUM(output),0), COALESCE(SUM(cache_read),0), COALESCE(SUM(cache_write),0), COALESCE(SUM(cost_total),0.0) FROM usage_entries WHERE session_id = ?1",
            [session_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )?;
        let telemetry_gap_count = self.connection.query_row("SELECT COUNT(*) FROM usage_gaps WHERE session_id = ?1", [session_id], |row| row.get(0))?;
        Ok(UsageTotals { input, output, cache_read, cache_write, cost, telemetry_gap_count })
    }

    pub fn usage_breakdown(&self, session_id: &str) -> Result<UsageBreakdown, StoreError> {
        let mut result = UsageBreakdown { total: self.usage_totals(session_id)?, ..UsageBreakdown::default() };
        let mut statement = self.connection.prepare("SELECT context_id, cycle_id, provider, model, role, input, output, cache_read, cache_write, cost_total FROM usage_entries WHERE session_id = ?1")?;
        let rows = statement.query_map([session_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, u64>(5)?, row.get::<_, u64>(6)?, row.get::<_, u64>(7)?, row.get::<_, u64>(8)?, row.get::<_, f64>(9)?)))?;
        for row in rows {
            let (context, cycle, provider, model, role, input, output, cache_read, cache_write, cost) = row?;
            for (map, key) in [(&mut result.by_model, format!("{provider}/{model}")), (&mut result.by_role, role), (&mut result.by_context, context), (&mut result.by_execution_cycle, cycle)] {
                let total = map.entry(key).or_default(); total.input += input; total.output += output; total.cache_read += cache_read; total.cache_write += cache_write; total.cost += cost;
            }
        }
        Ok(result)
    }

    pub fn append_core_transaction(
        &mut self,
        input: &CoreTransaction,
    ) -> Result<CoreAppendOutcome, StoreError> {
        validate_core_transaction(input)?;
        let transaction = self.connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some((aggregate_id, resulting_revision)) = transaction
            .query_row(
                "SELECT aggregate_id, resulting_revision FROM core_transactions WHERE transaction_id = ?1",
                [&input.transaction_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?)),
            )
            .optional()?
        {
            if aggregate_id != input.aggregate_id {
                return Err(StoreError::OperationCollision(input.transaction_id.clone()));
            }
            let aggregate = load_core_aggregate_tx(&transaction, &input.aggregate_id)?
                .ok_or_else(|| StoreError::MissingCoreAggregate(input.aggregate_id.clone()))?;
            if aggregate.revision < resulting_revision {
                return Err(StoreError::MissingCoreAggregate(input.aggregate_id.clone()));
            }
            return Ok(CoreAppendOutcome::Duplicate { aggregate });
        }
        let current = load_core_aggregate_tx(&transaction, &input.aggregate_id)?;
        let actual_revision = current.as_ref().map_or(0, |aggregate| aggregate.revision);
        if actual_revision != input.expected_revision {
            return Err(StoreError::CoreRevisionConflict { expected: input.expected_revision, actual: actual_revision });
        }
        let revision = actual_revision.checked_add(1).ok_or(StoreError::CounterOverflow("core aggregate revision"))?;
        for (index, event) in input.events.iter().enumerate() {
            transaction.execute(
                "INSERT INTO core_events (
                    aggregate_id, revision, event_index, event_id, runtime_generation, timestamp, event_type, payload_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![input.aggregate_id, revision, u64::try_from(index).map_err(|_| StoreError::CounterOverflow("core event index"))?, event.event_id, input.runtime_generation, input.timestamp, event.event_type, serde_json::to_string(&event.payload)?],
            )?;
        }
        transaction.execute(
            "INSERT INTO core_aggregates (aggregate_id, revision, runtime_generation, state_json, projection_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(aggregate_id) DO UPDATE SET revision = excluded.revision, runtime_generation = excluded.runtime_generation, state_json = excluded.state_json, projection_json = excluded.projection_json, updated_at = excluded.updated_at",
            params![input.aggregate_id, revision, input.runtime_generation, serde_json::to_string(&input.state)?, serde_json::to_string(&input.projection)?, input.timestamp],
        )?;
        transaction.execute(
            "INSERT INTO core_transactions (transaction_id, aggregate_id, expected_revision, resulting_revision, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![input.transaction_id, input.aggregate_id, input.expected_revision, revision, input.timestamp],
        )?;
        transaction.commit()?;
        Ok(CoreAppendOutcome::Committed { aggregate: CoreAggregate { aggregate_id: input.aggregate_id.clone(), revision, runtime_generation: input.runtime_generation, state: input.state.clone(), projection: input.projection.clone(), updated_at: input.timestamp.clone() } })
    }

    pub fn load_core_aggregate(&self, aggregate_id: &str) -> Result<Option<CoreAggregate>, StoreError> {
        load_core_aggregate_connection(&self.connection, aggregate_id)
    }

    pub fn core_events_after(&self, aggregate_id: &str, revision: u64, limit: usize) -> Result<Vec<(u64, CoreEvent)>, StoreError> {
        if limit == 0 || limit > MAX_REPLAY_EVENTS { return Err(StoreError::InvalidReplayLimit(limit)); }
        let mut statement = self.connection.prepare(
            "SELECT revision, event_id, event_type, payload_json FROM core_events
             WHERE aggregate_id = ?1 AND revision > ?2 ORDER BY revision ASC, event_index ASC LIMIT ?3",
        )?;
        let rows = statement.query_map(params![aggregate_id, revision, limit], |row| Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))?;
        rows.map(|row| {
            let (revision, event_id, event_type, payload_json) = row?;
            Ok((revision, CoreEvent { event_id, event_type, payload: serde_json::from_str(&payload_json)? }))
        }).collect()
    }
}

fn validate_usage(entry: &UsageEntry) -> Result<(), StoreError> {
    if [entry.usage_event_id.as_str(), entry.session_id.as_str(), entry.context_id.as_str(), entry.cycle_id.as_str(), entry.message_id.as_str(), entry.provider.as_str(), entry.model.as_str(), entry.role.as_str(), entry.recorded_at.as_str()].iter().any(|value| value.is_empty()) { return Err(StoreError::InvalidUsage("usage identity fields are required")); }
    if [entry.cost_input, entry.cost_output, entry.cost_cache_read, entry.cost_cache_write, entry.cost_total].iter().any(|value| !value.is_finite() || *value < 0.0) { return Err(StoreError::InvalidUsage("usage costs must be finite and nonnegative")); }
    Ok(())
}

fn validate_core_transaction(input: &CoreTransaction) -> Result<(), StoreError> {
    if input.transaction_id.is_empty() || input.aggregate_id.is_empty() { return Err(StoreError::InvalidCoreTransaction("transaction and aggregate IDs are required")); }
    if input.events.is_empty() || input.events.len() > MAX_CORE_TRANSACTION_EVENTS { return Err(StoreError::InvalidCoreTransaction("transaction must contain 1 to 64 events")); }
    let encoded = serde_json::to_vec(input)?;
    if encoded.len() > MAX_CORE_TRANSACTION_BYTES { return Err(StoreError::InvalidCoreTransaction("transaction exceeds 1 MiB")); }
    let mut ids = std::collections::BTreeSet::new();
    for event in &input.events {
        if event.event_id.is_empty() || event.event_type.is_empty() || !ids.insert(&event.event_id) { return Err(StoreError::InvalidCoreTransaction("event IDs and types must be nonempty and unique")); }
    }
    Ok(())
}

fn load_core_aggregate_connection(connection: &Connection, aggregate_id: &str) -> Result<Option<CoreAggregate>, StoreError> {
    connection.query_row(
        "SELECT revision, runtime_generation, state_json, projection_json, updated_at FROM core_aggregates WHERE aggregate_id = ?1",
        [aggregate_id],
        |row| Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)),
    ).optional()?.map(|(revision, runtime_generation, state_json, projection_json, updated_at)| Ok(CoreAggregate { aggregate_id: aggregate_id.into(), revision, runtime_generation, state: serde_json::from_str(&state_json)?, projection: serde_json::from_str(&projection_json)?, updated_at })).transpose()
}

fn load_core_aggregate_tx(transaction: &rusqlite::Transaction<'_>, aggregate_id: &str) -> Result<Option<CoreAggregate>, StoreError> {
    transaction.query_row(
        "SELECT revision, runtime_generation, state_json, projection_json, updated_at FROM core_aggregates WHERE aggregate_id = ?1",
        [aggregate_id],
        |row| Ok((row.get::<_, u64>(0)?, row.get::<_, u64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?)),
    ).optional()?.map(|(revision, runtime_generation, state_json, projection_json, updated_at)| Ok(CoreAggregate { aggregate_id: aggregate_id.into(), revision, runtime_generation, state: serde_json::from_str(&state_json)?, projection: serde_json::from_str(&projection_json)?, updated_at })).transpose()
}

fn validate_append(
    projection: &SessionProjection,
    event: &HostEvent,
    operation: Option<&OperationCommit>,
) -> Result<(), StoreError> {
    if projection.session_id.is_empty() || event.session_id != projection.session_id {
        return Err(StoreError::SessionMismatch);
    }
    if event.revision != projection.revision
        || event.runtime_generation != projection.runtime_generation
    {
        return Err(StoreError::ProjectionMismatch);
    }
    if operation.is_some_and(|operation| operation.session_id != projection.session_id) {
        return Err(StoreError::SessionMismatch);
    }
    Ok(())
}

fn migrate(connection: &Connection) -> Result<(), StoreError> {
    connection.execute_batch(
        "BEGIN IMMEDIATE;
         CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS broker_sessions (
            session_id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL CHECK (revision >= 0),
            runtime_generation INTEGER NOT NULL CHECK (runtime_generation >= 0),
            snapshot_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS session_events (
            session_id TEXT NOT NULL REFERENCES broker_sessions(session_id) DEFERRABLE INITIALLY DEFERRED,
            sequence INTEGER NOT NULL CHECK (sequence > 0),
            revision INTEGER NOT NULL CHECK (revision >= 0),
            runtime_generation INTEGER NOT NULL CHECK (runtime_generation >= 0),
            timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (session_id, sequence)
         );
         CREATE TABLE IF NOT EXISTS operations (
            operation_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES broker_sessions(session_id) DEFERRABLE INITIALLY DEFERRED,
            kind TEXT NOT NULL,
            expected_revision INTEGER,
            response_json TEXT NOT NULL,
            created_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS core_aggregates (
            aggregate_id TEXT PRIMARY KEY,
            revision INTEGER NOT NULL CHECK (revision >= 0),
            runtime_generation INTEGER NOT NULL CHECK (runtime_generation >= 0),
            state_json TEXT NOT NULL,
            projection_json TEXT NOT NULL,
            updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS core_events (
            aggregate_id TEXT NOT NULL REFERENCES core_aggregates(aggregate_id) DEFERRABLE INITIALLY DEFERRED,
            revision INTEGER NOT NULL CHECK (revision > 0),
            event_index INTEGER NOT NULL CHECK (event_index >= 0),
            event_id TEXT NOT NULL UNIQUE,
            runtime_generation INTEGER NOT NULL CHECK (runtime_generation >= 0),
            timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (aggregate_id, revision, event_index)
         );
         CREATE TABLE IF NOT EXISTS core_transactions (
            transaction_id TEXT PRIMARY KEY,
            aggregate_id TEXT NOT NULL REFERENCES core_aggregates(aggregate_id) DEFERRABLE INITIALLY DEFERRED,
            expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
            resulting_revision INTEGER NOT NULL CHECK (resulting_revision > 0),
            created_at TEXT NOT NULL
         );
         INSERT OR IGNORE INTO schema_migrations(version, applied_at)
            VALUES (1, 'schema-v1');
         CREATE TABLE IF NOT EXISTS usage_entries (
            usage_event_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES broker_sessions(session_id),
            context_id TEXT NOT NULL,
            cycle_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            role TEXT NOT NULL,
            input INTEGER NOT NULL CHECK (input >= 0), output INTEGER NOT NULL CHECK (output >= 0),
            cache_read INTEGER NOT NULL CHECK (cache_read >= 0), cache_write INTEGER NOT NULL CHECK (cache_write >= 0),
            cost_input REAL NOT NULL CHECK (cost_input >= 0), cost_output REAL NOT NULL CHECK (cost_output >= 0),
            cost_cache_read REAL NOT NULL CHECK (cost_cache_read >= 0), cost_cache_write REAL NOT NULL CHECK (cost_cache_write >= 0),
            cost_total REAL NOT NULL CHECK (cost_total >= 0), recorded_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS usage_gaps (
            gap_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES broker_sessions(session_id),
            context_id TEXT NOT NULL, cycle_id TEXT NOT NULL, reason TEXT NOT NULL, observed_at TEXT NOT NULL
         );
         INSERT OR IGNORE INTO schema_migrations(version, applied_at)
            VALUES (2, 'schema-v2-core-aggregates');
         COMMIT;",
    )?;
    let version: i64 = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    if version != SCHEMA_VERSION {
        return Err(StoreError::UnsupportedSchema(version));
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("session identities do not match")]
    SessionMismatch,
    #[error("projection revision or runtime generation does not match the event")]
    ProjectionMismatch,
    #[error("event sequence conflict: expected {expected}, received {actual}")]
    SequenceConflict { expected: u64, actual: u64 },
    #[error("session revision regressed from {current} to {incoming}")]
    RevisionRegression { current: u64, incoming: u64 },
    #[error("operation ID was reused for a different command: {0}")]
    OperationCollision(String),
    #[error("core aggregate revision conflict: expected {expected}, current revision is {actual}")]
    CoreRevisionConflict { expected: u64, actual: u64 },
    #[error("core aggregate is missing after a committed transaction: {0}")]
    MissingCoreAggregate(String),
    #[error("invalid core transaction: {0}")]
    InvalidCoreTransaction(&'static str),
    #[error("invalid usage entry: {0}")]
    InvalidUsage(&'static str),
    #[error("unsupported event-store schema version: {0}")]
    UnsupportedSchema(i64),
    #[error("replay limit must be between 1 and {MAX_REPLAY_EVENTS}, received {0}")]
    InvalidReplayLimit(usize),
    #[error("{0} counter overflow")]
    CounterOverflow(&'static str),
}
