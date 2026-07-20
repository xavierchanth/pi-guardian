use std::{io, path::Path};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessStatus {
    pub status: String,
    pub pid: u32,
    pub version: String,
}

pub trait ReadinessEndpoint: Send {
    fn address(&self) -> &Path;
    fn shutdown(&mut self) -> io::Result<()>;
}

#[cfg(unix)]
mod unix;

#[cfg(unix)]
pub use unix::{UnixReadinessEndpoint, probe_unix_readiness};
