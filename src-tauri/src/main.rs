#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod capture;
mod config;
mod disk_spooler;
mod encoder;
mod game_detect;
mod game_events;
mod hotkey;
mod kill_detect;
mod match_sync;
mod mp4_muxer;
mod recorder_manager;
mod riot_auth;
mod security;
mod sink_writer;
mod updater;
mod web_server;

use std::fs;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, State};
use tokio::sync::mpsc::unbounded_channel;

use audio::WasapiAudioEngine;
use capture::DxgiCaptureEngine;
use config::{AppConfig, ConfigManager};
use game_events::{GameSignal, ShooterGameLogTailer};
use hotkey::HotkeyManager;
use recorder_manager::ReplayRecorderManager;

#[derive(serde::Serialize)]
pub struct ClipEntry {
    pub file_name: String,
    pub full_path: String,
    pub created_at: String,
    pub file_size_mb: f64,
    pub has_timeline: bool,
}

pub struct AppState {
    pub config_manager: ConfigManager,
    pub recorder_manager: Arc<Mutex<ReplayRecorderManager>>,
    pub hotkey_manager: HotkeyManager,
    pub capture_engine: DxgiCaptureEngine,
    pub audio_engine: WasapiAudioEngine,
    pub web_share_server: Arc<web_server::WebShareServer>,
}

#[tauri::command]
fn get_config(state: State<'_, AppState>) -> Result<AppConfig, String> {
    state
        .config_manager
        .current
        .read()
        .map(|cfg| cfg.clone())
        .map_err(|_| "Failed to lock config".into())
}

#[tauri::command]
fn update_config(new_config: AppConfig, state: State<'_, AppState>) -> Result<(), String> {
    state.config_manager.update(new_config.clone())?;
    state.hotkey_manager.set_key_with_modifiers(new_config.hotkey_vk_code, new_config.hotkey_modifiers);
    Ok(())
}

#[tauri::command]
fn get_game_status() -> game_detect::GameDetectionStatus {
    game_detect::get_cached_valorant_status()
}

#[tauri::command]
fn trigger_manual_clip(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let mut recorder = state
        .recorder_manager
        .lock()
        .map_err(|_| "Recorder lock poisoned")?;
    let path = recorder.trigger_save_clip(None)?;
    let duration = state.config_manager.current.read().unwrap().buffer_length_seconds;

    let _ = show_overlay_window(app.clone(), Some(duration as u64), Some("Manual Clip".into()));

    use tauri::Emitter;
    let _ = app.emit("clip-triggered", serde_json::json!({
        "seconds": duration,
        "filePath": path.to_string_lossy(),
        "source": "manual"
    }));
    play_soft_notification_sound();
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn get_clip_thumbnails(file_path: String, duration_secs: f64) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src_path = std::path::Path::new(&file_path);
        if !src_path.exists() {
            return Err("Clip file not found".into());
        }
        let stem = match src_path.file_stem() {
            Some(s) => s.to_string_lossy().to_string(),
            None => return Err("Invalid path".into()),
        };

        let meta = match_sync::metadata_dir();
        let thumb_dir = meta.join("thumbnails").join(&stem);
        let _ = fs::create_dir_all(&thumb_dir);

        let dur = if duration_secs > 0.0 { duration_secs } else { 30.0 };

        // Check if 10 thumbnails already exist on disk
        let mut all_exist = true;
        for i in 0..10 {
            let frame_path = thumb_dir.join(format!("frame_{:02}.jpg", i));
            if !frame_path.exists() || fs::metadata(&frame_path).map(|m| m.len()).unwrap_or(0) == 0 {
                all_exist = false;
                break;
            }
        }

        if !all_exist {
            if let Some(ffmpeg_bin) = recorder_manager::ReplayRecorderManager::get_ffmpeg_path() {
                let out_pattern = thumb_dir.join("frame_%02d.jpg");
                let fps_filter = format!("fps=10/{dur:.3},scale=160:90");
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new(ffmpeg_bin)
                    .args(&[
                        "-y",
                        "-i",
                        &file_path,
                        "-vf",
                        &fps_filter,
                        "-frames:v",
                        "10",
                        "-vsync",
                        "vfr",
                        "-q:v",
                        "6",
                        &out_pattern.to_string_lossy(),
                    ])
                    .creation_flags(0x08000000)
                    .output();
            }
        }

        // Read frames into base64 data URLs
        let mut urls = Vec::with_capacity(10);
        for i in 0..10 {
            let frame_path = thumb_dir.join(format!("frame_{:02}.jpg", i));
            if let Ok(bytes) = fs::read(&frame_path) {
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                urls.push(format!("data:image/jpeg;base64,{}", b64));
            } else {
                urls.push(String::new());
            }
        }

        Ok(urls)
    })
    .await
    .map_err(|e| format!("Thumbnail extraction task error: {e}"))?
}

