//! Release 冷启动性能埋点。
//!
//! 统一时间基准：Rust 与 WebView 双方均使用 Unix epoch 毫秒。
//! Rust 侧通过 `SystemTime`（T0 在 Windows 上取 `GetProcessTimes` 的进程创建
//! 时刻），前端通过 `performance.timeOrigin + performance.now()` 换算，
//! 两侧对齐到同一系统时钟（误差通常为毫秒级）。
//!
//! 普通 Release 在启动完成后一次性上报现有关键点位，写入有界诊断日志。
//! `startup-metrics` feature 额外保留性能测试用的完整 JSONL 历史
//!（`app_config_dir/startup-metrics.jsonl`）。

use std::collections::HashMap;
#[cfg(feature = "startup-metrics")]
use std::io::Write;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use serde_json::{json, Map};
#[cfg(feature = "startup-metrics")]
use tauri::Manager;

#[cfg(feature = "startup-metrics")]
const METRICS_FILE: &str = "startup-metrics.jsonl";

/// 输出顺序固定的全部点位（与前端 T 点位约定一致，无 T3）。
///
/// Tauri 2.11 实际执行顺序（src/app.rs）：
/// `Builder::run()` → `build()` 内 `initialize_plugins()` 按注册顺序同步初始化
/// 用户插件与内置插件 → `App::run()` 事件循环 `Ready` 事件内创建配置窗口
/// （OS 窗口 + WebView2 环境/控制器）→ 执行用户 setup 回调 → 分发 RunEvent::Ready。
///
/// 因此 PLUGIN_NOTIFICATION_INITIALIZED → SETUP_CALLBACK_START 段包含：
/// 内置核心插件初始化（无法逐个拆分）+ build() 收尾 + 事件循环启动 +
/// 窗口/WebView2 创建（无法内部拆分）。HOOK 后缀点位经 run_on_main_thread
/// 消息分发，时刻受消息泵时序影响，仅作参考，非精确创建时刻。
const POINT_ORDER: [&str; 35] = [
    "T0_PROCESS_START",
    "T1_TAURI_SETUP_START",
    "RUN_PROLOGUE_DONE",
    "BUILDER_DEFAULT_DONE",
    "MANAGE_LIGHT_DONE",
    "TAURI_BUILDER_CREATED",
    "PLUGIN_INIT_BEGIN",
    "PLUGIN_SINGLE_INSTANCE_INITIALIZED",
    "PLUGIN_SQL_INITIALIZED",
    "PLUGIN_FS_INITIALIZED",
    "PLUGIN_DIALOG_INITIALIZED",
    "PLUGIN_SHELL_INITIALIZED",
    "PLUGIN_NOTIFICATION_INITIALIZED",
    "MAIN_WINDOW_CREATED_HOOK",
    "MAIN_WEBVIEW_CREATED_HOOK",
    "T2_WINDOW_CREATED",
    "SETUP_CALLBACK_START",
    "EVENT_LOOP_READY",
    "WEBVIEW_PAGE_LOAD_STARTED",
    "T4_HTML_START",
    "T5_DOM_READY",
    "T6_SKELETON_PAINT",
    "T7_MAIN_TS_START",
    "T8_REACT_RENDER_START",
    "T9_APP_MOUNTED",
    "T10_MAIN_UI_PAINT",
    "T11_WINDOW_SHOW",
    "T12_SESSION_RESTORED",
    "T13_DOCUMENT_VISIBLE",
    "DATABASE_READY",
    "SECRETS_HYDRATED",
    "APP_READY",
    "EDITOR_VISIBLE",
    "PREVIEW_VISIBLE",
    "PREVIEW_RENDER_COMPLETE",
];

static POINTS: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();

#[cfg(feature = "startup-metrics")]
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Windows：取真实进程创建时刻（延迟调用也返回创建时间，而非当前时间）。
#[cfg(target_os = "windows")]
fn process_creation_epoch_ms() -> u64 {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit_time = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut kernel_time = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut user_time = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit_time,
            &mut kernel_time,
            &mut user_time,
        )
    };
    if ok == 0 {
        return now_epoch_ms();
    }
    let raw = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    // FILETIME 为 1601-01-01 起的 100ns 计数；Unix epoch 偏移 116444736000000000。
    raw.saturating_sub(116_444_736_000_000_000) / 10_000
}

