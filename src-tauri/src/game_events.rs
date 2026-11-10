use std::env;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::os::windows::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedSender;

use crate::disk_spooler::MatchEvent;

const FILE_SHARE_ALL: u32 = 0x00000001 | 0x00000002 | 0x00000004;

pub enum GameSignal {
    Event(MatchEvent),
    TriggerClip { reason: String },
    MatchStarted,
    MatchEnded,
}

pub struct ShooterGameLogTailer {
    is_running: Arc<AtomicBool>,
}

impl ShooterGameLogTailer {
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start_tailing(&self, signal_tx: UnboundedSender<GameSignal>) {
        if self.is_running.swap(true, Ordering::SeqCst) {
            return;
        }

        let is_running = self.is_running.clone();

        thread::spawn(move || {
            let mut log_file_opt = None;

            // Wait for ShooterGame.log to appear once Valorant launches
            while is_running.load(Ordering::Relaxed) && log_file_opt.is_none() {
                if let Some(path) = Self::find_log_file() {
                    log_file_opt = Some(path);
                    break;
                }
                thread::sleep(Duration::from_secs(2));
            }

            let log_path = match log_file_opt {
                Some(p) => p,
                None => return,
            };

            let file = match OpenOptions::new()
                .read(true)
                .share_mode(FILE_SHARE_ALL)
                .open(&log_path)
            {
                Ok(f) => f,
                Err(e) => {
                    eprintln!("[LogTailer] Failed to open log file: {e}");
                    return;
                }
            };

            let mut reader = BufReader::new(file);
            let _ = reader.seek(SeekFrom::End(0));

            println!("[LogTailer] Vanguard-safe ShooterGame.log combat tailer active: {:?}", log_path);

            let mut line = String::new();
            let mut current_round = 1;
            let mut round_kills = 0u32;
            let mut last_kill_instant = Instant::now();
            let mut last_trigger_sent = Instant::now() - Duration::from_secs(30);
            let start_time = Instant::now();

            while is_running.load(Ordering::Relaxed) {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        thread::sleep(Duration::from_millis(50));
                    }
                    Ok(_) => {
                        let elapsed_ms = start_time.elapsed().as_millis() as u64;

                        let weapons = [
                            "Vandal", "Phantom", "Operator", "Sheriff", "Ghost", "Classic",
                            "Spectre", "Odin", "Ares", "Marshal", "Guardian", "Bulldog",
                            "Stinger", "Frenzy", "Shorty", "Judge", "Bucky", "Outlaw",
                            "Knife", "Melee", "Headhunter", "Tour De Force", "Blade Storm",
                        ];
                        let agents = [
                            "Jett", "Reyna", "Raze", "Phoenix", "Yoru", "Neon", "Iso",
                            "Omen", "Viper", "Brimstone", "Astra", "Harbor", "Clove",
                            "Sova", "Fade", "Skye", "Breach", "Gekko", "Tejo",
                            "Killjoy", "Cypher", "Sage", "Chamber", "Deadlock", "Vyse",
                        ];

                        let line_lower = line.to_lowercase();

                        // Helper to extract value after key= e.g. "Killer=Omen" -> "Omen"
                        let extract_val = |key: &str| -> Option<String> {
                            if let Some(pos) = line_lower.find(key) {
                                let rem = &line[pos + key.len()..];
                                let end = rem.find(|c: char| c == ' ' || c == ',' || c == ';' || c == '\t' || c == '\r' || c == '\n')
                                    .unwrap_or(rem.len());
                                let val = rem[..end].trim_matches(|c: char| c == '[' || c == ']' || c == '"' || c == '\'');
                                if !val.is_empty() {
                                    return Some(val.to_string());
                                }
                            }
                            None
                        };

                        let killer_raw = extract_val("killer=").or_else(|| extract_val("killer:"));
                        let victim_raw = extract_val("victim=").or_else(|| extract_val("victim:"));
                        let weapon_raw = extract_val("weapon=").or_else(|| extract_val("weapon:"));

                        // Resolve killer agent and victim agent
                        let killer_agent = killer_raw.as_deref().and_then(|k| {
                            agents.iter().find(|&&a| k.to_lowercase().contains(&a.to_lowercase())).copied()
                        }).or_else(|| {
                            agents.iter().find(|&&a| line.contains(a)).copied()
                        }).unwrap_or("Enemy");

                        let victim_agent = victim_raw.as_deref().and_then(|v| {
                            agents.iter().find(|&&a| v.to_lowercase().contains(&a.to_lowercase())).copied()
                        }).unwrap_or("Enemy");

                        let weapon_detected = weapon_raw.as_deref().and_then(|w| {
                            weapons.iter().find(|&&wp| w.to_lowercase().contains(&wp.to_lowercase())).copied()
                        }).or_else(|| {
                            weapons.iter().find(|&&w| line.contains(w)).copied()
                        }).unwrap_or("Vandal");

                        let is_headshot = line_lower.contains("headshot=true") 
                            || line_lower.contains("headshot") 
                            || line_lower.contains("headhit");

                        // 1. Precise Death Detection: Local player died vs 2. Kill Detection: Local player eliminated enemy
                        let is_self_victim = line_lower.contains("bisvictim=true")
                            || line_lower.contains("victim=self")
                            || line_lower.contains("victim=localplayer")
                            || line_lower.contains("victim:self")
                            || line_lower.contains("victim: localplayer");

                        let is_self_killer = line_lower.contains("biskiller=true")
                            || line_lower.contains("killer=self")
                            || line_lower.contains("killer=localplayer")
                            || line_lower.contains("killer:self")
                            || line_lower.contains("killer: localplayer");

                        let is_death_line = is_self_victim || (!is_self_killer && (
                            line_lower.contains("deathreport")
                            || line_lower.contains("playerdied")
                            || line_lower.contains("killed by")
                            || line_lower.contains("eliminated by")
                            || (line_lower.contains("combat") && line_lower.contains("died"))
                        ));

                        let is_kill_line = is_self_killer || (!is_death_line && (
                            line_lower.contains("killreport")
                            || line_lower.contains("playerkill")
                            || (line_lower.contains("combat") && line_lower.contains("elim"))
                        ));

                        if is_death_line {
                            // LOCAL PLAYER ELIMINATED: Record as death with the enemy killer agent & weapon for timeline marker!
                            let event = MatchEvent {
                                timestamp_pts: elapsed_ms as i64 * 60 / 1000,
                                event_time_ms: elapsed_ms,
                                round: current_round,
                                event_type: "death".into(),
                                weapon: Some(weapon_detected.to_string()),
                                headshot: is_headshot,
                                victim: Some("Self".into()),
                                killer: Some(killer_agent.to_string()),
                                site: None,
                                kill_number: None,
                                multi_kill_label: None,
                                reason: Some(format!("Eliminated by {killer_agent}")),
                            };
                            let _ = signal_tx.send(GameSignal::Event(event));
                            // Only trigger clip on death if local player was confirmed victim AND not debounced
                            if is_self_victim && last_trigger_sent.elapsed() > Duration::from_secs(16) {
                                last_trigger_sent = Instant::now();
                                let _ = signal_tx.send(GameSignal::TriggerClip {
                                    reason: format!("Eliminated by {killer_agent} ({weapon_detected})"),
                                });
                            }
                        }
                        else if is_kill_line {
                            // LOCAL PLAYER GOT AN ELIMINATION: Record as kill with the enemy victim agent & weapon!
                            if last_kill_instant.elapsed() > Duration::from_secs(12) {
                                round_kills = 1;
                            } else {
                                round_kills += 1;
                            }
                            last_kill_instant = Instant::now();

                            let multi_label = match round_kills {
                                1 => if is_headshot { "Headshot Kill (1K)" } else { "Kill (1K)" },
                                2 => "Double Kill (2K)",
                                3 => "Triple Kill (3K)",
                                4 => "Quadra Kill (4K)",
                                5 => "ACE (5K)",
                                _ => "Multi-Kill",
                            };

                            let event = MatchEvent {
                                timestamp_pts: elapsed_ms as i64 * 60 / 1000,
                                event_time_ms: elapsed_ms,
                                round: current_round,
                                event_type: "kill".into(),
                                weapon: Some(weapon_detected.to_string()),
                                headshot: is_headshot,
                                victim: Some(victim_agent.to_string()),
                                killer: Some("Self".into()),
                                site: None,
                                kill_number: Some(round_kills),
                                multi_kill_label: Some(multi_label.to_string()),
                                reason: Some(multi_label.to_string()),
                            };
                            let _ = signal_tx.send(GameSignal::Event(event));

                            // Debounce clip triggering: require at least 14s between auto-triggers, or multi-kill continuation
                            if last_trigger_sent.elapsed() > Duration::from_secs(14) || round_kills > 1 {
                                last_trigger_sent = Instant::now();
                                let _ = signal_tx.send(GameSignal::TriggerClip {
                                    reason: multi_label.to_string(),
                                });
                            }
                        }
                        // 3. Spike Planted
                        else if line.contains("BombPlanted") || line.contains("SpikePlanted") || line.contains("BombPlantedEvent") {
                            let event = MatchEvent {
                                timestamp_pts: elapsed_ms as i64 * 60 / 1000,
                                event_time_ms: elapsed_ms,
                                round: current_round,
                                event_type: "spike_plant".into(),
                                weapon: None,
                                headshot: false,
                                victim: None,
                                killer: None,
                                site: Some("A".into()),
                                kill_number: None,
                                multi_kill_label: None,
                                reason: Some("Spike Plant".into()),
                            };
                            let _ = signal_tx.send(GameSignal::Event(event));
                        }
                        // 4. Spike Defused
                        else if line.contains("BombDefused") || line.contains("SpikeDefused") || line.contains("BombDefusedEvent") {
                            let event = MatchEvent {
                                timestamp_pts: elapsed_ms as i64 * 60 / 1000,
                                event_time_ms: elapsed_ms,
                                round: current_round,
                                event_type: "spike_defuse".into(),
                                weapon: None,
                                headshot: false,
                                victim: None,
                                killer: None,
                                site: None,
                                kill_number: None,
                                multi_kill_label: None,
                                reason: Some("Spike Defuse".into()),
                            };
                            let _ = signal_tx.send(GameSignal::Event(event));
                        }
                        // 5. Round State & Match Transitions
                        else if line.contains("RoundState -> InProgress") || line.contains("RoundStart") {
                            current_round += 1;
                            round_kills = 0;
                            let event = MatchEvent {
                                timestamp_pts: elapsed_ms as i64 * 60 / 1000,
                                event_time_ms: elapsed_ms,
                                round: current_round,
                                event_type: "round_start".into(),
                                weapon: None,
                                headshot: false,
                                victim: None,
                                killer: None,
                                site: None,
                                kill_number: None,
                                multi_kill_label: None,
                                reason: None,
                            };
                            let _ = signal_tx.send(GameSignal::Event(event));
                        } else if line.contains("MatchState -> InProgress") {
                            let _ = signal_tx.send(GameSignal::MatchStarted);
                        } else if line.contains("MatchState -> PostMatch") {
                            let _ = signal_tx.send(GameSignal::MatchEnded);
                        }
                    }
                    Err(_) => {
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        });
    }

    fn find_log_file() -> Option<PathBuf> {
        let local_app_data = env::var("LOCALAPPDATA").ok()?;
        let candidates = [
            PathBuf::from(&local_app_data).join("VALORANT").join("Saved").join("Logs").join("ShooterGame.log"),
            PathBuf::from(&local_app_data).join("ShooterGame").join("Saved").join("Logs").join("ShooterGame.log"),
            PathBuf::from(&local_app_data).join("Riot Games").join("VALORANT").join("Saved").join("Logs").join("ShooterGame.log"),
        ];

        for path in &candidates {
            if path.exists() {
                return Some(path.clone());
            }
        }

        // If exact ShooterGame.log is absent, search the Saved\Logs folder for the latest log file
        let logs_dir = PathBuf::from(&local_app_data).join("VALORANT").join("Saved").join("Logs");
        if let Ok(entries) = std::fs::read_dir(&logs_dir) {
            let mut log_files: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().map(|ext| ext == "log").unwrap_or(false))
                .collect();
            log_files.sort_by_key(|p| p.metadata().and_then(|m| m.modified()).ok());
            if let Some(latest) = log_files.pop() {
                return Some(latest);
            }
        }

        None
    }

    #[allow(dead_code)]
    pub fn stop(&self) {
        self.is_running.store(false, Ordering::SeqCst);
    }
}
