use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct DownloadProgress {
    pub downloaded_bytes: usize,
    pub total_bytes: Option<u64>,
    pub percent: f32,
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => return Err(format!("Updater not initialized: {}", e)),
    };

    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateInfo {
            available: true,
            current_version: update.current_version.clone(),
            version: update.version.clone(),
            body: update.body.clone(),
            date: update.date.map(|d| d.to_string()),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(format!("Update check failed: {}", e)),
    }
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => return Err(format!("Updater not initialized: {}", e)),
    };

    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return Err("No update available".to_string()),
        Err(e) => return Err(format!("Update check failed: {}", e)),
    };

    let app_clone = app.clone();
    let mut downloaded = 0usize;

    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded += chunk_length;
                let percent = if let Some(total) = content_length {
                    if total > 0 {
                        (downloaded as f32 / total as f32) * 100.0
                    } else {
                        0.0
                    }
                } else {
                    0.0
                };

                let _ = app_clone.emit(
                    "update-download-progress",
                    DownloadProgress {
                        downloaded_bytes: downloaded,
                        total_bytes: content_length,
                        percent,
                    },
                );
            },
            || {
                println!("[Updater] Download complete, installing update...");
            },
        )
        .await
        .map_err(|e| format!("Failed to download and install update: {}", e))?;

    println!("[Updater] Update installed successfully, restarting app...");
    app.restart();
}