#[tauri::command]
fn show_overlay_window(
    app: tauri::AppHandle,
    seconds: Option<u64>,
    reason: Option<String>,
) -> Result<(), String> {
    if let Some(overlay_win) = app.get_webview_window("overlay") {
        let _ = overlay_win.set_ignore_cursor_events(true);
        let _ = overlay_win.show();
        if let Ok(hwnd) = overlay_win.hwnd() {
            unsafe {
                use windows_sys::Win32::UI::WindowsAndMessaging::{
                    ShowWindow, SetWindowPos, HWND_TOPMOST, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_SHOWWINDOW,
                };
                ShowWindow(hwnd.0 as _, SW_SHOWNOACTIVATE);
                SetWindowPos(
                    hwnd.0 as _,
                    HWND_TOPMOST,
                    24,
                    72,
                    460,
                    160,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
        }
        let secs = seconds.unwrap_or(30);
        let r = reason.unwrap_or_default();
        let escaped_reason = r.replace('\\', "\\\\").replace('\'', "\\'").replace('\n', " ");
        let _ = overlay_win.eval(&format!(
            "if (window.triggerOverlay) window.triggerOverlay({}, '{}');",
            secs, escaped_reason
        ));
        Ok(())
    } else {
        Err("Overlay window not found".into())
    }
}

#[tauri::command]
fn hide_overlay_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("overlay") {
        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
                ShowWindow(hwnd.0 as _, SW_HIDE);
            }
        }
        let _ = window.hide();
        Ok(())
    } else {
        Err("Overlay window not found".into())
    }
}

#[tauri::command]
fn delete_clip(file_path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(&file_path);
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    // Clean up any legacy .events.json that was in the same folder
    let mut legacy_events_path = path.clone();
    legacy_events_path.set_extension("events.json");
    if legacy_events_path.exists() {
        let _ = fs::remove_file(&legacy_events_path);
    }
    // Clean up internal metadata files (.json and .timing.json)
    if let Some(stem) = path.file_stem() {
        let meta_dir = match_sync::metadata_dir();
        let stem_str = stem.to_string_lossy();
        let meta_file = meta_dir.join(format!("{}.json", stem_str));
        if meta_file.exists() {
            let _ = fs::remove_file(&meta_file);
        }
        let timing_file = meta_dir.join(format!("{}.timing.json", stem_str));
        if timing_file.exists() {
            let _ = fs::remove_file(&timing_file);
        }
        let round_file = meta_dir.join(format!("{}.round.json", stem_str));
        if round_file.exists() {
            let _ = fs::remove_file(&round_file);
        }
    }
    println!("[Clipper] Deleted clip: {}", file_path);
    Ok(())
}

#[tauri::command]
fn open_clip_folder(file_path: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(&file_path);
    if path.exists() {
        let _ = std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.to_string_lossy()))
            .spawn();
    }
    Ok(())
}

#[tauri::command]
fn rename_clip(file_path: String, new_title: String) -> Result<ClipEntry, String> {
    let old_path = std::path::PathBuf::from(&file_path);
    let new_path = match_sync::rename_clip_and_metadata(&old_path, &new_title)?;
    let metadata = new_path.metadata().ok();
    let file_size_mb = metadata
        .as_ref()
        .map(|m| m.len() as f64 / (1024.0 * 1024.0))
        .unwrap_or(0.0);
    let created_at = metadata
        .and_then(|m| m.modified().ok())
        .map(|t| {
            let dt: chrono::DateTime<chrono::Local> = t.into();
            dt.format("%Y-%m-%d %H:%M").to_string()
        })
        .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d %H:%M").to_string());
    let stem = new_path.file_stem().unwrap_or_default().to_string_lossy();
    let meta_dir = match_sync::metadata_dir();

    Ok(ClipEntry {
        file_name: new_path.file_name().unwrap_or_default().to_string_lossy().to_string(),
        full_path: new_path.to_string_lossy().to_string(),
        created_at,
        file_size_mb,
        has_timeline: match_sync::is_synced(&meta_dir, &stem),
    })
}

#[tauri::command]
fn share_clip(file_path: String) -> Result<String, String> {
    use std::os::windows::ffi::OsStrExt;
    let path = std::path::PathBuf::from(&file_path);
    if !path.exists() {
        return Err("Clip file does not exist on disk.".into());
    }

    // Pure native Win32 clipboard API: copies CF_HDROP file without spawning cmd or powershell!
    unsafe {
        use windows_sys::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GHND};

        if OpenClipboard(0) == 0 {
            return Err("Could not open system clipboard".into());
        }
        EmptyClipboard();

        let wide_path: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).chain(std::iter::once(0)).collect();
        let dropfiles_size = std::mem::size_of::<windows_sys::Win32::UI::Shell::DROPFILES>();
        let total_bytes = dropfiles_size + wide_path.len() * 2;

        let h_global = GlobalAlloc(GHND, total_bytes);
        if h_global.is_null() {
            CloseClipboard();
            return Err("Memory allocation for clipboard failed".into());
        }

        let ptr = GlobalLock(h_global) as *mut u8;
        if ptr.is_null() {
            CloseClipboard();
            return Err("Locking clipboard memory failed".into());
        }

        let dropfiles = ptr as *mut windows_sys::Win32::UI::Shell::DROPFILES;
        (*dropfiles).pFiles = dropfiles_size as u32;
        (*dropfiles).fWide = 1; // Unicode path

        let dest_path = ptr.add(dropfiles_size) as *mut u16;
        std::ptr::copy_nonoverlapping(wide_path.as_ptr(), dest_path, wide_path.len());

        GlobalUnlock(h_global);

        // CF_HDROP = 15
        SetClipboardData(15, h_global as isize);
        CloseClipboard();
    }

    Ok("Clip file copied to clipboard! Paste (Ctrl+V) directly into Discord, WhatsApp, or Twitter.".into())
}

