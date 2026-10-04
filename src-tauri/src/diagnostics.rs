//! Production diagnostics. Only fixed event codes and numeric values reach disk.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_fs::FsExt;
use zip::write::SimpleFileOptions;

const LOG_COUNT: usize = 5;
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const RETAIN_DAYS: u64 = 7;
const MODE_FILE: &str = "diagnostics-mode.json";
static STATE: OnceLock<DiagnosticState> = OnceLock::new();

struct DiagnosticState {
    dir: PathBuf,
    session: String,
    detailed: AtomicBool,
    write_lock: Mutex<()>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticInput {
    event: String,
    status: String,
    duration_ms: Option<f64>,
    count: Option<u32>,
    code: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticRow<'a> {
    schema: u8,
    timestamp_ms: u64,
    session: &'a str,
    module: &'a str,
    event: &'a str,
    status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'a str>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn state_for(app: &tauri::AppHandle) -> Result<&'static DiagnosticState, String> {
    if let Some(state) = STATE.get() {
        return Ok(state);
    }
    let dir = app.path().app_log_dir().map_err(|_| "诊断目录不可用")?;
    fs::create_dir_all(&dir).map_err(|_| "无法创建诊断目录")?;
    let detailed = fs::read(dir.join(MODE_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.get("detailed").and_then(Value::as_bool))
        .unwrap_or(false);
    let state = DiagnosticState {
        dir,
        session: format!("{}-{}", now_ms(), std::process::id()),
        detailed: AtomicBool::new(detailed),
        write_lock: Mutex::new(()),
    };
    let _ = STATE.set(state);
    STATE.get().ok_or_else(|| "无法初始化诊断状态".into())
}

fn event_module(event: &str) -> Option<(&'static str, bool)> {
    match event {
        "app.start"
        | "app.exit"
        | "app.native_panic"
        | "app.js_error"
        | "app.unhandled_rejection" => Some(("app", false)),
        "file.read_failed" | "file.write_failed" => Some(("file", false)),
        "markdown.parse_failed" | "markdown.render_failed" => Some(("markdown", false)),
        "database.init_failed" | "database.query_failed" => Some(("database", false)),
        "ai.request_failed" => Some(("ai", false)),
        "agent.tool_failed" => Some(("agent", false)),
        "rag.index_failed" | "rag.search_failed" => Some(("rag", false)),
        "file.read_slow" | "markdown.parse_slow" | "markdown.render_slow" => Some((
            if event.starts_with("file.") {
                "file"
            } else {
                "markdown"
            },
            true,
        )),
        "database.init_slow" | "database.query_slow" => Some(("database", true)),
        "ai.request_slow" => Some(("ai", true)),
        "agent.tool_slow" => Some(("agent", true)),
        "rag.index_slow" | "rag.search_slow" => Some(("rag", true)),
        _ => None,
    }
}

fn allowed_tool(code: &str) -> bool {
    matches!(
        code,
        "search_memory"
            | "list_memories"
            | "save_memory"
            | "search_knowledge"
            | "search_reading_artifacts"
            | "get_reading_artifact"
            | "list_database_contents"
            | "read_selection_context"
            | "list_current_edit_targets"
            | "replace_current_tab_text"
            | "propose_save_reading_artifact"
            | "propose_create_markdown_note"
            | "propose_create_reading_reminder"
            | "read_context_file"
            | "web_search"
            | "get_current_time"
    )
}

fn log_path(dir: &Path, index: usize) -> PathBuf {
    dir.join(format!("diagnostics-{index}.jsonl"))
}

fn prune_expired(dir: &Path) {
    for index in 0..LOG_COUNT {
        let path = log_path(dir, index);
        let expired = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(RETAIN_DAYS * 86_400));
        if expired {
            let _ = fs::remove_file(path);
        }
    }
}

fn append_line(state: &DiagnosticState, line: &str) -> Result<(), String> {
    if line.len() as u64 > MAX_LOG_BYTES / 4 {
        return Err("诊断事件超过大小限制".into());
    }
    let _guard = state.write_lock.lock().map_err(|_| "诊断写入锁不可用")?;
    prune_expired(&state.dir);
    let current = log_path(&state.dir, 0);
    if fs::metadata(&current)
        .map(|metadata| metadata.len() + line.len() as u64 + 1 > MAX_LOG_BYTES)
        .unwrap_or(false)
    {
        for index in (1..LOG_COUNT).rev() {
            let from = log_path(&state.dir, index - 1);
            let to = log_path(&state.dir, index);
            if to.exists() {
                fs::remove_file(&to).map_err(|_| "诊断轮转失败")?;
            }
            if from.exists() {
                fs::rename(from, to).map_err(|_| "诊断轮转失败")?;
            }
        }
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(current)
        .map_err(|_| "无法打开诊断文件")?;
    writeln!(file, "{line}").map_err(|_| "诊断写入失败".to_string())
}

fn write_event(app: &tauri::AppHandle, input: DiagnosticInput) -> Result<(), String> {
    let (module, detailed_only) = event_module(&input.event).ok_or("未知诊断事件")?;
    if !matches!(input.status.as_str(), "ok" | "error" | "slow" | "cancelled") {
        return Err("未知诊断状态".into());
    }
    let state = state_for(app)?;
    if detailed_only && !state.detailed.load(Ordering::Relaxed) {
        return Ok(());
    }
    let duration_ms = input.duration_ms.and_then(|duration| {
        (duration.is_finite() && (0.0..=3_600_000.0).contains(&duration))
            .then_some(duration.round() as u64)
    });
    let row = DiagnosticRow {
        schema: 1,
        timestamp_ms: now_ms(),
        session: &state.session,
        module,
        event: &input.event,
        status: &input.status,
        duration_ms,
        count: input.count.map(|count| count.min(1_000_000)),
        code: input
            .code
            .as_deref()
            .filter(|code| module == "agent" && allowed_tool(code)),
    };
    let line = serde_json::to_string(&row).map_err(|_| "无法编码诊断事件")?;
    append_line(state, &line)
}

#[tauri::command]
pub async fn record_diagnostic_event(
    app: tauri::AppHandle,
    input: DiagnosticInput,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_event(&app, input))
        .await
        .map_err(|_| "诊断任务失败".to_string())?
}

pub fn record_exit(app: &tauri::AppHandle) {
    let _ = write_event(
        app,
        DiagnosticInput {
            event: "app.exit".into(),
            status: "ok".into(),
            duration_ms: None,
            count: None,
            code: None,
        },
    );
}

pub async fn record_startup(app: tauri::AppHandle, performance: Value) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = state_for(&app)?;
        let line = json!({
            "schema": 1,
            "timestampMs": now_ms(),
            "session": state.session,
            "module": "startup",
            "event": "startup.summary",
            "status": "ok",
            "performance": performance,
        });
        append_line(state, &line.to_string())
    })
    .await
    .map_err(|_| "启动指标任务失败".to_string())?
}

