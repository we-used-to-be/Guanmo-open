use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};
use tauri::AppHandle;
use url::Url;

// All updates (including legacy migration) share one file lock.
pub(crate) static SECRET_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApiConnection {
    pub kind: String,
    pub protocol: String,
    pub base_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigureApiConnection {
    connection: ApiConnection,
    value: Option<String>,
    #[serde(default)]
    remove: bool,
    #[serde(default)]
    migrate_legacy: bool,
    #[serde(default)]
    import_legacy: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiConnectionStatus {
    pub config_id: String,
    pub configured: bool,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct StoredConnection {
    pub connection: ApiConnection,
    pub key: String,
}

impl ApiConnection {
    pub(crate) fn normalize(mut self) -> Result<Self, String> {
        let allowed = match self.kind.as_str() {
            "chat" => self.protocol == "openai-chat",
            "embedding" => self.protocol == "openai-embedding",
            "search" => matches!(
                self.protocol.as_str(),
                "tavily" | "serper" | "brave" | "custom"
            ),
            _ => false,
        };
        if !allowed {
            return Err("不支持的 API 配置类型或协议".into());
        }
        if self.base_url.len() > 2048 {
            return Err("API 地址过长".into());
        }
        // Reject path encodings/dot traversal before URL parsing can normalize them away.
        let raw_path = self
            .base_url
            .split_once("://")
            .map(|(_, rest)| rest.split(['?', '#']).next().unwrap_or(""))
            .and_then(|rest| rest.find('/').map(|index| &rest[index..]))
            .unwrap_or("")
            .split(['?', '#'])
            .next()
            .unwrap_or("");
        let encoded_bypass = raw_path.as_bytes().windows(3).any(|bytes| {
            if bytes[0] != b'%' {
                return false;
            }
            let hex = std::str::from_utf8(&bytes[1..])
                .ok()
                .and_then(|hex| u8::from_str_radix(hex, 16).ok());
            hex.is_none_or(|value| value < 32 || value == 127 || b"./\\%?#".contains(&value))
        });
        if encoded_bypass
            || raw_path.contains('\\')
            || raw_path.split('/').any(|part| part == "." || part == "..")
        {
            return Err("API 地址不允许编码路径或路径跳转".into());
        }
        let mut url = Url::parse(&self.base_url).map_err(|_| "API 地址格式无效")?;
        if !matches!(url.scheme(), "https" | "http")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("API 地址格式无效".into());
        }
        if self.kind != "search" {
            if url.query().is_some() {
                return Err("API Base URL 不允许查询参数".into());
            }
            let path = url.path().trim_end_matches('/').to_owned();
            let path = if self.kind == "embedding" {
                path.trim_end_matches("/embeddings")
            } else {
                &path
            };
            url.set_path(path);
        } else {
            let expected = match self.protocol.as_str() {
                "tavily" => Some("https://api.tavily.com/search"),
                "serper" => Some("https://google.serper.dev/search"),
                "brave" => Some("https://api.search.brave.com/res/v1/web/search"),
                _ => None,
            };
            if expected.is_some_and(|expected| url.as_str() != expected) {
                return Err("搜索供应商地址不匹配".into());
            }
        }
        self.base_url = if self.kind == "search" {
            url.to_string()
        } else {
            url.to_string().trim_end_matches('/').to_owned()
        };
        Ok(self)
    }

    pub(crate) fn id(&self) -> String {
        let identity = format!("{}\n{}\n{}", self.kind, self.protocol, self.base_url);
        let encoded: String = identity
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        format!("connection:{encoded}")
    }

    fn legacy_key(&self) -> &'static str {
        match self.kind.as_str() {
            "chat" => "ai.apiKey",
            "embedding" => "embedding.apiKey",
            _ => "webSearch.apiKey",
        }
    }
}

pub(crate) fn read_connection(app: &AppHandle, id: &str) -> Result<StoredConnection, String> {
    let _lock = SECRET_LOCK.lock().map_err(|_| "安全存储不可用")?;
    let secrets = super::read_secret_map(&super::secret_file_path(app)?)?;
    let encrypted = secrets.get(id).ok_or("API 配置不存在")?;
    let record: StoredConnection = serde_json::from_str(&super::unprotect_secret(encrypted)?)
        .map_err(|_| "安全配置格式无效")?;
    if record.connection.clone().normalize()?.id() != id {
        return Err("API 配置身份不匹配".into());
    }
    Ok(record)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn configure_api_connection(
    app: AppHandle,
    request: ConfigureApiConnection,
) -> Result<ApiConnectionStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = super::secret_file_path(&app)?;
        configure_at_path(&path, request)
    })
    .await
    .map_err(|_| "安全配置任务失败".to_owned())?
}

