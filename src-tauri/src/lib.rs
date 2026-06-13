// Revenant — library root
// IPC command handlers + plugin wiring.
// Sub-module stubs allow WS-B/C/D to fill implementations without editing this file.

pub mod ipc;

// Data-layer modules (WS-B implements these)
pub mod file_io;
pub mod annotations;
pub mod reanchor;
pub mod frontmatter;
pub mod paths;

// Settings + secrets + Obsidian modules (WS-D implements these)
pub mod settings;
pub mod secrets;
pub mod obsidian;

use tauri::Emitter;
use tauri_plugin_cli::CliExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_cli::init())
        .plugin(
            tauri_plugin_single_instance::init(|app, argv, _cwd| {
                // When a second instance is launched (e.g., `revenant another.md`),
                // forward the file path argument to the already-running instance via
                // the `open_file_request` event so the frontend can open a new tab.
                if let Some(path) = argv.get(1) {
                    let _ = app.emit("open_file_request", path);
                }
            }),
        )
        .setup(|app| {
            // Handle CLI argument on first launch
            match app.cli().matches() {
                Ok(matches) => {
                    if let Some(path_arg) = matches.args.get("file") {
                        if let serde_json::Value::String(path) = &path_arg.value {
                            let _ = app.emit("open_file_request", path);
                        }
                    }
                }
                Err(_) => {}
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::open_file,
            ipc::save_file,
            ipc::load_annotations,
            ipc::save_annotations,
            ipc::generate_review,
            ipc::export_obsidian,
            ipc::get_settings,
            ipc::set_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
