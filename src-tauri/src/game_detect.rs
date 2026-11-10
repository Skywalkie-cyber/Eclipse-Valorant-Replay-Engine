use serde::{Deserialize, Serialize};
use std::mem::size_of;
use std::sync::RwLock;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GameDetectionStatus {
    pub is_running: bool,
    pub pid: Option<u32>,
    pub pids: Vec<u32>,
    pub process_name: Option<String>,
    pub riot_client_running: bool,
    pub status_text: String,
}

static CACHED_STATUS: RwLock<Option<(Instant, GameDetectionStatus)>> = RwLock::new(None);

/// High-performance cached status check with 1-second TTL.
/// Prevents expensive CreateToolhelp32Snapshot kernel calls on every single 60 FPS video frame!
pub fn get_cached_valorant_status() -> GameDetectionStatus {
    if let Ok(guard) = CACHED_STATUS.read() {
        if let Some((timestamp, ref status)) = *guard {
            if timestamp.elapsed() < Duration::from_millis(1000) {
                return status.clone();
            }
        }
    }

    let fresh = check_valorant_process();
    if let Ok(mut guard) = CACHED_STATUS.write() {
        *guard = Some((Instant::now(), fresh.clone()));
    }
    fresh
}

pub fn check_valorant_process() -> GameDetectionStatus {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return GameDetectionStatus {
                is_running: false,
                pid: None,
                pids: Vec::new(),
                process_name: None,
                riot_client_running: false,
                status_text: "Waiting for Valorant...".into(),
            };
        }

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;

        let mut is_val_running = false;
        let mut val_pid = None;
        let mut val_pids = Vec::new();
        let mut val_name = None;
        let mut is_riot_running = false;

        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let name = String::from_utf16_lossy(&entry.szExeFile)
                    .trim_matches(char::from(0))
                    .to_lowercase();

                if name.contains("valorant-win64-shipping.exe") {
                    is_val_running = true;
                    val_pids.push(entry.th32ProcessID);
                    val_pid = Some(entry.th32ProcessID); // Prefer the actual Shipping game engine process
                    val_name = Some(name.clone());
                } else if name == "valorant.exe" {
                    is_val_running = true;
                    val_pids.push(entry.th32ProcessID);
                    if val_pid.is_none() {
                        val_pid = Some(entry.th32ProcessID);
                        val_name = Some(name.clone());
                    }
                } else if name.contains("riotclient") {
                    is_riot_running = true;
                }

                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }

        CloseHandle(snapshot);

        let status_text = if is_val_running {
            format!("VALORANT ACTIVE (PID {})", val_pid.unwrap_or(0))
        } else if is_riot_running {
            "Riot Client Active (Valorant Not Launched)".into()
        } else {
            "Waiting for Valorant...".into()
        };

        GameDetectionStatus {
            is_running: is_val_running,
            pid: val_pid,
            pids: val_pids,
            process_name: val_name,
            riot_client_running: is_riot_running,
            status_text,
        }
    }
}