fn configure_at_path(
    path: &PathBuf,
    request: ConfigureApiConnection,
) -> Result<ApiConnectionStatus, String> {
    let _lock = SECRET_LOCK.lock().map_err(|_| "安全存储不可用")?;
    let connection = request.connection.normalize()?;
    let id = connection.id();
    let mut secrets = super::read_secret_map(path)?;
    let existing: Option<StoredConnection> = secrets
        .get(&id)
        .map(|encrypted| {
            super::unprotect_secret(encrypted)
                .and_then(|text| serde_json::from_str(&text).map_err(|_| "安全配置格式无效".into()))
        })
        .transpose()?;
    // A metadata probe must not create encrypted records for each address keystroke.
    if request.value.is_none()
        && !request.remove
        && !request.migrate_legacy
        && !request.import_legacy
    {
        return Ok(ApiConnectionStatus {
            config_id: id,
            configured: existing
                .as_ref()
                .is_some_and(|record| !record.key.is_empty()),
        });
    }
    if let Some(record) = &existing {
        if request.value.as_ref().is_none_or(|value| value.is_empty())
            && !request.remove
            && !request.migrate_legacy
        {
            return Ok(ApiConnectionStatus {
                config_id: id,
                configured: !record.key.is_empty(),
            });
        }
    }
    let legacy_key = connection.legacy_key();
    let bind_legacy = request.migrate_legacy
        && !request.remove
        && request.value.as_ref().is_none_or(|value| value.is_empty())
        && existing.as_ref().is_none_or(|record| record.key.is_empty());
    let legacy = if bind_legacy {
        secrets
            .get(legacy_key)
            .map(|value| super::unprotect_secret(value))
            .transpose()?
    } else {
        None
    };
    let key = if request.remove {
        String::new()
    } else if request.import_legacy
        && existing
            .as_ref()
            .is_some_and(|record| !record.key.is_empty())
    {
        existing.as_ref().unwrap().key.clone()
    } else if let Some(value) = request.value.filter(|value| !value.is_empty()) {
        value
    } else {
        existing
            .map(|record| record.key)
            .filter(|key| !key.is_empty())
            .or(legacy)
            .unwrap_or_default()
    };
    if key.len() > 8192 || key.contains(['\r', '\n']) {
        return Err("API Key 格式无效".into());
    }
    let configured = !key.is_empty();
    let record = StoredConnection { connection, key };
    let value = serde_json::to_string(&record).map_err(|_| "安全配置编码失败")?;
    secrets.insert(id.clone(), super::protect_secret(&value)?);
    if request.migrate_legacy {
        secrets.remove(legacy_key);
    }
    // Migration and removal are committed together; the old file survives a failed write.
    super::write_secret_map(path, &secrets)?;
    Ok(ApiConnectionStatus {
        config_id: id,
        configured,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn connection(kind: &str, protocol: &str, url: &str) -> ApiConnection {
        ApiConnection {
            kind: kind.into(),
            protocol: protocol.into(),
            base_url: url.into(),
        }
    }
    #[test]
    fn identities_bind_kind_protocol_and_target() {
        let a = connection("chat", "openai-chat", "https://example.com/v1/")
            .normalize()
            .unwrap();
        assert_eq!(
            a.id(),
            connection("chat", "openai-chat", "https://example.com/v1")
                .normalize()
                .unwrap()
                .id()
        );
        assert_ne!(
            a.id(),
            connection("chat", "openai-chat", "https://other.example/v1")
                .normalize()
                .unwrap()
                .id()
        );
        assert_ne!(
            a.id(),
            connection("embedding", "openai-embedding", "https://example.com/v1")
                .normalize()
                .unwrap()
                .id()
        );
    }
    #[test]
    fn rejects_credentials_in_urls_and_forged_search_targets() {
        assert!(
            connection("chat", "openai-chat", "https://user:key@example.com/v1")
                .normalize()
                .is_err()
        );
        assert!(
            connection("search", "tavily", "https://other.example/search")
                .normalize()
                .is_err()
        );
        assert!(
            connection("chat", "anthropic-messages", "https://example.com")
                .normalize()
                .is_err()
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dpapi_migration_replace_delete_and_failed_write_preserve_old_file() {
        let directory = std::env::temp_dir().join(format!(
            "guanmo-credential-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("secrets.json");
        let mut old = std::collections::HashMap::new();
        old.insert(
            "ai.apiKey".into(),
            super::super::protect_secret("synthetic-legacy").unwrap(),
        );
        super::super::write_secret_map(&path, &old).unwrap();
        let make = |value: Option<&str>, remove, migrate_legacy| ConfigureApiConnection {
            connection: connection("chat", "openai-chat", "https://anonymous.example/v1"),
            value: value.map(str::to_owned),
            remove,
            migrate_legacy,
            import_legacy: false,
        };
        let temporary = path.with_extension("json.tmp");
        let original_legacy = std::fs::read(&path).unwrap();
        std::fs::create_dir(&temporary).unwrap();
        assert!(configure_at_path(&path, make(None, false, true)).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original_legacy);
        std::fs::remove_dir(&temporary).unwrap();
        let status = configure_at_path(&path, make(None, false, true)).unwrap();
        assert!(
            configure_at_path(&path, make(None, false, true))
                .unwrap()
                .configured
        );
        assert!(status.configured);
        let persisted = super::super::read_secret_map(&path).unwrap();
        assert!(!persisted.contains_key("ai.apiKey"));
        assert!(!std::fs::read_to_string(&path)
            .unwrap()
            .contains("synthetic-legacy"));
        assert!(
            configure_at_path(&path, make(Some(""), false, false))
                .unwrap()
                .configured
        );
        assert!(
            configure_at_path(&path, make(Some("synthetic-replacement"), false, false))
                .unwrap()
                .configured
        );
        let original = std::fs::read(&path).unwrap();
        // Force a temporary-file write failure; the committed file must remain intact.
        std::fs::create_dir(&temporary).unwrap();
        assert!(configure_at_path(&path, make(Some("synthetic-failed"), false, false)).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::remove_dir(&temporary).unwrap();
        assert!(
            !configure_at_path(&path, make(None, true, false))
                .unwrap()
                .configured
        );
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&directory).unwrap();
    }
}