/// 非 Windows 平台：回退为当前时间（T0 与 T1 重合，仅用于开发环境）。
#[cfg(not(target_os = "windows"))]
fn process_creation_epoch_ms() -> u64 {
    now_epoch_ms()
}

fn insert_point(name: &str, epoch_ms: u64) {
    // get_or_init：首次插入时初始化容器（此前只用 get() 导致容器永远为 None，
    // Rust 侧 T0/T1/T2 被静默丢弃）。
    let points = POINTS.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut guard) = points.lock() {
        guard.entry(name.to_string()).or_insert(epoch_ms);
    }
}

/// T0：进程启动时刻。应在 `run()` 最开始调用（Windows 上任意时刻调用均可取回创建时刻）。
pub fn mark_process_start() {
    insert_point("T0_PROCESS_START", process_creation_epoch_ms());
}

/// 记录一个 Rust 侧点位（Unix epoch 毫秒）。
pub fn mark(point: &'static str) {
    insert_point(point, now_epoch_ms());
}

/// 插件初始化标记插件：`initialize` 钩子在 `build()` 内按注册顺序同步执行，
/// 交错插入真实插件之间即可测得各真实插件的初始化耗时边界。
/// 注意：用户插件先于 Tauri 内置核心插件初始化（register_core_plugins 追加在后）。
#[cfg(feature = "startup-metrics")]
pub struct InitMarkerPlugin {
    point: &'static str,
}

#[cfg(feature = "startup-metrics")]
pub fn init_marker(point: &'static str) -> InitMarkerPlugin {
    InitMarkerPlugin { point }
}

#[cfg(feature = "startup-metrics")]
impl<R: tauri::Runtime> tauri::plugin::Plugin<R> for InitMarkerPlugin {
    fn name(&self) -> &'static str {
        // 以点位名作为唯一插件名，避免与真实插件冲突
        self.point
    }

    fn initialize(
        &mut self,
        _app: &tauri::AppHandle<R>,
        _config: serde_json::Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        mark(self.point);
        Ok(())
    }
}

/// 窗口/WebView 创建与事件循环钩子观察插件。
///
/// 可观测边界说明：
/// - `window_created` / `webview_created` 钩子经 `run_on_main_thread` 消息分发，
///   触发时刻受消息泵时序影响，是创建时刻的近似参考（HOOK 后缀），非精确值；
/// - `on_event` 收到 `RunEvent::Ready` 在用户 setup 回调返回之后同步分发，
///   可精确标记 setup 体结束。
#[cfg(feature = "startup-metrics")]
pub struct HookObserverPlugin;

#[cfg(feature = "startup-metrics")]
pub fn hook_observer() -> HookObserverPlugin {
    HookObserverPlugin
}

#[cfg(feature = "startup-metrics")]
impl<R: tauri::Runtime> tauri::plugin::Plugin<R> for HookObserverPlugin {
    fn name(&self) -> &'static str {
        "guanmo-startup-hook-observer"
    }

    fn initialize(
        &mut self,
        _app: &tauri::AppHandle<R>,
        _config: serde_json::Value,
    ) -> Result<(), Box<dyn std::error::Error>> {
        Ok(())
    }

    fn window_created(&mut self, _window: tauri::Window<R>) {
        mark("MAIN_WINDOW_CREATED_HOOK");
    }

    fn webview_created(&mut self, _webview: tauri::Webview<R>) {
        mark("MAIN_WEBVIEW_CREATED_HOOK");
    }

    fn on_event(&mut self, _app: &tauri::AppHandle<R>, event: &tauri::RunEvent) {
        if matches!(event, tauri::RunEvent::Ready) {
            mark("EVENT_LOOP_READY");
        }
    }
}

