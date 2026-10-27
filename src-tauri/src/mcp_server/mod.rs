//! Explicitly enabled local MCP server. Independent of the outbound MCP client.
mod network;
pub mod runtime;

use serde::{Deserialize, Serialize};
use serde_json::Value;

type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerConfig {
    paths: Vec<String>,
    artifact_keys: Vec<String>,
    read_documents: bool,
    search_knowledge: bool,
    read_artifacts: bool,
    #[serde(default)]
    write_documents: bool,
}

#[async_trait::async_trait]
trait Backend: Send + Sync {
    async fn call(&self, name: &str, arguments: Value) -> Result<Value>;
}
