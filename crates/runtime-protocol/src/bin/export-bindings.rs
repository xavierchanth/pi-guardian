use std::{env, fs, path::PathBuf, process::ExitCode};

use pi_tai_runtime_protocol::generate_typescript_bindings;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let output = generate_typescript_bindings().map_err(|error| error.to_string())?;
    let target = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/runtime-protocol/src/generated.ts");
    if env::args().any(|arg| arg == "--check") {
        let current = fs::read_to_string(&target)
            .map_err(|error| format!("unable to read {}: {error}", target.display()))?;
        if current != output {
            return Err(format!(
                "generated runtime bindings are stale; run cargo run -p pi-tai-runtime-protocol --bin export-bindings"
            ));
        }
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("unable to create {}: {error}", parent.display()))?;
    }
    fs::write(&target, output)
        .map_err(|error| format!("unable to write {}: {error}", target.display()))
}