/// 接收前端启动完成后一次性发送的点位，与 Rust 侧点位合并、计算分段耗时，
/// 并写入生产诊断日志；启用 feature 时额外追加原性能测试 JSONL。
#[tauri::command]
pub async fn record_startup_metrics(app: tauri::AppHandle, payload: Value) -> Result<(), String> {
    let record_json = build_record(&app, &payload);
    crate::diagnostics::record_startup(app.clone(), record_json.clone()).await?;
    #[cfg(feature = "startup-metrics")]
    {
        record(&app, record_json)
    }
    #[cfg(not(feature = "startup-metrics"))]
    {
        Ok(())
    }
}

fn segment_json(epoch: &HashMap<String, u64>, from: &str, to: &str) -> Value {
    let ms = match (epoch.get(from), epoch.get(to)) {
        (Some(from_ms), Some(to_ms)) => json!(*to_ms as i64 - *from_ms as i64),
        _ => Value::Null,
    };
    json!({ "from": from, "to": to, "ms": ms })
}

fn build_record(app: &tauri::AppHandle, payload: &Value) -> Value {
    let mut epoch: HashMap<String, u64> = HashMap::new();
    if let Some(points) = POINTS.get() {
        if let Ok(guard) = points.lock() {
            for (name, value) in guard.iter() {
                epoch.insert(name.clone(), *value);
            }
        }
    }
    if let Some(frontend_points) = payload.get("points").and_then(Value::as_object) {
        for (name, value) in frontend_points {
            if POINT_ORDER.contains(&name.as_str()) {
                if let Some(ms) = value.as_u64() {
                    epoch.insert(name.clone(), ms);
                }
            }
        }
    }

    // 各点位相对 T0 的耗时；缺失点位记为 null（例如无活动文档时 T13 不存在）。
    let t0 = epoch.get("T0_PROCESS_START").copied();
    let mut points_json = Map::new();
    let mut missing: Vec<&str> = Vec::new();
    for name in POINT_ORDER {
        match t0.zip(epoch.get(name).copied()) {
            Some((t0_ms, point_ms)) => {
                points_json.insert(name.to_string(), json!(point_ms as i64 - t0_ms as i64));
            }
            None => {
                missing.push(name);
                points_json.insert(name.to_string(), Value::Null);
            }
        }
    }

    json!({
        "schema": 2,
        "recordedAtEpochMs": now_epoch_ms(),
        "appVersion": app.package_info().version.to_string(),
        "points": points_json,
        "segments": {
            "tauriWebviewPre": segment_json(&epoch, "T0_PROCESS_START", "T4_HTML_START"),
            "webFirstPaint": segment_json(&epoch, "T4_HTML_START", "T10_MAIN_UI_PAINT"),
            "documentRestore": segment_json(&epoch, "T10_MAIN_UI_PAINT", "T13_DOCUMENT_VISIBLE"),
            "totalStartup": segment_json(&epoch, "T0_PROCESS_START", "T13_DOCUMENT_VISIBLE"),
            "tauriSetupTotal": segment_json(&epoch, "T1_TAURI_SETUP_START", "SETUP_CALLBACK_START"),
            "pluginInitTotal": segment_json(&epoch, "PLUGIN_INIT_BEGIN", "PLUGIN_NOTIFICATION_INITIALIZED"),
            "databaseReady": segment_json(&epoch, "T4_HTML_START", "DATABASE_READY"),
            "appReady": segment_json(&epoch, "T0_PROCESS_START", "APP_READY"),
            "editorVisible": segment_json(&epoch, "T0_PROCESS_START", "EDITOR_VISIBLE"),
            "previewVisible": segment_json(&epoch, "T0_PROCESS_START", "PREVIEW_VISIBLE"),
            "previewRenderComplete": segment_json(&epoch, "T0_PROCESS_START", "PREVIEW_RENDER_COMPLETE"),
        },
        "missingPoints": missing,
    })
}

#[cfg(feature = "startup-metrics")]
fn record(app: &tauri::AppHandle, record: Value) -> Result<(), String> {
    let line = serde_json::to_string(&record).map_err(|err| err.to_string())?;
    let dir = app.path().app_config_dir().map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "startup metrics write lock poisoned".to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(METRICS_FILE))
        .map_err(|err| err.to_string())?;
    writeln!(file, "{line}").map_err(|err| err.to_string())?;
    Ok(())
}