#[tauri::command]
pub async fn get_diagnostics_mode(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(state_for(&app)?.detailed.load(Ordering::Relaxed))
}

#[tauri::command]
pub async fn set_diagnostics_mode(app: tauri::AppHandle, detailed: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = state_for(&app)?;
        let path = state.dir.join(MODE_FILE);
        fs::write(path, json!({ "detailed": detailed }).to_string())
            .map_err(|_| "无法保存诊断模式")?;
        state.detailed.store(detailed, Ordering::Relaxed);
        Ok(())
    })
    .await
    .map_err(|_| "诊断模式任务失败".to_string())?
}

#[tauri::command]
pub async fn clear_diagnostics(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = state_for(&app)?;
        let _guard = state.write_lock.lock().map_err(|_| "诊断写入锁不可用")?;
        for index in 0..LOG_COUNT {
            let path = log_path(&state.dir, index);
            if path.exists() {
                fs::remove_file(path).map_err(|_| "清除诊断日志失败")?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|_| "清除诊断任务失败".to_string())?
}

#[tauri::command]
pub async fn open_diagnostics_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = state_for(&app)?.dir.clone();
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(dir)
            .spawn()
            .map(|_| ())
            .map_err(|_| "无法打开诊断目录".into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = dir;
        Err("当前平台暂不支持打开诊断目录".into())
    }
}

#[tauri::command]
pub async fn export_diagnostics_zip(app: tauri::AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || export_zip(&app, &path))
        .await
        .map_err(|_| "导出诊断任务失败".to_string())?
}

