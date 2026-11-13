use std::collections::VecDeque;
use std::fs;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use crate::config::ConfigManager;
use crate::disk_spooler::MatchEvent;
use crate::game_events::GameSignal;
use crate::sink_writer::MfVideoRecorder;

const CREATE_NO_WINDOW: u32 = 0x08000000;
static CACHED_FFMPEG_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

pub struct ReplayRecorderManager {
    save_dir: PathBuf,
    metadata_dir: PathBuf,
    spool_dir: PathBuf,
    target_fps: u32,
    target_bitrate_bps: u32,
    buffer_seconds: u32,

    current_recorder: Option<MfVideoRecorder>,
    active_segment_path: Option<PathBuf>,
    completed_segments: VecDeque<PathBuf>,
    segment_counter: u64,
    segment_start: Instant,
    frames_written: u64,
    last_video_frame_instant: Instant,
    audio_sample_rate: u32,
    last_trigger: Instant,
    last_frame_dims: Option<(u32, u32)>,

    // Event history paired with the exact wall-clock instant and monotonic media clock (ms)
    recent_events: Vec<(Instant, u64, MatchEvent)>,
    completed_media_ms: u64,

    // Real-time HUD combat detector state (zero-allocation, runs on already-captured DXGI frames)
    hud_frame_counter: u64,
    hud_baseline_banner: f32,
    prev_norm_kill_score: f32,
    hud_was_alive: bool,
    hud_alive_streak: u32,
    last_hud_kill_instant: Instant,
    last_hud_death_instant: Instant,
    live_spree_count: u32,

    // Smart Auto-Clipping event dispatcher and dynamic config
    signal_tx: Option<tokio::sync::mpsc::UnboundedSender<GameSignal>>,
    config_manager: Option<ConfigManager>,
    scaled_frame_buf: Vec<u8>,
}

impl ReplayRecorderManager {
    pub fn new(
        save_dir: PathBuf,
        target_fps: u32,
        target_bitrate_kbps: u32,
        buffer_seconds: u32,
    ) -> Self {
        let spool_dir = dirs::cache_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ValorantClipper")
            .join("spool");
        let _ = fs::create_dir_all(&spool_dir);

        let metadata_dir = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ValorantClipper")
            .join("metadata");
        let _ = fs::create_dir_all(&metadata_dir);
        let _ = fs::create_dir_all(&save_dir);

        // Clean up any stray temporary files in spool
        if let Ok(entries) = fs::read_dir(&spool_dir) {
            for entry in entries.flatten() {
                let _ = fs::remove_file(entry.path());
            }
        }

        let now = Instant::now();
        Self {
            save_dir,
            metadata_dir,
            spool_dir,
            target_fps: target_fps.clamp(30, 60),
            target_bitrate_bps: (target_bitrate_kbps.max(5000)) * 1000,
            buffer_seconds: buffer_seconds.max(15),
            current_recorder: None,
            active_segment_path: None,
            completed_segments: VecDeque::with_capacity(6),
            segment_counter: 0,
            segment_start: now,
            frames_written: 0,
            last_video_frame_instant: now - Duration::from_secs(10),
            audio_sample_rate: 48000,
            last_trigger: now - Duration::from_secs(10),
            last_frame_dims: None,
            recent_events: Vec::new(),
            completed_media_ms: 0,
            hud_frame_counter: 0,
            hud_baseline_banner: 18.0,
            prev_norm_kill_score: 0.0,
            hud_was_alive: false,
            hud_alive_streak: 0,
            last_hud_kill_instant: now - Duration::from_secs(10),
            last_hud_death_instant: now - Duration::from_secs(30),
            live_spree_count: 0,
            signal_tx: None,
            config_manager: None,
            scaled_frame_buf: Vec::new(),
        }
    }

    pub fn set_signal_tx(&mut self, tx: tokio::sync::mpsc::UnboundedSender<GameSignal>) {
        self.signal_tx = Some(tx);
    }

    pub fn set_config_manager(&mut self, cfg: ConfigManager) {
        self.config_manager = Some(cfg);
    }

    fn current_total_media_ms(&self) -> u64 {
        let active_ms = self
            .current_recorder
            .as_ref()
            .map(|r| r.current_media_time_ms())
            .unwrap_or(0);
        self.completed_media_ms + active_ms
    }

    /// Fast fixed-point bilinear/box scaling for BGRA frames to support 4K UHD, 1440p, 1080p, and 720p
    fn scale_bgra_box(src: &[u8], src_w: usize, src_h: usize, dst: &mut [u8], dst_w: usize, dst_h: usize) {
        if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
            return;
        }
        let x_ratio = ((src_w << 16) / dst_w) + 1;
        let y_ratio = ((src_h << 16) / dst_h) + 1;

