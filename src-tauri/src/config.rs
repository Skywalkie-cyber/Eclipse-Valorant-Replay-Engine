use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Resolution {
    Native,
    Res4k,
    Res1440p,
    Res1080p,
    Res720p,
}

impl Resolution {
    pub fn dimensions(&self, native_w: u32, native_h: u32) -> (u32, u32) {
        match self {
            Resolution::Native => (native_w, native_h),
            Resolution::Res4k => (3840, 2160),
            Resolution::Res1440p => (2560, 1440),
            Resolution::Res1080p => (1920, 1080),
            Resolution::Res720p => (1280, 720),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordingMode {
    InstantReplay, // Rolling buffer flushed on hotkey / kill
    FullMatchVod,  // Continuous match recording with timeline markers
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HardwareEncoder {
    Auto,
    Nvenc, // NVIDIA NVENC
    Amf,   // AMD AMF
    Qsv,   // Intel QuickSync
    Cpu,   // Software fallback
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioSettings {
    #[serde(default = "default_true")]
    pub capture_game_audio: bool, // WASAPI Loopback
    #[serde(default = "default_one_f32")]
    pub game_audio_volume: f32,    // 0.0 .. 1.0
    #[serde(default = "default_true")]
    pub capture_system_audio: bool, // Capture full Windows master audio (Discord, Spotify, Browser, Game)
    #[serde(default = "default_one_f32")]
    pub system_audio_volume: f32,  // 0.0 .. 1.0
    #[serde(default)]
    pub capture_microphone: bool, // Input Device
    #[serde(default = "default_point_eight_f32")]
    pub mic_volume: f32,           // 0.0 .. 1.0
    #[serde(default)]
    pub separate_audio_tracks: bool,
    #[serde(default)]
    pub push_to_talk: bool,
}

fn default_true() -> bool { true }
fn default_one_f32() -> f32 { 1.0 }
fn default_point_eight_f32() -> f32 { 0.8 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub mode: RecordingMode,
    pub resolution: Resolution,
    pub target_fps: u32,             // 30, 60, 120, 144
    pub target_bitrate_kbps: u32,    // 5,000 to 100,000 kbps (VBR)
    pub buffer_length_seconds: u32,  // 15, 30, 45, 60, 90, 120
    pub encoder: HardwareEncoder,
    pub audio: AudioSettings,
    
    // Smart auto-clipping triggers
    #[serde(default = "default_true")]
    pub auto_clip_kills: bool,
    #[serde(default = "default_true")]
    pub auto_clip_headshots: bool,
    #[serde(default = "default_true")]
    pub auto_clip_multikills: bool,
    #[serde(default = "default_true")]
    pub auto_clip_deaths: bool,
    #[serde(default = "default_true")]
    pub auto_clip_spike_events: bool,
    #[serde(default = "default_post_roll")]
    pub post_roll_seconds: u32,

    // Storage and performance
    pub clip_save_directory: PathBuf,
    pub hotkey_vk_code: u32,         // e.g., 0x77 for VK_F8
    #[serde(default = "default_hotkey_str")]
    pub hotkey_label: String,
    #[serde(default)]
    pub hotkey_modifiers: u32,       // 1 = Alt, 2 = Ctrl, 4 = Shift, 8 = Win
    #[serde(default = "default_mark_in_str")]
    pub hotkey_mark_in: String,      // Default: "["
    #[serde(default = "default_mark_out_str")]
    pub hotkey_mark_out: String,     // Default: "]"
    #[serde(default = "default_play_pause_str")]
    pub hotkey_play_pause: String,   // Default: "Space"
    #[serde(default = "default_max_storage")]
    pub max_storage_gb: u32,
    #[serde(default = "default_auto_delete_days")]
    pub auto_delete_days: u32,
    #[serde(default = "default_true")]
    pub low_memory_mode: bool,       // Keeps RAM <16MB
    #[serde(default = "default_true")]
    pub faststart_movflags: bool,    // Instant web streaming
    #[serde(default)]
    pub flip_vertical: bool,         // Invert top-down / bottom-up
}

fn default_post_roll() -> u32 { 3 }
fn default_hotkey_str() -> String { "F8".to_string() }
fn default_mark_in_str() -> String { "[".to_string() }
fn default_mark_out_str() -> String { "]".to_string() }
fn default_play_pause_str() -> String { "Space".to_string() }
fn default_max_storage() -> u32 { 50 }
fn default_auto_delete_days() -> u32 { 30 }

impl Default for AppConfig {
    fn default() -> Self {
        let default_clips = dirs::video_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ValorantClips");

        Self {
            mode: RecordingMode::InstantReplay,
            resolution: Resolution::Res1080p,
            target_fps: 60,
            target_bitrate_kbps: 25_000,
            buffer_length_seconds: 30,
            encoder: HardwareEncoder::Auto,
            audio: AudioSettings {
                capture_game_audio: true,
                game_audio_volume: 1.0,
                capture_system_audio: true,
                system_audio_volume: 1.0,
                capture_microphone: false,
                mic_volume: 0.8,
                separate_audio_tracks: false,
                push_to_talk: false,
            },
            auto_clip_kills: true,
            auto_clip_headshots: true,
            auto_clip_multikills: true,
            auto_clip_deaths: true,
            auto_clip_spike_events: true,
            post_roll_seconds: 3,
            clip_save_directory: default_clips,
            hotkey_vk_code: 0x77, // VK_F8
            hotkey_label: "F8".to_string(),
            hotkey_modifiers: 0,
            hotkey_mark_in: "[".to_string(),
            hotkey_mark_out: "]".to_string(),
            hotkey_play_pause: "Space".to_string(),
            max_storage_gb: 50,
            auto_delete_days: 30,
            low_memory_mode: true,
            faststart_movflags: true,
            flip_vertical: false,
        }
    }
}

#[derive(Clone)]
pub struct ConfigManager {
    file_path: PathBuf,
    pub current: Arc<RwLock<AppConfig>>,
}

impl ConfigManager {
    pub fn new() -> Self {
        let app_dir = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ValorantClipper");
        let _ = fs::create_dir_all(&app_dir);
        let file_path = app_dir.join("config.json");

        let initial_config = if file_path.exists() {
            fs::read_to_string(&file_path)
                .ok()
                .and_then(|data| serde_json::from_str(&data).ok())
                .unwrap_or_default()
        } else {
            let cfg = AppConfig::default();
            if let Ok(serialized) = serde_json::to_string_pretty(&cfg) {
                let _ = fs::write(&file_path, serialized);
            }
            cfg
        };

        Self {
            file_path,
            current: Arc::new(RwLock::new(initial_config)),
        }
    }

    pub fn update(&self, new_config: AppConfig) -> Result<(), String> {
        let serialized = serde_json::to_string_pretty(&new_config)
            .map_err(|e| format!("Serialization error: {e}"))?;

        let mut file = File::create(&self.file_path)
            .map_err(|e| format!("Failed to open config file: {e}"))?;
        file.write_all(serialized.as_bytes())
            .map_err(|e| format!("Write failed: {e}"))?;

        let mut writer = self.current.write().map_err(|_| "Config lock poisoned")?;
        *writer = new_config;
        Ok(())
    }
}