fn export_zip(app: &tauri::AppHandle, raw_path: &str) -> Result<(), String> {
    let requested = PathBuf::from(raw_path);
    if !requested
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
    {
        return Err("诊断导出仅支持 zip 文件".into());
    }
    let path = crate::normalized_target_path(&requested).map_err(|_| "导出路径无效")?;
    if !app.fs_scope().is_allowed(&path) {
        return Err("导出路径未经系统对话框授权".into());
    }
    let state = state_for(app)?;
    let (events, startup, event_count, startup_count) = {
        let _guard = state.write_lock.lock().map_err(|_| "诊断写入锁不可用")?;
        prune_expired(&state.dir);
        let mut events = String::new();
        let mut startup = String::new();
        let mut event_count = 0usize;
        let mut startup_count = 0usize;
        for index in (0..LOG_COUNT).rev() {
            let source = log_path(&state.dir, index);
            if !source.exists() {
                continue;
            }
            let file = fs::File::open(source).map_err(|_| "无法读取诊断文件")?;
            let mut content = String::new();
            file.take(MAX_LOG_BYTES + 1)
                .read_to_string(&mut content)
                .map_err(|_| "无法读取诊断文件")?;
            for line in content.lines() {
                if let Ok(value) = serde_json::from_str::<Value>(line) {
                    if value.get("event").and_then(Value::as_str) == Some("startup.summary") {
                        startup.push_str(line);
                        startup.push('\n');
                        startup_count += 1;
                    } else if value.get("schema").and_then(Value::as_u64) == Some(1) {
                        events.push_str(line);
                        events.push('\n');
                        event_count += 1;
                    }
                }
            }
        }
        (events, startup, event_count, startup_count)
    };
    write_zip(
        &path,
        &app.package_info().version.to_string(),
        &events,
        &startup,
        event_count,
        startup_count,
    )
}

fn write_zip(
    path: &Path,
    app_version: &str,
    events: &str,
    startup: &str,
    event_count: usize,
    startup_count: usize,
) -> Result<(), String> {
    let file = fs::File::create(path).map_err(|_| "无法创建诊断压缩包")?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, content) in [
        ("summary.json", json!({ "schema": 1, "exportedAtMs": now_ms(), "events": event_count, "startupSessions": startup_count }).to_string()),
        ("environment.json", json!({ "schema": 1, "appVersion": app_version, "os": std::env::consts::OS, "arch": std::env::consts::ARCH }).to_string()),
        ("performance/startup.jsonl", startup.to_string()),
        ("events/events.jsonl", events.to_string()),
    ] {
        zip.start_file(name, options).map_err(|_| "无法创建诊断压缩包条目")?;
        zip.write_all(content.as_bytes()).map_err(|_| "无法写入诊断压缩包")?;
    }
    zip.finish().map_err(|_| "无法完成诊断压缩包")?;
    Ok(())
}

pub fn install_panic_hook(app: tauri::AppHandle) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = write_event(
            &app,
            DiagnosticInput {
                event: "app.native_panic".into(),
                status: "error".into(),
                duration_ms: None,
                count: None,
                code: None,
            },
        );
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::{event_module, write_zip};
    use std::fs;
    use std::io::Read;

    #[test]
    fn event_whitelist_rejects_arbitrary_text() {
        assert!(event_module("file.read_failed").is_some());
        assert!(event_module("file.C:\\Users\\name\\private.md").is_none());
        assert!(event_module("ai.prompt=secret").is_none());
    }

    #[test]
    fn zip_has_versioned_sections_and_safe_sample() {
        let path = std::env::temp_dir().join(format!(
            "guanmo-diagnostics-test-{}-{}.zip",
            std::process::id(),
            super::now_ms()
        ));
        write_zip(
            &path,
            "1.9.0",
            "{\"event\":\"file.read_failed\"}\n",
            "{\"event\":\"startup.summary\"}\n",
            1,
            1,
        )
        .unwrap();
        let file = fs::File::open(&path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert_eq!(archive.len(), 4);
        let mut summary = String::new();
        archive
            .by_name("summary.json")
            .unwrap()
            .read_to_string(&mut summary)
            .unwrap();
        assert!(summary.contains("\"startupSessions\":1"));
        assert!(archive.by_name("environment.json").is_ok());
        assert!(archive.by_name("performance/startup.jsonl").is_ok());
        assert!(archive.by_name("events/events.jsonl").is_ok());
        drop(archive);
        fs::remove_file(path).unwrap();
    }
}