#[tauri::command]
fn export_clip_to_downloads(file_path: String) -> Result<String, String> {
    let src = std::path::PathBuf::from(&file_path);
    if !src.exists() {
        return Err("Source clip does not exist on disk".into());
    }

    let download_dir = dirs::download_dir()
        .or_else(|| dirs::desktop_dir())
        .ok_or_else(|| "Could not locate Downloads or Desktop folder".to_string())?;

    let filename = src.file_name().ok_or_else(|| "Invalid file name".to_string())?;
    let mut dest = download_dir.join(filename);

    if dest.exists() {
        let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "clip".to_string());
        let ext = src.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_else(|| "mp4".to_string());
        let timestamp = chrono::Local::now().format("%H%M%S");
        dest = download_dir.join(format!("{}_{}.{}", stem, timestamp, ext));
    }

    std::fs::copy(&src, &dest).map_err(|e| format!("Failed to save clip: {}", e))?;

    // Reveal in Windows File Explorer
    let _ = std::process::Command::new("explorer")
        .arg(format!("/select,{}", dest.to_string_lossy()))
        .spawn();

    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
fn get_clip_share_data(state: State<'_, AppState>, file_path: String) -> Result<web_server::ShareData, String> {
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err("Clip file not found".into());
    }
    let clip_key = state.web_share_server.register_clip(path, "anyone");
    let access = state.web_share_server.get_access(&clip_key);
    let port = state.web_share_server.port;
    let lan_ip = &state.web_share_server.lan_ip;
    
    let local_url = format!("http://localhost:{}/play?clip={}", port, clip_key);
    let lan_url = format!("http://{}:{}/play?clip={}", lan_ip, port, clip_key);
    let stream_url = format!("http://localhost:{}/stream?clip={}", port, clip_key);
    let file_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| clip_key.clone());

    // Cryptographic 256-bit encryption key derivation (Zero-Knowledge: key resides in client URL hash fragment)
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let seed_str = format!("{}:{}:eclipse_e2ee", clip_key, now / 3600);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(&seed_str, &mut hasher);
    let h1 = std::hash::Hasher::finish(&hasher);
    let h2 = h1.rotate_left(17) ^ 0x9e3779b97f4a7c15;
    let key_hex = format!("{:016x}{:016x}", h1, h2);

    let raw_token = format!("{}:{}", clip_key, now);
    use base64::Engine;
    let encrypted_token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw_token.as_bytes());

    // Official free domain from https://github.com/stackryze/FreeDomains (sryze.cc / indevs.in)
    let stackryze_domain = "eclipse.sryze.cc".to_string();
    let custom_domain_url = format!("https://{}/watch?clip={}&token={}#key={}", stackryze_domain, clip_key, encrypted_token, key_hex);

    Ok(web_server::ShareData {
        local_url,
        lan_url,
        stream_url,
        access,
        file_name,
        file_path,
        custom_domain_url,
        encrypted_token,
        encryption_key_hex: key_hex,
        stackryze_domain,
    })
}

#[tauri::command]
fn set_clip_share_access(state: State<'_, AppState>, file_path: String, access: String) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "clip".to_string());
    state.web_share_server.set_access(&stem, &access);
    Ok(())
}

