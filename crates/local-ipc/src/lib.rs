#[cfg(unix)]
mod unix;

#[cfg(unix)]
pub use unix::{AuthToken, IpcClient, IpcConnection, IpcListener};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum IpcError {
    #[error("local IPC is unavailable on this platform")]
    UnsupportedPlatform,
    #[error("local IPC I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("local IPC frame is too large: {0} bytes")]
    FrameTooLarge(usize),
    #[error("local IPC frame is invalid: {0}")]
    InvalidFrame(String),
    #[error("local IPC authentication failed")]
    AuthenticationFailed,
    #[error("local IPC protocol version is incompatible")]
    ProtocolMismatch,
    #[error("local IPC handshake timed out")]
    HandshakeTimeout,
    #[error("authentication token is invalid")]
    InvalidToken,
    #[error("authentication token file permissions must be 0600")]
    InsecureTokenPermissions,
}
