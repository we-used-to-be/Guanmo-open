// Isolated native harness: imports the production MCP commands, never the application
// entry point, SQLite, user configuration or document/credential services.
#[path = "../../../../src-tauri/src/api_http_limits.rs"]
mod api_http_limits;
#[path = "../../../../src-tauri/src/mcp/mod.rs"]
mod mcp;
#[path = "../../../../src-tauri/src/network_target.rs"]
mod network_target;
#[path = "../../../../src-tauri/src/secret_protection.rs"]
mod secret_protection;
use tauri::Manager;

fn main() {
    let node = std::env::var("MCP_TEST_NODE").expect("MCP_TEST_NODE required");
    let fixture = std::env::var("MCP_TEST_FIXTURE").expect("MCP_TEST_FIXTURE required");
    let settings = std::env::var_os("MCP_SMOKE_SETTINGS").is_some();
    let config_root = std::env::var_os("MCP_SMOKE_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::temp_dir().join(format!("guanmo-mcp-config-native-{}", std::process::id()))
        });
    let config = serde_json::json!({ "serverId": "anonymous", "executable": node,
        "args": [fixture, "modern"], "cwd": std::env::temp_dir() });
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            app.manage(mcp::config::ConfigPath(
                config_root.join("mcp-servers.json"),
            ));
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App(
                    if settings {
                        "settings/index.html"
                    } else {
                        "index.html"
                    }
                    .into(),
                ),
            )
            .title("MCP Anonymous Smoke")
            .inner_size(960.0, 720.0)
            .data_directory(
                std::env::temp_dir().join(format!("guanmo-mcp-smoke-{}", std::process::id())),
            )
            .initialization_script(format!("window.smokeConfig = {};", config))
            .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mcp::config::mcp_list_servers,
            mcp::config::mcp_save_server,
            mcp::config::mcp_set_server_enabled,
            mcp::config::mcp_delete_server,
            mcp::oauth::mcp_authorize,
            mcp::oauth::mcp_cancel_authorize,
            mcp::oauth::mcp_revoke_authorization,
            mcp::mcp_register_stdio,
            mcp::mcp_connect,
            mcp::http::mcp_connect_http,
            mcp::mcp_cancel_connect,
            mcp::mcp_list_tools,
            mcp::mcp_list_resources,
            mcp::mcp_read_resource,
            mcp::mcp_list_prompts,
            mcp::mcp_get_prompt,
            mcp::mcp_prepare_call,
            mcp::mcp_confirm_call,
            mcp::mcp_cancel_call,
            mcp::mcp_disconnect
        ])
        .build(tauri::generate_context!())
        .expect("MCP native smoke build")
        .run(|_, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                mcp::shutdown();
            }
        });
}