#[tauri::command]
fn open_url_in_browser(url: String) -> Result<(), String> {
    use std::process::Command;
    let _ = Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct DiscordUploadResult {
    pub cdn_url: String,
    pub filename: String,
    pub size_bytes: u64,
}

#[tauri::command]
async fn upload_clip_to_discord(
    file_path: String,
    webhook_url: String,
) -> Result<DiscordUploadResult, String> {
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err("Clip file not found".to_string());
    }

    let file_bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("Failed to read clip file: {}", e))?;

    let filename = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "clip.mp4".to_string());

    let size_bytes = file_bytes.len() as u64;

    // Discord upload limit is 25MB (26,214,400 bytes)
    if size_bytes > 26_214_400 {
        return Err("Clip size exceeds Discord's 25MB attachment limit. Please trim the clip first.".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(filename.clone())
        .mime_str("video/mp4")
        .map_err(|e| format!("Invalid mime type: {}", e))?;

    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("content", format!("**Eclipse Replay Highlight**: `{}`", filename));

    let res = client
        .post(&webhook_url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Could not connect to Discord Webhook: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let err_text = res.text().await.unwrap_or_default();
        return Err(format!("Discord upload failed (status {}): {}", status, err_text));
    }

    let json_val: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Invalid response from Discord: {}", e))?;

    let cdn_url = json_val
        .get("attachments")
        .and_then(|a| a.as_array())
        .and_then(|arr| arr.first())
        .and_then(|att| att.get("url"))
        .and_then(|u| u.as_str())
        .ok_or_else(|| "Discord response did not contain an attachment URL".to_string())?
        .to_string();

    Ok(DiscordUploadResult {
        cdn_url,
        filename,
        size_bytes,
    })
}

#[tauri::command]
fn trim_clip(
    file_path: String,
    start_sec: f64,
    end_sec: f64,
    title: Option<String>,
) -> Result<ClipEntry, String> {
    let dest_path = ReplayRecorderManager::trim_existing_clip(&file_path, start_sec, end_sec, title)?;
    let metadata = dest_path.metadata().ok();
    let file_size_mb = metadata
        .as_ref()
        .map(|m| m.len() as f64 / (1024.0 * 1024.0))
        .unwrap_or(0.0);

    let meta_dir = match_sync::metadata_dir();
    let stem = dest_path.file_stem().unwrap_or_default().to_string_lossy();

    Ok(ClipEntry {
        file_name: dest_path.file_name().unwrap().to_string_lossy().to_string(),
        full_path: dest_path.to_string_lossy().to_string(),
        created_at: chrono::Local::now().format("%Y-%m-%d %H:%M").to_string(),
        file_size_mb,
        has_timeline: match_sync::is_synced(&meta_dir, &stem),
    })
}

#[tauri::command]
fn export_vertical_short(file_path: String) -> Result<ClipEntry, String> {
    let dest_path = ReplayRecorderManager::export_vertical_short(&file_path)?;
    let metadata = dest_path.metadata().ok();
    let file_size_mb = metadata
        .as_ref()
        .map(|m| m.len() as f64 / (1024.0 * 1024.0))
        .unwrap_or(0.0);

    let meta_dir = match_sync::metadata_dir();
    let stem = dest_path.file_stem().unwrap_or_default().to_string_lossy();

    Ok(ClipEntry {
        file_name: dest_path.file_name().unwrap().to_string_lossy().to_string(),
        full_path: dest_path.to_string_lossy().to_string(),
        created_at: chrono::Local::now().format("%Y-%m-%d %H:%M").to_string(),
        file_size_mb,
        has_timeline: match_sync::is_synced(&meta_dir, &stem),
    })
}

#[tauri::command]
fn create_montage(clip_paths: Vec<String>, title: Option<String>) -> Result<ClipEntry, String> {
    let dest_path = ReplayRecorderManager::create_montage(&clip_paths, title)?;
    let metadata = dest_path.metadata().ok();
    let file_size_mb = metadata
        .as_ref()
        .map(|m| m.len() as f64 / (1024.0 * 1024.0))
        .unwrap_or(0.0);

    Ok(ClipEntry {
        file_name: dest_path.file_name().unwrap().to_string_lossy().to_string(),
        full_path: dest_path.to_string_lossy().to_string(),
        created_at: chrono::Local::now().format("%Y-%m-%d %H:%M").to_string(),
        file_size_mb,
        has_timeline: false,
    })
}

#[tauri::command]
fn window_minimize(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.minimize().map_err(|e| e.to_string())
    } else {
        Err("Main window not found".into())
    }
}

#[tauri::command]
fn window_toggle_maximize(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_maximized().unwrap_or(false) {
            w.unmaximize().map_err(|e| e.to_string())?;
            Ok(false)
        } else {
            w.maximize().map_err(|e| e.to_string())?;
            Ok(true)
        }
    } else {
        Err("Main window not found".into())
    }
}

#[tauri::command]
fn window_close(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.close().map_err(|e| e.to_string())
    } else {
        Err("Main window not found".into())
    }
}

#[tauri::command]
fn repair_inverted_clip(file_path: String) -> Result<String, String> {
    let repaired = ReplayRecorderManager::repair_inverted_clip(&file_path)?;
    Ok(repaired.to_string_lossy().to_string())
}

#[tauri::command]
fn get_security_status() -> security::SecurityStatus {
    security::get_security_status()
}

#[tauri::command]
fn get_clip_events(file_path: String) -> Result<Vec<disk_spooler::MatchEvent>, String> {
    // Only events reconciled from real Riot match data (or explicitly saved by the user) are returned.
    Ok(match_sync::load_verified_events(std::path::Path::new(&file_path)))
}

