use std::path::Path;

use pi_tai_host_protocol::HostEvent;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

const SCHEMA_VERSION: i64 = 1;
const MAX_REPLAY_EVENTS: usize = 10_000;

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

#[derive(Debug, Clone, PartialEq)]
pub enum AppendOutcome {
    Committed,
    Duplicate { response: Value },
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
         INSERT OR IGNORE INTO schema_migrations(version, applied_at)
            VALUES (1, 'schema-v1');
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
    #[error("unsupported event-store schema version: {0}")]
    UnsupportedSchema(i64),
    #[error("replay limit must be between 1 and {MAX_REPLAY_EVENTS}, received {0}")]
    InvalidReplayLimit(usize),
    #[error("{0} counter overflow")]
    CounterOverflow(&'static str),
}