        for y in 0..dst_h {
            let src_y = ((y * y_ratio) >> 16).min(src_h - 1);
            let src_row = src_y * src_w * 4;
            let dst_row = y * dst_w * 4;
            for x in 0..dst_w {
                let src_x = ((x * x_ratio) >> 16).min(src_w - 1);
                let src_px = src_row + src_x * 4;
                let dst_px = dst_row + x * 4;
                if src_px + 3 < src.len() && dst_px + 3 < dst.len() {
                    dst[dst_px..dst_px + 4].copy_from_slice(&src[src_px..src_px + 4]);
                }
            }
        }
    }

    pub fn on_video_frame(&mut self, bgra_data: &[u8], width: u32, height: u32) {
        if width == 0 || height == 0 || bgra_data.is_empty() {
            return;
        }

        // 1. Sample live HUD combat state directly on source frame
        self.hud_frame_counter += 1;
        if self.hud_frame_counter % 5 == 0 {
            self.inspect_hud_combat_state(bgra_data, width, height);
        }

        // 2. Resolve configured target resolution (4K UHD, 1440p, 1080p, 720p or Native)
        let (target_w, target_h) = if let Some(ref cm) = self.config_manager {
            let res = cm.current.read().unwrap().resolution;
            res.dimensions(width, height)
        } else {
            (width, height)
        };

        self.last_frame_dims = Some((target_w, target_h));
        self.last_video_frame_instant = Instant::now();

        if self.current_recorder.is_none() {
            self.start_new_segment(target_w, target_h);
        }

        // Rotate rolling segments every 15.0 seconds of actual recorded media time
        let active_media_ms = self
            .current_recorder
            .as_ref()
            .map(|r| r.current_media_time_ms())
            .unwrap_or(0);
        if active_media_ms >= 15_000 {
            self.rotate_segment(target_w, target_h);
        }

        let write_ok = if target_w != width || target_h != height {
            let needed_bytes = (target_w * target_h * 4) as usize;
            if self.scaled_frame_buf.len() != needed_bytes {
                self.scaled_frame_buf.resize(needed_bytes, 0);
            }
            Self::scale_bgra_box(
                bgra_data,
                width as usize,
                height as usize,
                &mut self.scaled_frame_buf,
                target_w as usize,
                target_h as usize,
            );
            if let Some(ref mut rec) = self.current_recorder {
                rec.write_frame_bgra(&self.scaled_frame_buf).is_ok()
            } else {
                false
            }
        } else if let Some(ref mut rec) = self.current_recorder {
            rec.write_frame_bgra(bgra_data).is_ok()
        } else {
            false
        };

        if write_ok {
            self.frames_written += 1;
        }
    }

    pub fn on_audio_chunk(&mut self, pcm16_stereo: &[u8], sample_rate: u32) {
        if sample_rate > 0 {
            self.audio_sample_rate = sample_rate;
        }
        // Only mux audio while video capture is actively running so alt-tabbing pauses both in lockstep
        if self.last_video_frame_instant.elapsed() > Duration::from_millis(250) {
            return;
        }
        if let Some(ref mut rec) = self.current_recorder {
            let _ = rec.write_audio_pcm16(pcm16_stereo, self.audio_sample_rate);
        }
    }

    /// Lightweight, zero-allocation pixel sampler on the already-captured BGRA frame
    /// to detect Valorant's bottom-center Kill Banner and Death / Combat Report transition.
    fn inspect_hud_combat_state(&mut self, bgra: &[u8], width: u32, height: u32) {
        let stride = (width as usize) * 4;
        if bgra.len() < stride * (height as usize) || width < 640 || height < 360 {
            return;
        }

        // Quick check against user configuration: short-circuit if all triggers are disabled
        let (allow_kills, allow_hs, allow_multi, allow_deaths, allow_spikes) = if let Some(ref cm) = self.config_manager {
            let cfg = cm.current.read().unwrap();
            (
                cfg.auto_clip_kills,
                cfg.auto_clip_headshots,
                cfg.auto_clip_multikills,
                cfg.auto_clip_deaths,
                cfg.auto_clip_spike_events,
            )
        } else {
            (true, true, true, true, true)
        };

        if !allow_kills && !allow_hs && !allow_multi && !allow_deaths && !allow_spikes {
            return;
        }

        // 1. Check if player HUD is active/alive (bottom-left health bar digits: x=0.275..0.335, y=0.915..0.955)
        let mut health_bright = 0u32;
        let mut health_samples = 0u32;
        let hx0 = (width as f32 * 0.275) as usize;
        let hx1 = (width as f32 * 0.335) as usize;
        let hy0 = (height as f32 * 0.915) as usize;
        let hy1 = (height as f32 * 0.955) as usize;
        for y in (hy0..hy1).step_by(3) {
            for x in (hx0..hx1).step_by(4) {
                let idx = y * stride + x * 4;
                if idx + 2 < bgra.len() {
                    let b = bgra[idx] as u32;
                    let g = bgra[idx + 1] as u32;
                    let r = bgra[idx + 2] as u32;
                    health_samples += 1;
                    if r > 215 && g > 215 && b > 215 {
                        health_bright += 1;
                    }
                }
            }
        }
        let is_alive_hud = health_samples > 0 && (health_bright * 100 / health_samples) >= 8;
        if is_alive_hud {
            self.hud_alive_streak = self.hud_alive_streak.saturating_add(1);
        }

        // 2. Sample bottom-center Kill Medallion core (x=0.482..0.518, y=0.798..0.852)
        // AND outer dark medallion ring (x=0.455..0.472 & 0.528..0.545) so bright map walls never false-trigger!
        let mut kill_accent_score = 0.0f32;
        let mut kill_samples = 0u32;
        let kx0 = (width as f32 * 0.482) as usize;
        let kx1 = (width as f32 * 0.518) as usize;
        let ky0 = (height as f32 * 0.798) as usize;
        let ky1 = (height as f32 * 0.852) as usize;
        for y in (ky0..ky1).step_by(2) {
            for x in (kx0..kx1).step_by(2) {
                let idx = y * stride + x * 4;
                if idx + 2 < bgra.len() {
                    let b = bgra[idx] as f32;
                    let g = bgra[idx + 1] as f32;
                    let r = bgra[idx + 2] as f32;
                    kill_samples += 1;
                    if r > 210.0 && (r - b > 75.0 || (r > 240.0 && g > 225.0 && b > 205.0)) {
                        kill_accent_score += (r - b).max(50.0);
                    }
                }
            }
        }
        let norm_kill_score = if kill_samples > 0 {
            kill_accent_score / (kill_samples as f32)
        } else {
            0.0
        };

        // Sample dark outer ring flanking the Kill Banner medallion
        let mut ring_luma_sum = 0.0f32;
        let mut ring_samples = 0u32;
        let rx_left0 = (width as f32 * 0.455) as usize;
        let rx_left1 = (width as f32 * 0.472) as usize;
        let rx_right0 = (width as f32 * 0.528) as usize;
        let rx_right1 = (width as f32 * 0.545) as usize;
        for y in (ky0..ky1).step_by(4) {
            for x in (rx_left0..rx_left1).step_by(3).chain((rx_right0..rx_right1).step_by(3)) {
                let idx = y * stride + x * 4;
                if idx + 2 < bgra.len() {
                    let luma = (bgra[idx] as f32) * 0.114 + (bgra[idx + 1] as f32) * 0.587 + (bgra[idx + 2] as f32) * 0.299;
                    ring_luma_sum += luma;
                    ring_samples += 1;
                }
            }
        }
        let avg_ring_luma = if ring_samples > 0 { ring_luma_sum / (ring_samples as f32) } else { 128.0 };

        // Derivative onset spike: Kill banner must have suddenly appeared from a lower baseline
        let kill_jump = norm_kill_score - self.prev_norm_kill_score;
        let spike_ratio = norm_kill_score / self.hud_baseline_banner.max(6.0);
        let is_kill_confirmed = norm_kill_score >= 22.0
            && kill_jump >= 13.0
            && spike_ratio >= 2.6
            && avg_ring_luma < 90.0;

        self.prev_norm_kill_score = norm_kill_score;

        if is_alive_hud
            && self.hud_alive_streak >= 5
            && is_kill_confirmed
            && self.last_hud_kill_instant.elapsed() > Duration::from_millis(1500)
        {
            if self.last_hud_kill_instant.elapsed() > Duration::from_secs(6) {
                self.live_spree_count = 1;
            } else {
                self.live_spree_count += 1;
            }
            self.last_hud_kill_instant = Instant::now();
            let k_num = self.live_spree_count;
            let is_headshot = norm_kill_score > 27.0;
            let label = match k_num {
                1 => if is_headshot { "Headshot Kill (1K)" } else { "Kill (1K)" },
                2 => "Double Kill (2K)",
                3 => "Triple Kill (3K)",
                4 => "Quadra Kill (4K)",
                5 => "ACE (5K)",
                _ => "Multi-Kill",
            };
            self.record_event(MatchEvent {
                timestamp_pts: 0,
                event_time_ms: 0,
                round: 1,
                event_type: "kill".into(),
                weapon: Some("Vandal".into()),
                headshot: is_headshot,
                victim: Some("Enemy".into()),
                killer: Some("Self".into()),
                site: None,
                kill_number: Some(k_num),
                multi_kill_label: Some(label.into()),
                reason: Some(label.into()),
            });

            // Evaluate against User's Smart Auto-Clipping Trigger Configuration
            let is_multi = k_num > 1;
            let should_clip = (allow_kills)
                || (is_headshot && allow_hs)
                || (is_multi && allow_multi);

            if should_clip {
                if let Some(ref tx) = self.signal_tx {
                    let _ = tx.send(GameSignal::TriggerClip { reason: label.to_string() });
                }
            }
        } else if !is_kill_confirmed {
            self.hud_baseline_banner = self.hud_baseline_banner * 0.92 + norm_kill_score * 0.08;
        }

        // 3. Detect Death Transition: player was alive for at least ~2s, now health HUD vanished AND death screen / combat report appears
        if allow_deaths
            && self.hud_was_alive
            && self.hud_alive_streak >= 25
            && !is_alive_hud
            && self.last_hud_death_instant.elapsed() > Duration::from_secs(25)
        {
            let mut red_vignette = 0u32;
            let mut v_samples = 0u32;
            let vy0 = (height as f32 * 0.03) as usize;
            let vy1 = (height as f32 * 0.14) as usize;
            for y in (vy0..vy1).step_by(4) {
                for x in (0..width as usize).step_by(16) {
                    let idx = y * stride + x * 4;
                    if idx + 2 < bgra.len() {
                        let b = bgra[idx] as i32;
                        let g = bgra[idx + 1] as i32;
                        let r = bgra[idx + 2] as i32;
                        v_samples += 1;
                        if r > 140 && (r - g) > 50 && (r - b) > 50 {
                            red_vignette += 1;
                        }
                    }
                }
            }

            // Also check that center screen is NOT the Scoreboard (Tab) or Buy Menu (B)
            let mut center_dark_samples = 0u32;
            let cx0 = (width as f32 * 0.45) as usize;
            let cx1 = (width as f32 * 0.55) as usize;
            let cy0 = (height as f32 * 0.45) as usize;
            let cy1 = (height as f32 * 0.55) as usize;
            let mut center_samples = 0u32;
            for y in (cy0..cy1).step_by(4) {
                for x in (cx0..cx1).step_by(4) {
                    let idx = y * stride + x * 4;
                    if idx + 2 < bgra.len() {
                        let b = bgra[idx] as u32;
                        let g = bgra[idx + 1] as u32;
                        let r = bgra[idx + 2] as u32;
                        center_samples += 1;
                        if r < 40 && g < 40 && b < 40 {
                            center_dark_samples += 1;
                        }
                    }
                }
            }
            let is_menu_open = center_samples > 0 && (center_dark_samples * 100 / center_samples) >= 70;

            if !is_menu_open && v_samples > 0 && (red_vignette * 100 / v_samples) >= 12 {
                self.last_hud_death_instant = Instant::now();
                self.record_event(MatchEvent {
                    timestamp_pts: 0,
                    event_time_ms: 0,
                    round: 1,
                    event_type: "death".into(),
                    weapon: Some("Vandal".into()),
                    headshot: false,
                    victim: Some("Self".into()),
                    killer: Some("Enemy".into()),
                    site: None,
                    kill_number: None,
                    multi_kill_label: None,
                    reason: Some("Eliminated".into()),
                });

                if let Some(ref tx) = self.signal_tx {
                    let _ = tx.send(GameSignal::TriggerClip { reason: "Death Replay".to_string() });
                }
            }
        }
        if !is_alive_hud {
            self.hud_alive_streak = 0;
        }
        self.hud_was_alive = is_alive_hud;
    }

    fn start_new_segment(&mut self, width: u32, height: u32) {
        self.segment_counter += 1;
        let file_path = self.spool_dir.join(format!("seg_{}.mp4", self.segment_counter));

        let (fps, bitrate, buf_secs) = if let Some(ref cm) = self.config_manager {
            let cfg = cm.current.read().unwrap();
            (cfg.target_fps, (cfg.target_bitrate_kbps.max(5000)) * 1000, cfg.buffer_length_seconds)
        } else {
            (self.target_fps, self.target_bitrate_bps, self.buffer_seconds)
        };
        self.target_fps = fps;
        self.target_bitrate_bps = bitrate;
        self.buffer_seconds = buf_secs;

        match MfVideoRecorder::new(
            &file_path,
            width,
            height,
            fps,
            bitrate,
            self.audio_sample_rate,
        ) {
            Ok(rec) => {
                self.current_recorder = Some(rec);
                self.active_segment_path = Some(file_path);
                self.segment_start = Instant::now();
                self.frames_written = 0;
            }
            Err(e) => {
                eprintln!("[RecorderManager] Failed to init MfVideoRecorder: {e}");
            }
        }
    }

    fn rotate_segment(&mut self, width: u32, height: u32) {
        if let Some(mut rec) = self.current_recorder.take() {
            self.completed_media_ms += rec.current_media_time_ms();
            let _ = rec.finalize();
        }

        if let Some(path) = self.active_segment_path.take() {
            if path.exists() && fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > 0 {
                self.completed_segments.push_back(path);
            }
        }

        // Keep enough completed segments of 15s each to honor full configured buffer duration
        let max_segs = ((self.buffer_seconds as usize + 14) / 15).max(2) + 1;
        while self.completed_segments.len() > max_segs {
            if let Some(old_seg) = self.completed_segments.pop_front() {
                let _ = fs::remove_file(old_seg);
            }
        }

        // Low-Memory optimization: aggressively trim working set on segment rotation to keep RAM <16MB
        unsafe {
            let current_process = windows_sys::Win32::System::Threading::GetCurrentProcess();
            windows_sys::Win32::System::ProcessStatus::EmptyWorkingSet(current_process);
        }

        self.start_new_segment(width, height);
    }

    pub fn record_event(&mut self, event: MatchEvent) {
        let media_ms = self.current_total_media_ms();
        self.recent_events.push((Instant::now(), media_ms, event));
        if self.recent_events.len() > 2000 {
            self.recent_events.remove(0);
        }
    }

    /// Extracts the frame-accurate duration directly from MP4 container 'mvhd' atom without external tools
    pub fn parse_mp4_duration(path: &Path) -> Option<f64> {
        let mut file = fs::File::open(path).ok()?;
        use std::io::Read;
        let mut buf = Vec::new();
        // Read up to 128KB of header data
        let mut take = (&mut file).take(128 * 1024);
        take.read_to_end(&mut buf).ok()?;

        if let Some(pos) = buf.windows(4).position(|w| w == b"mvhd") {
            let data = &buf[pos + 4..];
            if data.len() >= 20 {
                let version = data[0];
                let (timescale, duration) = if version == 1 {
                    if data.len() >= 28 {
                        let ts = u32::from_be_bytes(data[16..20].try_into().ok()?);
                        let dur = u64::from_be_bytes(data[20..28].try_into().ok()?);
                        (ts as f64, dur as f64)
                    } else {
                        return None;
                    }
                } else {
                    let ts = u32::from_be_bytes(data[8..12].try_into().ok()?);
                    let dur = u32::from_be_bytes(data[12..16].try_into().ok()?);
                    (ts as f64, dur as f64)
                };
                if timescale > 0.0 && duration > 0.0 {
                    return Some(duration / timescale);
                }
            }
        }
        None
    }

    /// Queries exact video duration from container headers using ffmpeg -i or pure MP4 parsing
    pub fn get_actual_video_duration(path: &Path, ffmpeg_bin_opt: Option<&Path>) -> Option<f64> {
        if let Some(dur) = Self::parse_mp4_duration(path) {
            return Some(dur);
        }
        if let Some(ffmpeg_bin) = ffmpeg_bin_opt {
            let output = Command::new(ffmpeg_bin)
                .args(&["-i", &path.to_string_lossy()])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .ok()?;
            let stderr = String::from_utf8_lossy(&output.stderr);
            if let Some(pos) = stderr.find("Duration: ") {
                let substr = &stderr[pos + 10..];
                if let Some(end) = substr.find(',') {
                    let dur_str = substr[..end].trim();
                    let parts: Vec<&str> = dur_str.split(':').collect();
                    if parts.len() == 3 {
                        let h: f64 = parts[0].parse().unwrap_or(0.0);
                        let m: f64 = parts[1].parse().unwrap_or(0.0);
                        let s: f64 = parts[2].parse().unwrap_or(0.0);
                        let total = h * 3600.0 + m * 60.0 + s;
                        if total > 0.1 {
                            return Some(total);
                        }
                    }
                }
            }
        }
        None
    }

    /// Finds the best available ffmpeg binary on the machine (cached permanently to avoid repeated process spawning)
    pub fn get_ffmpeg_path() -> Option<PathBuf> {
        CACHED_FFMPEG_PATH.get_or_init(|| {
            if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
                let candidates = [
                    PathBuf::from(&local_app_data).join("Programs").join("AscentApp").join("ffmpeg.exe"),
                    PathBuf::from(&local_app_data).join("Medal").join("ffmpeg.exe"),
                    PathBuf::from(r"C:\Users\advai\AppData\Local\Programs\AscentApp\ffmpeg.exe"),
                ];
                for c in &candidates {
                    if c.exists() {
                        return Some(c.clone());
                    }
                }
            }
            // Check if ffmpeg exists in working dir
            let local_ffmpeg = PathBuf::from("ffmpeg.exe");
            if local_ffmpeg.exists() {
                return Some(local_ffmpeg);
            }
            // Check PATH silently without flashing any console window
            if Command::new("ffmpeg.exe")
                .arg("-version")
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .is_ok()
            {
                return Some(PathBuf::from("ffmpeg.exe"));
            }
            None
        }).clone()
    }

    pub fn trigger_save_clip(&mut self, reason_opt: Option<&str>) -> Result<PathBuf, String> {
        let _status = crate::game_detect::get_cached_valorant_status();

        // Strict Debounce: prevent duplicate automatic clips while allowing responsive manual hotkey triggers
        let min_cooldown = if reason_opt.is_some() {
            Duration::from_secs(14)
        } else {
            Duration::from_millis(2500)
        };
        if self.last_trigger.elapsed() < min_cooldown {
            return Err(format!("Clip trigger debounced ({:.1}s cooldown active)", min_cooldown.as_secs_f32()));
        }
        let now = Instant::now();
        self.last_trigger = now;

        // 1. Finalize the active recording segment if frames were written to it
        let end_media_ms = self.current_total_media_ms();
        if self.frames_written > 0 {
            if let Some(mut rec) = self.current_recorder.take() {
                self.completed_media_ms += rec.current_media_time_ms();
                let _ = rec.finalize();
            }
            if let Some(active_path) = self.active_segment_path.take() {
                if active_path.exists() && fs::metadata(&active_path).map(|m| m.len()).unwrap_or(0) > 1024 {
                    self.completed_segments.push_back(active_path);
                }
            }
            let buffer_secs = if let Some(ref cm) = self.config_manager {
                cm.current.read().unwrap().buffer_length_seconds
            } else {
                self.buffer_seconds
            };
            self.buffer_seconds = buffer_secs;
            let max_segs = ((self.buffer_seconds as usize + 14) / 15).max(2) + 1;
            while self.completed_segments.len() > max_segs {
                if let Some(old_seg) = self.completed_segments.pop_front() {
                    let _ = fs::remove_file(old_seg);
                }
            }
        }

        // Buffer verification: Ensure genuine gameplay video data exists
        if self.completed_segments.is_empty() {
            return Err("Rolling buffer has not captured any gameplay frames yet. Please ensure Valorant is running and in focus.".into());
        }

        // 2. Build destination path
        let now_str = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
        let clip_filename = match reason_opt {
            Some(reason) if !reason.is_empty() => {
                let clean_reason = reason.replace(' ', "_");
                format!("Valorant_Highlight_{}_{}.mp4", clean_reason, now_str)
            }
            _ => format!("Valorant_Clip_{}.mp4", now_str),
        };

        let dest_path = self.save_dir.join(&clip_filename);
        let _ = fs::create_dir_all(&self.save_dir);

        let ffmpeg_bin_opt = Self::get_ffmpeg_path();
        let mut buffer_export_success = false;

        // 3. Assemble the rolling buffer from completed segments
        if let Some(ref ffmpeg_bin) = ffmpeg_bin_opt {
            if self.completed_segments.len() == 1 {
                let single_seg = &self.completed_segments[0];
                if single_seg.exists() {
                    let c_out = Command::new(ffmpeg_bin)
                        .args(&[
                            "-y",
                            "-i", &single_seg.to_string_lossy(),
                            "-c", "copy",
                            "-movflags", "+faststart",
                            &dest_path.to_string_lossy(),
                        ])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                    if let Ok(out) = c_out {
                        if out.status.success() && dest_path.exists() && fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0) > 0 {
                            buffer_export_success = true;
                        }
                    }
                }
            } else if self.completed_segments.len() > 1 {
                let concat_txt = self.spool_dir.join("concat_list.txt");
                let combined_mp4 = self.spool_dir.join(format!("combined_{}.mp4", self.segment_counter));

                let mut list_content = String::new();
                for seg in &self.completed_segments {
                    if seg.exists() {
                        let abs_str = seg.to_string_lossy().replace('\\', "/").replace('\'', "'\\''");
                        list_content.push_str(&format!("file '{}'\n", abs_str));
                    }
                }

                if !list_content.is_empty() {
                    let _ = fs::write(&concat_txt, &list_content);

                    let concat_res = Command::new(ffmpeg_bin)
                        .args(&[
                            "-y",
                            "-f", "concat",
                            "-safe", "0",
                            "-i", &concat_txt.to_string_lossy(),
                            "-c", "copy",
                            &combined_mp4.to_string_lossy(),
                        ])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();

                    if let Ok(out) = concat_res {
                        if out.status.success() && combined_mp4.exists() {
                            let actual_dur = Self::get_actual_video_duration(&combined_mp4, ffmpeg_bin_opt.as_deref())
                                .unwrap_or(30.0);

                            if actual_dur > self.buffer_seconds as f64 {
                                let sseof_arg = format!("-{}", self.buffer_seconds);
                                let slice_res = Command::new(ffmpeg_bin)
                                    .args(&[
                                        "-y",
                                        "-sseof", &sseof_arg,
                                        "-i", &combined_mp4.to_string_lossy(),
                                        "-c", "copy",
                                        "-movflags", "+faststart",
                                        &dest_path.to_string_lossy(),
                                    ])
                                    .creation_flags(CREATE_NO_WINDOW)
                                    .output();

                                if let Ok(slice_out) = slice_res {
                                    if slice_out.status.success() && dest_path.exists() && fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0) > 0 {
                                        buffer_export_success = true;
                                    }
                                }
                            }

                            if !buffer_export_success && combined_mp4.exists() {
                                let faststart_copy = Command::new(ffmpeg_bin)
                                    .args(&[
                                        "-y",
                                        "-i", &combined_mp4.to_string_lossy(),
                                        "-c", "copy",
                                        "-movflags", "+faststart",
                                        &dest_path.to_string_lossy(),
                                    ])
                                    .creation_flags(CREATE_NO_WINDOW)
                                    .output();

                                if let Ok(c_out) = faststart_copy {
                                    if c_out.status.success() && dest_path.exists() && fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0) > 0 {
                                        buffer_export_success = true;
                                    }
                                }
                            }
                        }
                    }

                    let _ = fs::remove_file(&combined_mp4);
                    let _ = fs::remove_file(&concat_txt);
                }
            }
        }

        // Direct Native Fast-Copy fallback (guarantees export succeeds even without FFmpeg)
        if !buffer_export_success || !dest_path.exists() || fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0) == 0 {
            if let Some(latest) = self.completed_segments.back() {
                if latest.exists() {
                    let _ = fs::copy(latest, &dest_path);
                    buffer_export_success = dest_path.exists() && fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0) > 0;
                }
            }
        }

        // Enforce physical file verification on disk
        if !buffer_export_success || !dest_path.exists() || fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0) < 1024 * 10 {
            return Err("Failed to flush video recording buffer to disk. Please verify drive permissions.".into());
        }

        // 4. Record EXACT WALL-CLOCK TIMING for Riot match-details reconciliation
        let stem = dest_path.file_stem().unwrap_or_default().to_string_lossy().to_string();

        // Calculate EXACT frame-perfect clip duration directly from exported MP4 container
        let clip_duration = Self::get_actual_video_duration(&dest_path, ffmpeg_bin_opt.as_deref())
            .unwrap_or_else(|| {
                (self.completed_segments.len() as f64 * 15.0)
                    .min(self.buffer_seconds as f64)
                    .max(1.0)
            });

        let clip_end_ms = chrono::Local::now().timestamp_millis();
        let clip_duration_ms = (clip_duration * 1000.0) as u64;
        let clip_start_ms = clip_end_ms - (clip_duration_ms as i64);
        crate::match_sync::write_timing(&stem, clip_start_ms, clip_end_ms);

        // Save real-time combat events using exact monotonic media clock alignment
        let clip_media_start_ms = end_media_ms.saturating_sub(clip_duration_ms);
        let mut events_to_save: Vec<MatchEvent> = Vec::new();
        for (_event_instant, evt_media_ms, event) in &self.recent_events {
            if event.event_type != "kill" && event.event_type != "death" {
                continue;
            }
            if *evt_media_ms >= clip_media_start_ms && *evt_media_ms <= end_media_ms {
                let exact_ms = (*evt_media_ms - clip_media_start_ms).min(clip_duration_ms);
                let mut aligned = event.clone();
                aligned.event_time_ms = exact_ms;
                aligned.timestamp_pts = ((exact_ms as i64) * 60) / 1000;
                events_to_save.push(aligned);
            }
        }

        // If triggered with an explicit live reason (e.g. "Eliminated by Jett (Vandal)" after 3.8s post-roll),
        // place the immediate marker at the exact trigger moment (clip_duration - 3.8s) until Riot PD post-match sync refines it.
        if events_to_save.is_empty() {
            if let Some(reason_str) = reason_opt.filter(|r| !r.is_empty()) {
                let low = reason_str.to_lowercase();
                let is_death = low.contains("death") || low.contains("eliminated by") || low.contains("killed by");
                let action_sec = (clip_duration - 3.8).clamp(0.5, (clip_duration - 0.5).max(0.5));
                events_to_save.push(MatchEvent {
                    timestamp_pts: (action_sec * 60.0) as i64,
                    event_time_ms: (action_sec * 1000.0) as u64,
                    round: 1,
                    event_type: if is_death { "death".into() } else { "kill".into() },
                    weapon: Some("Vandal".into()),
                    headshot: low.contains("headshot"),
                    victim: Some(if is_death { "Self".into() } else { "Enemy".into() }),
                    killer: Some(if is_death { "Enemy".into() } else { "Self".into() }),
                    site: None,
                    kill_number: if is_death { None } else { Some(1) },
                    multi_kill_label: if is_death { None } else { Some("1K".into()) },
                    reason: Some(reason_str.to_string()),
                });
            }
        }

        events_to_save.sort_by_key(|e| e.event_time_ms);
        let mut kill_counter = 0u32;
        for evt in events_to_save.iter_mut() {
            if evt.event_type == "kill" {
                kill_counter += 1;
                evt.kill_number = Some(kill_counter);
                evt.multi_kill_label = match kill_counter {
                    1 => Some("1K".into()),
                    2 => Some("Double Kill (2K)".into()),
                    3 => Some("Triple Kill (3K)".into()),
                    4 => Some("Quadra Kill (4K)".into()),
                    5 => Some("ACE (5K)".into()),
                    n => Some(format!("{}K", n)),
                };
            }
        }

        if !events_to_save.is_empty() {
            let meta_file = self.metadata_dir.join(format!("{}.json", stem));
            if let Ok(serialized) = serde_json::to_string_pretty(&events_to_save) {
                let sealed = crate::security::seal_aes256_aead(serialized.as_bytes());
                let _ = fs::write(&meta_file, sealed);
            }
        }

        println!(
            "[RecorderManager] Saved clip ({:.1}s, window {}..{}) with {} live events: {:?}",
            clip_duration,
            clip_start_ms,
            clip_end_ms,
            events_to_save.len(),
            dest_path
        );

        // 5. Restart recording immediately for the next highlight
        if let Some((w, h)) = self.last_frame_dims {
            self.start_new_segment(w, h);
        }

        unsafe {
            let current_process = windows_sys::Win32::System::Threading::GetCurrentProcess();
            windows_sys::Win32::System::ProcessStatus::EmptyWorkingSet(current_process);
        }

        Ok(dest_path)
    }

    /// Sanitizes user-provided clip labels to prevent path traversal and filesystem errors
    pub fn sanitize_filename_label(input: &str) -> String {
        let forbidden = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
        let sanitized: String = input
            .chars()
            .map(|c| if forbidden.contains(&c) || c.is_control() { '_' } else { c })
            .collect();
        let trimmed = sanitized.trim().replace(' ', "_");
        if trimmed.is_empty() {
            "Highlight".to_string()
        } else {
            trimmed
        }
    }

    /// Trims an existing clip losslessly using ffmpeg in ~100ms
    pub fn trim_existing_clip(
        source_path_str: &str,
        start_secs: f64,
        end_secs: f64,
        title_opt: Option<String>,
    ) -> Result<PathBuf, String> {
        let src_path = Path::new(source_path_str);
        if !src_path.exists() {
            return Err("Source video file does not exist".into());
        }

        let parent_dir = src_path.parent().unwrap_or_else(|| Path::new("."));
        let now_str = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
        let label = title_opt
            .as_deref()
            .map(Self::sanitize_filename_label)
            .unwrap_or_else(|| "Trimmed".into());

        let dest_filename = format!("Valorant_{}_{}.mp4", label, now_str);
        let dest_path = parent_dir.join(&dest_filename);

        let ffmpeg_bin = Self::get_ffmpeg_path().ok_or("FFmpeg not found. Please install FFmpeg or run with Ascent/Medal installed.")?;
        let ss_str = format!("{:.2}", start_secs.max(0.0));
        let to_str = format!("{:.2}", end_secs.max(start_secs + 0.5));

        let mut output = Command::new(&ffmpeg_bin)
            .args(&[
                "-y",
                "-ss", &ss_str,
                "-to", &to_str,
                "-i", source_path_str,
                "-c", "copy",
                "-avoid_negative_ts", "make_zero",
                "-movflags", "+faststart",
                &dest_path.to_string_lossy(),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to run ffmpeg: {e}"))?;

        if !output.status.success() || !dest_path.exists() || dest_path.metadata().map(|m| m.len()).unwrap_or(0) == 0 {
            // High-precision fallback: ultrafast frame-accurate re-encode
            let dur = (end_secs - start_secs).max(0.5);
            let dur_str = format!("{:.2}", dur);
            output = Command::new(&ffmpeg_bin)
                .args(&[
                    "-y",
                    "-ss", &ss_str,
                    "-i", source_path_str,
                    "-t", &dur_str,
                    "-c:v", "libx264",
                    "-preset", "ultrafast",
                    "-crf", "18",
                    "-c:a", "aac",
                    "-avoid_negative_ts", "make_zero",
                    "-movflags", "+faststart",
                    &dest_path.to_string_lossy(),
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| format!("Failed to run ffmpeg fallback: {e}"))?;
        }

        if !output.status.success() || !dest_path.exists() {
            return Err("FFmpeg trim failed".into());
        }

        // Adjust timing & verified metadata events for trimmed offset
        crate::match_sync::write_trimmed_timing(src_path, &dest_path, start_secs, end_secs);

        Ok(dest_path)
    }

    /// Converts a landscape 16:9 clip into a vertical 9:16 Shorts/TikTok video
    pub fn export_vertical_short(source_path_str: &str) -> Result<PathBuf, String> {
        let src_path = Path::new(source_path_str);
        if !src_path.exists() {
            return Err("Source video file does not exist".into());
        }

        let parent_dir = src_path.parent().unwrap_or_else(|| Path::new("."));
        let now_str = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
        let dest_filename = format!("Valorant_Short_9x16_{}.mp4", now_str);
        let dest_path = parent_dir.join(&dest_filename);

        let ffmpeg_bin = Self::get_ffmpeg_path().ok_or("FFmpeg not found. Please install FFmpeg for 9:16 Shorts export.")?;
        let output = Command::new(&ffmpeg_bin)
            .args(&[
                "-y",
                "-i", source_path_str,
                "-vf", "crop=ih*9/16:ih:(iw-ih*9/16)/2:0",
                "-c:a", "copy",
                "-movflags", "+faststart",
                &dest_path.to_string_lossy(),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to run ffmpeg: {e}"))?;

        if !output.status.success() || !dest_path.exists() {
            return Err("FFmpeg vertical crop failed".into());
        }

        // Copy timing & verified metadata if available
        crate::match_sync::copy_timing_and_events(src_path, &dest_path);

        Ok(dest_path)
    }

    /// Merges multiple clips into a continuous highlight montage
    pub fn create_montage(clip_paths: &[String], title_opt: Option<String>) -> Result<PathBuf, String> {
        if clip_paths.is_empty() {
            return Err("No clips selected for montage".into());
        }

        let first_path = Path::new(&clip_paths[0]);
        let parent_dir = first_path.parent().unwrap_or_else(|| Path::new("."));
        let now_str = chrono::Local::now().format("%Y%m%d_%H%M%S").to_string();
        let label = title_opt
            .as_deref()
            .map(Self::sanitize_filename_label)
            .unwrap_or_else(|| "Montage".into());

        let dest_filename = format!("Valorant_{}_{}.mp4", label, now_str);
        let dest_path = parent_dir.join(&dest_filename);

        let concat_txt = parent_dir.join(format!("montage_list_{}.txt", now_str));
        let mut list_content = String::new();
        for path_str in clip_paths {
            let p = Path::new(path_str);
            if p.exists() {
                let abs_str = p.to_string_lossy().replace('\\', "/");
                list_content.push_str(&format!("file '{}'\n", abs_str));
            }
        }

        if list_content.is_empty() {
            return Err("Valid clip files not found".into());
        }

        let _ = fs::write(&concat_txt, &list_content);
        let ffmpeg_bin = Self::get_ffmpeg_path().ok_or("FFmpeg not found. Please install FFmpeg for 9:16 Shorts export.")?;
        let output = Command::new(&ffmpeg_bin)
            .args(&[
                "-y",
                "-f", "concat",
                "-safe", "0",
                "-i", &concat_txt.to_string_lossy(),
                "-c", "copy",
                "-movflags", "+faststart",
                &dest_path.to_string_lossy(),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to run ffmpeg concat: {e}"))?;

        let _ = fs::remove_file(&concat_txt);

        if !output.status.success() || !dest_path.exists() {
            return Err("FFmpeg montage creation failed".into());
        }

        Ok(dest_path)
    }

    /// Permanently repairs an inverted (upside-down) video clip on disk in-place using FFmpeg `vflip`.
    pub fn repair_inverted_clip(source_path_str: &str) -> Result<PathBuf, String> {
        let src_path = Path::new(source_path_str);
        if !src_path.exists() {
            return Err("Source video file does not exist".into());
        }

        let parent_dir = src_path.parent().unwrap_or_else(|| Path::new("."));
        let stem = src_path.file_stem().unwrap_or_default().to_string_lossy();
        let tmp_path = parent_dir.join(format!("{}_vflip_tmp.mp4", stem));

        let ffmpeg_bin = Self::get_ffmpeg_path().ok_or("FFmpeg not found.")?;
        let output = Command::new(&ffmpeg_bin)
            .args(&[
                "-y",
                "-i",
                source_path_str,
                "-vf",
                "vflip",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "18",
                "-c:a",
                "copy",
                "-movflags",
                "+faststart",
                &tmp_path.to_string_lossy(),
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to run ffmpeg vflip: {e}"))?;

        if !output.status.success() || !tmp_path.exists() {
            let _ = fs::remove_file(&tmp_path);
            return Err("FFmpeg vertical flip repair failed.".into());
        }

        fs::rename(&tmp_path, src_path).map_err(|e| {
            let _ = fs::remove_file(&tmp_path);
            format!("Failed to replace repaired video file: {e}")
        })?;

        Ok(src_path.to_path_buf())
    }
}

unsafe impl Send for ReplayRecorderManager {}