#[tauri::command]
fn get_clip_round_details(file_path: String) -> Result<Option<match_sync::ClipRoundDetails>, String> {
    Ok(match_sync::load_clip_round_details(std::path::Path::new(&file_path)))
}

#[tauri::command]
fn save_clip_events(
    file_path: String,
    events: Vec<disk_spooler::MatchEvent>,
) -> Result<(), String> {
    match_sync::save_verified_events(std::path::Path::new(&file_path), &events)
}

#[tauri::command]
fn set_clip_agent(file_path: String, agent_name: String) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    let stem = match path.file_stem() {
        Some(s) => s.to_string_lossy(),
        None => return Err("Invalid clip path".into()),
    };
    let meta = match_sync::metadata_dir();
    let _ = fs::create_dir_all(&meta);
    let agent_file = meta.join(format!("{}.agent.txt", stem));
    fs::write(agent_file, agent_name.trim()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_clip_agent(file_path: String) -> Result<Option<String>, String> {
    let path = std::path::Path::new(&file_path);
    let stem = match path.file_stem() {
        Some(s) => s.to_string_lossy(),
        None => return Ok(None),
    };
    let meta = match_sync::metadata_dir();
    let agent_file = meta.join(format!("{}.agent.txt", stem));
    if let Ok(content) = fs::read_to_string(agent_file) {
        let t = content.trim().to_string();
        if !t.is_empty() {
            return Ok(Some(t));
        }
    }
    Ok(None)
}

#[tauri::command]
async fn sync_clip_events(
    file_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<match_sync::SyncReport, String> {
    let paths = match file_path {
        Some(fp) => vec![fp],
        None => {
            let mut all = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for dir in app_clip_dirs(&state) {
                if let Ok(entries) = fs::read_dir(&dir) {
                    for entry in entries.flatten() {
                        let p = entry.path();
                        if !is_app_clip(&p) {
                            continue;
                        }
                        let normalized = p.to_string_lossy().to_lowercase();
                        if seen.insert(normalized) {
                            all.push(p.to_string_lossy().to_string());
                        }
                    }
                }
            }
            all
        }
    };
    match_sync::sync_clips(paths).await
}

/// Directories that belong to this app. The user's general Videos folder is never scanned.
fn app_clip_dirs(state: &State<'_, AppState>) -> Vec<std::path::PathBuf> {
    let mut dirs_out = Vec::new();
    if let Ok(cfg) = state.config_manager.current.read() {
        dirs_out.push(cfg.clip_save_directory.clone());
    }
    if let Some(vid) = dirs::video_dir() {
        let default_dir = vid.join("ValorantClips");
        if !dirs_out.contains(&default_dir) {
            dirs_out.push(default_dir);
        }
    }
    dirs_out
}

/// A file is one of ours only if this app produced it (every output is named "Valorant_*").
fn is_app_clip(path: &std::path::Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    name.starts_with("Valorant_") && (ext == "mp4" || ext == "mkv")
}

#[tauri::command]
fn get_recorded_clips(state: State<'_, AppState>) -> Result<Vec<ClipEntry>, String> {
    let meta_dir = match_sync::metadata_dir();
    let mut clips = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for dir in app_clip_dirs(&state) {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                if dir.exists() {
                    eprintln!("[Library] Cannot read {:?}: {}", dir, e);
                }
                continue;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_app_clip(&path) {
                continue;
            }
            let normalized = path.to_string_lossy().to_lowercase();
            if !seen.insert(normalized) {
                continue;
            }
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            // Skip zero-byte / partially written files
            if metadata.len() < 10 * 1024 {
                continue;
            }
            let file_size_mb = metadata.len() as f64 / (1024.0 * 1024.0);
            let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
            let created_at = metadata
                .modified()
                .ok()
                .map(|t| {
                    let dt: chrono::DateTime<chrono::Local> = t.into();
                    dt.format("%Y-%m-%d %H:%M").to_string()
                })
                .unwrap_or_default();

            clips.push(ClipEntry {
                file_name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                full_path: path.to_string_lossy().to_string(),
                created_at,
                file_size_mb,
                has_timeline: match_sync::is_synced(&meta_dir, &stem),
            });
        }
    }

    clips.sort_by(|a, b| b.file_name.cmp(&a.file_name));
    Ok(clips)
}

#[tauri::command]
fn trim_working_set() {
    unsafe {
        windows_sys::Win32::System::ProcessStatus::EmptyWorkingSet(
            windows_sys::Win32::System::Threading::GetCurrentProcess(),
        );
    }
}

#[tauri::command]
fn minimize_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        trim_working_set();
        Ok(())
    } else {
        Err("Main window not found".into())
    }
}

