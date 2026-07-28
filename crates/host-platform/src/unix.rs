use std::{
    fs,
    io::{self, Read, Write},
    os::unix::{fs::PermissionsExt, net::UnixListener, net::UnixStream},
    path::{Path, PathBuf},
    sync::mpsc::{self, Sender},
    thread::{self, JoinHandle},
    time::Duration,
};

use crate::{ReadinessEndpoint, ReadinessStatus};

#[derive(Debug)]
pub struct UnixReadinessEndpoint {
    address: PathBuf,
    shutdown_tx: Option<Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl UnixReadinessEndpoint {
    pub fn bind(address: impl Into<PathBuf>, status: ReadinessStatus) -> io::Result<Self> {
        let address = address.into();
        let parent = address.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "socket path has no parent")
        })?;
        fs::create_dir_all(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;

        if address.exists() {
            if UnixStream::connect(&address).is_ok() {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "another readiness endpoint is responding",
                ));
            }
            fs::remove_file(&address)?;
        }

        let listener = UnixListener::bind(&address)?;
        fs::set_permissions(&address, fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        let response = serde_json::to_vec(&status)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let (shutdown_tx, shutdown_rx) = mpsc::channel();
        let thread_address = address.clone();
        let thread = thread::Builder::new()
            .name("pi-tai-readiness".into())
            .spawn(move || {
                loop {
                    if shutdown_rx.try_recv().is_ok() {
                        break;
                    }
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let _ = stream.write_all(&response);
                            let _ = stream.write_all(b"\n");
                        }
                        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(20));
                        }
                        Err(_) => break,
                    }
                }
                drop(listener);
                let _ = fs::remove_file(thread_address);
            })?;

        Ok(Self {
            address,
            shutdown_tx: Some(shutdown_tx),
            thread: Some(thread),
        })
    }
}

impl ReadinessEndpoint for UnixReadinessEndpoint {
    fn address(&self) -> &Path {
        &self.address
    }

    fn shutdown(&mut self) -> io::Result<()> {
        if let Some(sender) = self.shutdown_tx.take() {
            let _ = sender.send(());
        }
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| io::Error::other("readiness thread panicked"))?;
        }
        if self.address.exists() {
            fs::remove_file(&self.address)?;
        }
        Ok(())
    }
}

impl Drop for UnixReadinessEndpoint {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

pub fn probe_unix_readiness(address: impl AsRef<Path>) -> io::Result<ReadinessStatus> {
    let mut stream = UnixStream::connect(address)?;
    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    serde_json::from_str(response.trim())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    static NEXT_PATH: AtomicU64 = AtomicU64::new(1);

    fn temporary_socket() -> PathBuf {
        std::env::temp_dir().join(format!(
            "pi-tai-platform-test-{}-{}/ready.sock",
            std::process::id(),
            NEXT_PATH.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn status() -> ReadinessStatus {
        ReadinessStatus {
            status: "ready".into(),
            pid: std::process::id(),
            version: "test".into(),
        }
    }

    #[test]
    fn readiness_endpoint_is_private_probeable_and_cleaned_up() {
        let socket = temporary_socket();
        let parent = socket.parent().unwrap().to_path_buf();
        let mut endpoint = UnixReadinessEndpoint::bind(&socket, status()).unwrap();

        assert_eq!(probe_unix_readiness(&socket).unwrap(), status());
        assert_eq!(
            fs::metadata(&socket).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&parent).unwrap().permissions().mode() & 0o777,
            0o700
        );

        endpoint.shutdown().unwrap();
        assert!(!socket.exists());
        let _ = fs::remove_dir(parent);
    }

    #[test]
    fn a_live_endpoint_prevents_a_second_authority() {
        let socket = temporary_socket();
        let parent = socket.parent().unwrap().to_path_buf();
        let _endpoint = UnixReadinessEndpoint::bind(&socket, status()).unwrap();

        let error = UnixReadinessEndpoint::bind(&socket, status()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AddrInUse);

        drop(_endpoint);
        let _ = fs::remove_dir(parent);
    }

    #[test]
    fn stale_socket_is_replaced() {
        let socket = temporary_socket();
        let parent = socket.parent().unwrap().to_path_buf();
        fs::create_dir_all(&parent).unwrap();
        let stale = UnixListener::bind(&socket).unwrap();
        drop(stale);

        let endpoint = UnixReadinessEndpoint::bind(&socket, status()).unwrap();
        assert_eq!(probe_unix_readiness(&socket).unwrap(), status());

        drop(endpoint);
        let _ = fs::remove_dir(parent);
    }
}
