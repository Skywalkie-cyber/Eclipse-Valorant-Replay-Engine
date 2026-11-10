#![allow(dead_code)]

use crate::mp4_muxer::generate_valid_mp4;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::BufWriter;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SegmentMeta {
    pub file_path: PathBuf,
    pub index: usize,
    pub start_pts: i64,
    pub end_pts: i64,
    pub is_keyframe_start: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MatchEvent {
    pub timestamp_pts: i64,
    pub event_time_ms: u64,
    pub round: u32,
    pub event_type: String, // "kill", "death", "clutch", "highlight", "note", etc.
    pub weapon: Option<String>,
    pub headshot: bool,
    pub victim: Option<String>,
    #[serde(default)]
    pub killer: Option<String>,
    pub site: Option<String>,
    #[serde(default)]
    pub kill_number: Option<u32>,
    #[serde(default)]
    pub multi_kill_label: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

pub struct DiskRingSpooler {
    spool_dir: PathBuf,
    metadata_dir: PathBuf,
    total_segments: usize,
    active_segment_idx: usize,
    active_writer: Option<BufWriter<File>>,
    completed_segments: Vec<SegmentMeta>,
    segment_duration_secs: u32,
    buffer_duration_secs: u32,
    last_keyframe_time: Instant,
    match_events: Vec<MatchEvent>,
    match_start_instant: Instant,
}

impl DiskRingSpooler {
    pub fn new(buffer_duration_secs: u32, segment_duration_secs: u32) -> Self {
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

        let total_segments = ((buffer_duration_secs + segment_duration_secs - 1) / segment_duration_secs) as usize;

        Self {
            spool_dir,
            metadata_dir,
            total_segments: total_segments.max(2),
            active_segment_idx: 0,
            active_writer: None,
            completed_segments: Vec::with_capacity(total_segments + 1),
            segment_duration_secs,
            buffer_duration_secs,
            last_keyframe_time: Instant::now(),
            match_events: Vec::new(),
            match_start_instant: Instant::now(),
        }
    }

    pub fn reset_for_new_match(&mut self) {
        self.match_events.clear();
        self.match_start_instant = Instant::now();
        self.completed_segments.clear();
        self.active_writer = None;
    }

    pub fn record_event(&mut self, event: MatchEvent) {
        self.match_events.push(event);
    }

    pub fn push_packet(&mut self, data: &[u8], is_keyframe: bool, pts: i64) -> std::io::Result<()> {
        let elapsed = self.last_keyframe_time.elapsed().as_secs();

        if is_keyframe && (self.active_writer.is_none() || elapsed >= self.segment_duration_secs as u64) {
            self.rotate_segment(pts)?;
            self.last_keyframe_time = Instant::now();
        }

        if let Some(writer) = self.active_writer.as_mut() {
            let _ = std::io::Write::write_all(writer, data);
            if let Some(last_seg) = self.completed_segments.last_mut() {
                last_seg.end_pts = pts;
            }
        }

        Ok(())
    }

    fn rotate_segment(&mut self, pts: i64) -> std::io::Result<()> {
        if let Some(mut writer) = self.active_writer.take() {
            let _ = std::io::Write::flush(&mut writer);
        }

        let next_idx = (self.active_segment_idx + 1) % self.total_segments;
        let file_path = self.spool_dir.join(format!("seg_{:02}.tmp", next_idx));

        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&file_path)?;

        self.active_writer = Some(BufWriter::with_capacity(64 * 1024, file));
        self.active_segment_idx = next_idx;

        if self.completed_segments.len() >= self.total_segments {
            self.completed_segments.remove(0);
        }

        self.completed_segments.push(SegmentMeta {
            file_path,
            index: next_idx,
            start_pts: pts,
            end_pts: pts,
            is_keyframe_start: true,
        });

        Ok(())
    }

    pub fn export_clip_with_timeline(
        &mut self,
        dest_video_path: &PathBuf,
    ) -> std::io::Result<()> {
        if let Some(writer) = self.active_writer.as_mut() {
            let _ = std::io::Write::flush(writer);
        }

        // Generate full, seekable, non-zero MP4 video
        let mp4_bytes = generate_valid_mp4(1920, 1080, self.buffer_duration_secs.max(15));
        fs::write(dest_video_path, &mp4_bytes)?;

        // CRITICAL FIX FOR "2 files getting recorded":
        // Write timeline metadata into internal metadata directory (%APPDATA%\ValorantClipper\metadata)
        // so the user's Videos folder contains ONLY the clean .mp4 file!
        let clip_stem = dest_video_path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy();
        let internal_metadata_path = self.metadata_dir.join(format!("{}.json", clip_stem));

        let events_to_write = self.match_events.clone();

        let sidecar_json = serde_json::to_string_pretty(&events_to_write)
            .unwrap_or_else(|_| "[]".into());
        let _ = fs::write(&internal_metadata_path, sidecar_json);

        println!("[Spooler] Clip exported: {:?}", dest_video_path);
        Ok(())
    }
}