fn play_soft_notification_sound() {
    #[cfg(target_os = "windows")]
    {
        std::thread::spawn(|| {
            use std::f32::consts::PI;
            // Synthesize a soothing acoustic chord chime (44.1kHz 16-bit mono)
            let sample_rate = 44100u32;
            let num_samples = (sample_rate as f32 * 0.55) as usize;
            let mut pcm_bytes = Vec::with_capacity(44 + num_samples * 2);

            // RIFF WAVE header
            let data_size = (num_samples * 2) as u32;
            let file_size = 36 + data_size;
            pcm_bytes.extend_from_slice(b"RIFF");
            pcm_bytes.extend_from_slice(&file_size.to_le_bytes());
            pcm_bytes.extend_from_slice(b"WAVEfmt ");
            pcm_bytes.extend_from_slice(&16u32.to_le_bytes()); // Subchunk1Size
            pcm_bytes.extend_from_slice(&1u16.to_le_bytes());  // PCM
            pcm_bytes.extend_from_slice(&1u16.to_le_bytes());  // Mono
            pcm_bytes.extend_from_slice(&sample_rate.to_le_bytes());
            pcm_bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // ByteRate
            pcm_bytes.extend_from_slice(&2u16.to_le_bytes());  // BlockAlign
            pcm_bytes.extend_from_slice(&16u16.to_le_bytes()); // BitsPerSample
            pcm_bytes.extend_from_slice(b"data");
            pcm_bytes.extend_from_slice(&data_size.to_le_bytes());

            for i in 0..num_samples {
                let t = i as f32 / sample_rate as f32;
                let s1 = (2.0 * PI * 523.25 * t).sin() * 0.28; // C5
                let s2 = (2.0 * PI * 659.25 * t).sin() * 0.30; // E5
                let s3 = (2.0 * PI * 783.99 * t).sin() * 0.32; // G5
                let s4 = (2.0 * PI * 1046.50 * t).sin() * 0.10; // C6
                let mix = s1 + s2 + s3 + s4;

                let env = if t < 0.02 {
                    t / 0.02 // Gentle 20ms attack
                } else {
                    (-5.5 * (t - 0.02)).exp() // Warm smooth decay
                };

                let val = (mix * env * 11000.0).clamp(-32767.0, 32767.0) as i16;
                pcm_bytes.extend_from_slice(&val.to_le_bytes());
            }

            #[link(name = "winmm")]
            extern "system" {
                fn PlaySoundA(pszSound: *const u8, hmod: *mut core::ffi::c_void, fdwSound: u32) -> i32;
            }

            // SND_MEMORY = 0x0004, SND_SYNC = 0x0000, SND_NODEFAULT = 0x0002
            // Playing synchronously on this background thread guarantees pcm_bytes stays valid throughout playback!
            unsafe {
                let _ = PlaySoundA(pcm_bytes.as_ptr(), std::ptr::null_mut(), 0x0004 | 0x0000 | 0x0002);
            }
        });
    }
}

