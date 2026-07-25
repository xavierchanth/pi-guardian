pub mod descriptors;
pub mod provenance;
pub mod resolve;
pub mod schema;

pub use descriptors::FIELD_DESCRIPTORS;
pub use provenance::{ConfigLayer, ConfigProvenance, ConfigScope, FieldDescriptor, FieldOrigin};
pub use resolve::{ConfigDocument, ProjectTrust, Resolution, Warning, resolve};
pub use schema::{ClientPreferences, ResolvedPiTaiConfig, SessionPolicy};
