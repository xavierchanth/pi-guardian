use std::{
    fs::{OpenOptions, read_to_string, set_permissions},
    io::Write,
    os::unix::{
        fs::{OpenOptionsExt, PermissionsExt},
        net::UnixStream as StdUnixStream,
    },
    path::{Path, PathBuf},
    time::Duration,
};

use pi_tai_host_protocol::{
    CURRENT_PROTOCOL_VERSION, ClientFrame, HostProtocolError, ImplementationInfo, ServerFrame,
};
use serde::{Serialize, de::DeserializeOwned};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
};
use uuid::Uuid;

use crate::IpcError;

const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq)]
pub struct AuthToken(String);

impl std::fmt::Debug for AuthToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("AuthToken([redacted])")
    }
}

impl AuthToken {
    pub fn generate() -> Self {
        Self(format!(
            "{}{}",
            Uuid::new_v4().simple(),
            Uuid::new_v4().simple()
        ))
    }

    pub fn parse(value: impl Into<String>) -> Result<Self, IpcError> {
        let value = value.into();
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(IpcError::InvalidToken);
        }
        Ok(Self(value.to_ascii_lowercase()))
    }

    pub fn load(path: &Path) -> Result<Self, IpcError> {
        let metadata = std::fs::metadata(path)?;
        if metadata.permissions().mode() & 0o777 != 0o600 {
            return Err(IpcError::InsecureTokenPermissions);
        }
        Self::parse(read_to_string(path)?.trim())
    }

    pub fn load_or_create(path: &Path) -> Result<Self, IpcError> {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
        {
            Ok(mut file) => {
                let token = Self::generate();
                file.write_all(token.0.as_bytes())?;
                file.write_all(b"\n")?;
                file.sync_all()?;
                Ok(token)
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Self::load(path),
            Err(error) => Err(error.into()),
        }
    }

    fn matches(&self, candidate: &str) -> bool {
        if candidate.len() != self.0.len() {
            return false;
        }
        self.0
            .bytes()
            .zip(candidate.bytes())
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0
    }
}

pub struct IpcListener {
    listener: UnixListener,
    socket_path: PathBuf,
    token: AuthToken,
    host: ImplementationInfo,
}

impl IpcListener {
    pub fn bind(
        socket_path: impl AsRef<Path>,
        token: AuthToken,
        host: ImplementationInfo,
    ) -> Result<Self, IpcError> {
        let socket_path = socket_path.as_ref().to_path_buf();
        let listener = match UnixListener::bind(&socket_path) {
            Ok(listener) => listener,
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                if StdUnixStream::connect(&socket_path).is_ok() {
                    return Err(error.into());
                }
                std::fs::remove_file(&socket_path)?;
                UnixListener::bind(&socket_path)?
            }
            Err(error) => return Err(error.into()),
        };
        set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))?;
        Ok(Self {
            listener,
            socket_path,
            token,
            host,
        })
    }

    pub async fn accept(&self) -> Result<IpcConnection, IpcError> {
        let (stream, _) = self.listener.accept().await?;
        let mut connection = IpcConnection { stream };
        let authentication: ClientFrame = connection.read().await?;
        let (protocol_version, token) = match authentication {
            ClientFrame::Authenticate {
                protocol_version,
                token,
                ..
            } => (protocol_version, token),
            ClientFrame::Command { .. } => {
                connection
                    .write(&auth_error("authentication_required"))
                    .await?;
                return Err(IpcError::AuthenticationFailed);
            }
        };
        if protocol_version != CURRENT_PROTOCOL_VERSION {
            connection.write(&auth_error("protocol_mismatch")).await?;
            return Err(IpcError::ProtocolMismatch);
        }
        if !self.token.matches(&token) {
            connection
                .write(&auth_error("authentication_failed"))
                .await?;
            return Err(IpcError::AuthenticationFailed);
        }
        connection
            .write(&ServerFrame::Authenticated {
                protocol_version: CURRENT_PROTOCOL_VERSION,
                host: self.host.clone(),
            })
            .await?;
        Ok(connection)
    }

    pub fn local_path(&self) -> &Path {
        &self.socket_path
    }
}

impl Drop for IpcListener {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

pub struct IpcClient;

impl IpcClient {
    pub async fn connect(
        socket_path: impl AsRef<Path>,
        token: &AuthToken,
        client: ImplementationInfo,
        timeout: Duration,
    ) -> Result<IpcConnection, IpcError> {
        tokio::time::timeout(timeout, async {
            let stream = UnixStream::connect(socket_path).await?;
            let mut connection = IpcConnection { stream };
            connection
                .write(&ClientFrame::Authenticate {
                    protocol_version: CURRENT_PROTOCOL_VERSION,
                    token: token.0.clone(),
                    client,
                })
                .await?;
            match connection.read::<ServerFrame>().await? {
                ServerFrame::Authenticated {
                    protocol_version, ..
                } if protocol_version == CURRENT_PROTOCOL_VERSION => Ok(connection),
                ServerFrame::Authenticated { .. } => Err(IpcError::ProtocolMismatch),
                ServerFrame::Error { .. }
                | ServerFrame::Response { .. }
                | ServerFrame::Event { .. } => Err(IpcError::AuthenticationFailed),
            }
        })
        .await
        .map_err(|_| IpcError::HandshakeTimeout)?
    }
}

pub struct IpcConnection {
    stream: UnixStream,
}

impl IpcConnection {
    pub async fn read<T: DeserializeOwned>(&mut self) -> Result<T, IpcError> {
        let length = self.stream.read_u32().await? as usize;
        if length > MAX_FRAME_BYTES {
            return Err(IpcError::FrameTooLarge(length));
        }
        let mut bytes = vec![0_u8; length];
        self.stream.read_exact(&mut bytes).await?;
        serde_json::from_slice(&bytes).map_err(|error| IpcError::InvalidFrame(error.to_string()))
    }

    pub async fn write<T: Serialize>(&mut self, value: &T) -> Result<(), IpcError> {
        let bytes =
            serde_json::to_vec(value).map_err(|error| IpcError::InvalidFrame(error.to_string()))?;
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(IpcError::FrameTooLarge(bytes.len()));
        }
        self.stream.write_u32(bytes.len() as u32).await?;
        self.stream.write_all(&bytes).await?;
        self.stream.flush().await?;
        Ok(())
    }
}

fn auth_error(code: &str) -> ServerFrame {
    ServerFrame::Error {
        error: HostProtocolError {
            code: code.into(),
            message: "Local IPC authentication failed.".into(),
            retryable: false,
            details: None,
        },
    }
}