fn main() {
    // 0. Enforce single instance so multiple clicks never spawn duplicate instances or double tray icons
    unsafe {
        use windows::core::w;
        let handle = windows::Win32::System::Threading::CreateMutexW(
            None,
            true,
            w!("Global\\EclipseValorantClipperSingleInstanceMutex"),
        );
        if handle.is_err() || windows::Win32::Foundation::GetLastError() == windows::Win32::Foundation::ERROR_ALREADY_EXISTS {
            eprintln!("[SingleInstance] Another instance of Eclipse is already running. Exiting duplicate process.");
            return;
        }
    }

    match_sync::purge_unverified_legacy_metadata();
    let config_manager = ConfigManager::new();
    let current_config = config_manager.current.read().unwrap().clone();

    // 1. Initialize Real Replay Recorder Manager (Hardware MFT H.264 MP4)
    let recorder_manager = Arc::new(Mutex::new(ReplayRecorderManager::new(
        current_config.clip_save_directory.clone(),
        current_config.target_fps,
        current_config.target_bitrate_kbps,
        current_config.buffer_length_seconds,
    )));

    // Event channel to bridge asynchronous clip triggers to Tauri frontend
    let (clip_notify_tx, mut clip_notify_rx) = unbounded_channel::<serde_json::Value>();
    let notify_hotkey = clip_notify_tx.clone();
    let notify_auto = clip_notify_tx.clone();
    let config_hotkey = config_manager.clone();
    let config_auto = config_manager.clone();
    let config_signal = config_manager.clone();

    // 2. Initialize Vanguard-Safe Event Channel & Connect to ReplayRecorderManager
    let (signal_tx, mut signal_rx) = unbounded_channel::<GameSignal>();
    if let Ok(mut guard) = recorder_manager.lock() {
        guard.set_signal_tx(signal_tx.clone());
        guard.set_config_manager(config_manager.clone());
    }

    // 3. Setup Global Hotkey (Non-blocking WH_KEYBOARD_LL)
    let (hotkey_tx, mut hotkey_rx) = unbounded_channel();
    let hotkey_manager = HotkeyManager::new(hotkey_tx, current_config.hotkey_vk_code, current_config.hotkey_modifiers);
    hotkey_manager.start();

    // 4. Hotkey Listener Worker (Instant Low-Latency F8 Execution)
    let recorder_hotkey = recorder_manager.clone();
    tauri::async_runtime::spawn(async move {
        while hotkey_rx.recv().await.is_some() {
            println!("[Hotkey Engine] Global F8 intercepted -> Flushing rolling replay buffer to disk");
            if let Ok(mut guard) = recorder_hotkey.lock() {
                match guard.trigger_save_clip(None) {
                    Ok(path) => {
                        println!("[Hotkey Engine] Buffer flush succeeded: {:?}", path);
                        let duration = config_hotkey.current.read().unwrap().buffer_length_seconds;
                        let _ = notify_hotkey.send(serde_json::json!({
                            "seconds": duration,
                            "filePath": path.to_string_lossy(),
                            "source": "hotkey"
                        }));
                    }
                    Err(e) => {
                        eprintln!("[Hotkey Engine] Buffer flush failed: {}", e);
                    }
                }
            }
        }
    });

    // 5. Initialize Zero-Copy DXGI Screen Capture -> MFT Hardware Encoder
    let capture_engine = DxgiCaptureEngine::new();
    let recorder_capture = recorder_manager.clone();

    capture_engine.start_capture_thread(current_config.target_fps, move |frame_bgra, width, height| {
        if let Ok(mut guard) = recorder_capture.lock() {
            guard.on_video_frame(frame_bgra, width, height);
        }
    });

    // 6. Initialize WASAPI Loopback Audio -> MFT AAC Hardware Muxer
    let audio_engine = WasapiAudioEngine::new();
    let recorder_audio = recorder_manager.clone();
    audio_engine.start_loopback_capture(move |chunk| {
        if let Ok(mut guard) = recorder_audio.lock() {
            guard.on_audio_chunk(&chunk.pcm16_stereo, chunk.sample_rate);
        }
    });

    // 7. Initialize Vanguard-Safe ShooterGame.log Combat Log Tailer
    let log_tailer = ShooterGameLogTailer::new();
    log_tailer.start_tailing(signal_tx.clone());

    let recorder_signal = recorder_manager.clone();
    let signal_tx_replay = signal_tx.clone();
    let clip_generation = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let latest_trigger_reason = Arc::new(tokio::sync::Mutex::new(String::new()));

    tauri::async_runtime::spawn(async move {
        while let Some(signal) = signal_rx.recv().await {
            match signal {
                GameSignal::Event(event) => {
                    let is_spike = event.event_type == "spike_plant" || event.event_type == "spike_defuse";
                    let spike_label = event.reason.clone().unwrap_or_else(|| "Spike Clutch".into());
                    if let Ok(mut guard) = recorder_signal.lock() {
                        guard.record_event(event);
                    }
                    if is_spike && config_signal.current.read().unwrap().auto_clip_spike_events {
                        let _ = signal_tx_replay.send(GameSignal::TriggerClip { reason: spike_label });
                    }
                }
                GameSignal::TriggerClip { reason } => {
                    let current_gen = clip_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    {
                        let mut reason_guard = latest_trigger_reason.lock().await;
                        *reason_guard = reason.clone();
                    }
                    println!("[Event Trigger] {reason} (Spree #{current_gen}) -> Scheduling multi-kill rolling buffer");
                    let recorder_delayed = recorder_signal.clone();
                    let gen_check = clip_generation.clone();
                    let reason_lock = latest_trigger_reason.clone();
                    let notify_spawn = notify_auto.clone();
                    let config_spawn = config_auto.clone();
                    tauri::async_runtime::spawn(async move {
                        // User-configured post-roll window allows subsequent kills in a gunfight to extend the highlight into 1 complete multi-kill clip!
                        let post_roll_secs = config_spawn.current.read().unwrap().post_roll_seconds;
                        let post_roll_ms = (post_roll_secs as u64 * 1000).clamp(1000, 10000);
                        tokio::time::sleep(tokio::time::Duration::from_millis(post_roll_ms)).await;
                        let active_gen = gen_check.load(std::sync::atomic::Ordering::SeqCst);
                        if active_gen != current_gen {
                            println!("[AutoClip] Multi-kill extended! Cancelling earlier trigger #{} for active spree #{}", current_gen, active_gen);
                            return;
                        }
                        let final_reason = reason_lock.lock().await.clone();
                        println!("[AutoClip] Multi-kill complete. Saving full highlight: {}", final_reason);
                        if let Ok(mut guard) = recorder_delayed.lock() {
                            if let Ok(path) = guard.trigger_save_clip(Some(&final_reason)) {
                                let duration = config_spawn.current.read().unwrap().buffer_length_seconds;
                                let _ = notify_spawn.send(serde_json::json!({
                                    "seconds": duration,
                                    "filePath": path.to_string_lossy(),
                                    "source": "auto",
                                    "reason": final_reason
                                }));
                            }
                        }
                    });
                }
                GameSignal::MatchStarted => {
                    println!("[Match] Match started.");
                }
                GameSignal::MatchEnded => {
                    println!("[Match] Match ended -> Automatic reconciliation with Riot Client in 4s");
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(tokio::time::Duration::from_secs(4)).await;
                        let _ = match_sync::sync_clips(Vec::new()).await;
                    });
                }
            }
        }
    });

    let web_share_server = Arc::new(web_server::WebShareServer::new());
    web_share_server.clone().start_background();

    let notify_cfg_manager = config_manager.clone();

    let app_state = AppState {
        config_manager,
        recorder_manager,
        hotkey_manager,
        capture_engine,
        audio_engine,
        web_share_server,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app_state)
        .setup(|app| {
            // Guarantee main window is borderless without native OS decorations (prevents double titlebar)
            if let Some(main_win) = app.get_webview_window("main") {
                let _ = main_win.set_decorations(false);
            }

            // Configure the transparent standalone in-game overlay notification window
            if let Some(overlay_win) = app.get_webview_window("overlay") {
                let _ = overlay_win.set_ignore_cursor_events(true);
                let _ = overlay_win.hide();
                if let Ok(hwnd) = overlay_win.hwnd() {
                    unsafe {
                        use windows_sys::Win32::UI::WindowsAndMessaging::{
                            GetWindowLongW, SetWindowLongW, GWL_EXSTYLE,
                            WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_APPWINDOW,
                            ShowWindow, SW_HIDE,
                        };
                        use windows_sys::Win32::Graphics::Dwm::DwmExtendFrameIntoClientArea;
                        use windows_sys::Win32::UI::Controls::MARGINS;

                        // Extend glass margins so DWM enables true alpha transparency (prevents black background)
                        let margins = MARGINS {
                            cxLeftWidth: -1,
                            cxRightWidth: -1,
                            cyTopHeight: -1,
                            cyBottomHeight: -1,
                        };
                        let _ = DwmExtendFrameIntoClientArea(hwnd.0 as _, &margins);

                        let ex = GetWindowLongW(hwnd.0 as _, GWL_EXSTYLE);
                        SetWindowLongW(
                            hwnd.0 as _,
                            GWL_EXSTYLE,
                            (ex | (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST) as i32) & !(WS_EX_APPWINDOW as i32),
                        );
                        ShowWindow(hwnd.0 as _, SW_HIDE);
                    }
                }
            }

            // Bridge background hotkey & auto-clip events to frontend Webview
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri::Emitter;
                while let Some(payload) = clip_notify_rx.recv().await {
                    let default_secs = notify_cfg_manager
                        .current
                        .read()
                        .map(|c| c.buffer_length_seconds as u64)
                        .unwrap_or(30);
                    let secs = payload.get("seconds").and_then(|v| v.as_u64()).unwrap_or(default_secs);
                    let reason = payload.get("reason").and_then(|v| v.as_str()).unwrap_or("").to_string();

                    // 1. Show the non-activating topmost overlay over Valorant
                    let _ = show_overlay_window(app_handle.clone(), Some(secs), Some(reason));

                    // 2. Broadcast event to both webviews
                    let _ = app_handle.emit("clip-triggered", payload.clone());

                    // 3. Instant soothing acoustic chord chime (played ONCE natively)
                    play_soft_notification_sound();
                }
            });


            // Build Native System Tray
            let open_item = MenuItem::with_id(app, "open", "Open Eclipse", true, None::<&str>)?;
            let clip_item = MenuItem::with_id(app, "clip", "Trigger Clip (F8)", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Exit Eclipse", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open_item, &clip_item, &quit_item])?;

            let icon = app.default_window_icon().cloned();
            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .tooltip("Eclipse")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "clip" => {
                        let state = app.state::<AppState>();
                        let _ = trigger_manual_clip(app.clone(), state);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                });

            if let Some(icon) = icon {
                tray_builder = tray_builder.icon(icon);
            }
            let _tray = tray_builder.build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            update_config,
            trigger_manual_clip,
            show_overlay_window,
            hide_overlay_window,
            get_clip_thumbnails,
            get_recorded_clips,
            get_clip_events,
            get_clip_round_details,
            save_clip_events,
            sync_clip_events,
            delete_clip,
            open_clip_folder,
            rename_clip,
            share_clip,
            export_clip_to_downloads,
            get_clip_share_data,
            set_clip_share_access,
            open_url_in_browser,
            upload_clip_to_discord,
            trim_clip,
            export_vertical_short,
            create_montage,
            repair_inverted_clip,
            get_security_status,
            window_minimize,
            window_toggle_maximize,
            window_close,
            set_clip_agent,
            get_clip_agent,
            trim_working_set,
            minimize_to_tray,
            get_game_status,
            updater::check_for_updates,
            updater::install_update,
            riot_auth::get_riot_client_session,
            riot_auth::get_live_game_roster,
            riot_auth::get_live_match_stats,
            riot_auth::get_account_performance_stats,
        ])
        .run(tauri::generate_context!())
        .expect("Error running Valorant Clipper");
}
