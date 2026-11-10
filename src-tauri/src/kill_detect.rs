//! Frame-accurate kill detection performed on the saved clip itself.
//!
//! Valorant draws the kill medallion with a teal "SINGLE KILL / DOUBLE KILL ..." progress bar centered
//! near the bottom of the screen. The bar spawns full the instant a kill happens and then drains
//! linearly (about 2.2 seconds). Scanning that bar frame by frame gives the exact kill moment in
//! media time, independent of any wall clock or Riot API clock skew.

use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::disk_spooler::MatchEvent;
use crate::recorder_manager::ReplayRecorderManager;

const BAR_W: usize = 670;
const BAR_H: usize = 6;
const SCAN_FPS: f64 = 60.0;
const DEFAULT_DRAIN_PER_SEC: f64 = 0.46;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Deserialize)]
struct HudCache {
    clip_len: u64,
    kill_secs: Vec<f64>,
}

fn cache_path(meta_dir: &Path, stem: &str) -> std::path::PathBuf {
    meta_dir.join(format!("{stem}.hud.json"))
}

/// Pure analysis of the per-frame teal bar fill fraction (0.0 - 1.0) sampled at `SCAN_FPS`.
pub fn kill_moments_from_fractions(frac: &[f64]) -> Vec<f64> {
    let look = (0.25 * SCAN_FPS) as usize; // 0.25s after onset the bar must have drained
    let mut out: Vec<f64> = Vec::new();
    let mut i = 1;
    while i + look < frac.len() {
        let jump = frac[i] - frac[i - 1];
        if frac[i] >= 0.80 && jump >= 0.25 {
            let later = frac[i + look];
            // Real kill bar drains steadily; transient teal flashes vanish immediately.
            if later > 0.05 && later < frac[i] - 0.05 {
                let slope = ((frac[i] - later) / 0.25).clamp(0.30, 0.70);
                let slope = if slope.is_finite() { slope } else { DEFAULT_DRAIN_PER_SEC };
                let t_first = i as f64 / SCAN_FPS;
                let t_kill = (t_first - (1.0 - frac[i]).max(0.0) / slope).max(0.0);
                if out.last().map(|p| t_kill - *p > 0.40).unwrap_or(true) {
                    out.push(t_kill);
                }
                i += look;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn scan_clip(clip_path: &Path) -> Option<Vec<f64>> {
    let ffmpeg = ReplayRecorderManager::get_ffmpeg_path()?;
    let vf = format!(
        "fps={SCAN_FPS},crop=iw*0.2617:ih*0.0042:iw*0.3691:ih*0.9597,scale={BAR_W}:{BAR_H}:flags=area"
    );
    let output = Command::new(ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(clip_path)
        .args(["-an", "-vf", &vf, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let frame_bytes = BAR_W * BAR_H * 3;
    if output.stdout.len() < frame_bytes {
        return None;
    }
    let n = output.stdout.len() / frame_bytes;
    let mut fractions = Vec::with_capacity(n);
    for f in 0..n {
        let frame = &output.stdout[f * frame_bytes..(f + 1) * frame_bytes];
        let mut teal_cols = 0usize;
        for x in 0..BAR_W {
            let mut teal_rows = 0usize;
            for y in 0..BAR_H {
                let p = (y * BAR_W + x) * 3;
                let (r, g, b) = (frame[p] as i32, frame[p + 1] as i32, frame[p + 2] as i32);
                if g > 150 && g - r > 40 && b > 100 && b < g + 10 {
                    teal_rows += 1;
                }
            }
            if teal_rows * 2 > BAR_H {
                teal_cols += 1;
            }
        }
        fractions.push(teal_cols as f64 / BAR_W as f64);
    }
    Some(kill_moments_from_fractions(&fractions))
}

/// Returns exact kill moments (seconds) for a clip, cached next to the other clip metadata.
pub fn detect_kill_moments(clip_path: &Path, meta_dir: &Path, stem: &str) -> Option<Vec<f64>> {
    let clip_len = std::fs::metadata(clip_path).ok()?.len();
    let cpath = cache_path(meta_dir, stem);
    if let Ok(raw) = std::fs::read_to_string(&cpath) {
        if let Ok(cache) = serde_json::from_str::<HudCache>(&raw) {
            if cache.clip_len == clip_len {
                return Some(cache.kill_secs);
            }
        }
    }
    let kill_secs = scan_clip(clip_path)?;
    if let Ok(ser) = serde_json::to_string(&HudCache { clip_len, kill_secs: kill_secs.clone() }) {
        let _ = std::fs::write(cpath, ser);
    }
    Some(kill_secs)
}

/// Snaps kill markers to the exact detected kill frames. Returns true if anything changed.
pub fn reconcile_kill_events(events: &mut Vec<MatchEvent>, kill_secs: &[f64]) -> bool {
    if kill_secs.is_empty() {
        return false;
    }
    let mut changed = false;
    let mut assigned: Vec<usize> = Vec::new();
    for &d in kill_secs {
        let d_ms = (d * 1000.0).round() as u64;
        let nearest = events
            .iter()
            .enumerate()
            .filter(|(idx, e)| e.event_type == "kill" && !assigned.contains(idx))
            .min_by_key(|(_, e)| e.event_time_ms.abs_diff(d_ms))
            .map(|(idx, _)| idx);
        match nearest {
            Some(idx) => {
                assigned.push(idx);
                if events[idx].event_time_ms.abs_diff(d_ms) > 40 {
                    events[idx].event_time_ms = d_ms;
                    events[idx].timestamp_pts = (d_ms as i64 * 60) / 1000;
                    changed = true;
                }
            }
            None => {
                let default_victim = "Enemy";
                events.push(MatchEvent {
                    timestamp_pts: (d_ms as i64 * 60) / 1000,
                    event_time_ms: d_ms,
                    round: events.first().map(|e| e.round).unwrap_or(1),
                    event_type: "kill".into(),
                    weapon: Some("Vandal".into()),
                    headshot: false,
                    victim: Some(default_victim.into()),
                    killer: Some("Self".into()),
                    site: None,
                    kill_number: None,
                    multi_kill_label: None,
                    reason: Some(format!("Eliminated {default_victim} (Vandal)")),
                });
                assigned.push(events.len() - 1);
                changed = true;
            }
        }
    }
    if changed {
        events.sort_by_key(|e| e.event_time_ms);
        let mut n = 0u32;
        for e in events.iter_mut().filter(|e| e.event_type == "kill") {
            n += 1;
            e.kill_number = Some(n);
            e.multi_kill_label = Some(match n {
                1 => "1K".to_string(),
                2 => "2K".to_string(),
                3 => "3K".to_string(),
                4 => "4K".to_string(),
                _ => "ACE".to_string(),
            });
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn scan_real_clip_from_env() {
        let p = std::env::var("KILL_TEST_CLIP").expect("set KILL_TEST_CLIP");
        let d = scan_clip(Path::new(&p)).expect("scan failed");
        println!("DETECTED {:?}", d);
        assert!(!d.is_empty());
    }

    #[test]
    fn detects_onset_and_ignores_flash() {
        let mut f = vec![0.0; 600];
        // Real kill: appears at 0.94 at frame 243 (4.05s) and drains 0.46/s
        for k in 0..130 {
            f[243 + k] = (0.94 - 0.46 * (k as f64 / 60.0)).max(0.0);
        }
        // Transient flash at 7.2s
        f[432] = 0.27;
        f[433] = 0.8;
        f[434] = 0.3;
        let d = kill_moments_from_fractions(&f);
        assert_eq!(d.len(), 1);
        assert!((d[0] - 3.92).abs() < 0.08, "got {:?}", d);
    }
}
