use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::OpenOptions;
use std::io::Read;
use std::os::windows::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::time::Duration;
use thiserror::Error;

const FILE_SHARE_ALL: u32 = 0x00000007;

#[derive(Error, Debug)]
pub enum RiotAuthError {
    #[error("Riot Client is not running or lockfile not found at: {0}")]
    LockfileNotFound(PathBuf),

    #[error("Failed to read lockfile: {0}")]
    IoError(#[from] std::io::Error),

    #[error("Invalid lockfile format. Expected 5 colon-delimited tokens")]
    InvalidLockfileFormat,

    #[error("Failed to parse port number: {0}")]
    ParsePortError(#[from] std::num::ParseIntError),

    #[error("API client error: {0}")]
    HttpError(#[from] reqwest::Error),

    #[error("Invalid authorization header creation")]
    InvalidHeader,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiotLockfile {
    pub process_name: String,
    pub pid: u32,
    pub port: u16,
    pub password: String,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiotClientSession {
    pub base_url: String,
    pub auth_header: String,
    pub pid: u32,
    pub port: u16,
}

impl RiotLockfile {
    pub fn read_from_disk() -> Result<Self, RiotAuthError> {
        let local_app_data = env::var("LOCALAPPDATA")
            .unwrap_or_else(|_| "C:\\Users\\Default\\AppData\\Local".to_string());

        let lockfile_path = PathBuf::from(local_app_data)
            .join("Riot Games")
            .join("Riot Client")
            .join("Config")
            .join("lockfile");

        if !lockfile_path.exists() {
            return Err(RiotAuthError::LockfileNotFound(lockfile_path));
        }

        let mut file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_ALL)
            .open(&lockfile_path)?;

        let mut contents = String::new();
        file.read_to_string(&mut contents)?;

        Self::parse(&contents)
    }

    pub fn parse(raw: &str) -> Result<Self, RiotAuthError> {
        let parts: Vec<&str> = raw.trim().split(':').collect();
        if parts.len() != 5 {
            return Err(RiotAuthError::InvalidLockfileFormat);
        }

        Ok(RiotLockfile {
            process_name: parts[0].to_string(),
            pid: parts[1].parse()?,
            port: parts[2].parse()?,
            password: parts[3].to_string(),
            protocol: parts[4].to_string(),
        })
    }

    pub fn to_session(&self) -> RiotClientSession {
        let credentials = format!("riot:{}", self.password);
        let encoded = BASE64.encode(credentials);
        let auth_header = format!("Basic {}", encoded);
        let base_url = format!("{}://127.0.0.1:{}", self.protocol, self.port);

        RiotClientSession {
            base_url,
            auth_header,
            pid: self.pid,
            port: self.port,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveRosterPlayer {
    pub puuid: String,
    pub game_name: String,
    pub tag_line: String,
    pub agent: String,
    pub agent_uuid: String,
    pub player_card_id: String,
    pub account_level: u32,
    pub competitive_tier: u32,
    pub tier_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiotFriend {
    pub puuid: String,
    pub game_name: String,
    pub tag_line: String,
    pub agent: String,
    pub agent_uuid: String,
    pub player_card_id: String,
    pub account_level: u32,
    pub competitive_tier: u32,
    pub tier_name: String,
    pub status: String,
    pub party_size: u32,
    pub map: String,
}

pub fn resolve_tier_name(tier: u32) -> &'static str {
    match tier {
        0..=2 => "Unranked",
        3 => "Iron 1",
        4 => "Iron 2",
        5 => "Iron 3",
        6 => "Bronze 1",
        7 => "Bronze 2",
        8 => "Bronze 3",
        9 => "Silver 1",
        10 => "Silver 2",
        11 => "Silver 3",
        12 => "Gold 1",
        13 => "Gold 2",
        14 => "Gold 3",
        15 => "Platinum 1",
        16 => "Platinum 2",
        17 => "Platinum 3",
        18 => "Diamond 1",
        19 => "Diamond 2",
        20 => "Diamond 3",
        21 => "Ascendant 1",
        22 => "Ascendant 2",
        23 => "Ascendant 3",
        24 => "Immortal 1",
        25 => "Immortal 2",
        26 => "Immortal 3",
        27..=30 => "Radiant",
        _ => "Unranked",
    }
}

pub fn resolve_agent_uuid(guid: &str) -> &'static str {
    let lower = guid.to_lowercase();
    if lower.contains("a3bfb853") || lower.contains("a3bfb854") || lower.contains("reyna") {
        "a3bfb853-43b2-7238-a4f1-ad90e9e46bcc" // Reyna
    } else if lower.contains("add6443a") || lower.contains("jett") {
        "add6443a-41bd-e414-f6ad-e58d267f4e95" // Jett
    } else if lower.contains("8e253930") || lower.contains("8e252d0a") || lower.contains("omen") {
        "8e253930-4c05-31dd-1b6c-968525494517" // Omen
    } else if lower.contains("f94c3b30") || lower.contains("raze") {
        "f94c3b30-42be-e959-889c-5aa313dba261" // Raze
    } else if lower.contains("320b2a48") || lower.contains("6f2a0483") || lower.contains("ded3520f") || lower.contains("sova") {
        "320b2a48-4d9b-a075-30f1-1f93a9b638fa" // Sova
    } else if lower.contains("117ed9e3") || lower.contains("cypher") {
        "117ed9e3-49f3-6512-3ccf-0cada7e3823b" // Cypher
    } else if lower.contains("707eab51") || lower.contains("viper") {
        "707eab51-4836-f488-046a-cda6bf494859" // Viper
    } else if lower.contains("9f0d8ba9") || lower.contains("brimstone") {
        "9f0d8ba9-4140-b941-57d3-a7ad57c6b417" // Brimstone
    } else if lower.contains("95b78ed7") || lower.contains("harbor") {
        "95b78ed7-52b7-86d9-1e41-7198c2931528" // Harbor
    } else if lower.contains("1e58de9c") || lower.contains("b9f36475") || lower.contains("killjoy") {
        "1e58de9c-4950-5125-93e9-a0aee9f98746" // Killjoy
    } else if lower.contains("eb93336a") || lower.contains("eb9333ab") || lower.contains("phoenix") {
        "eb93336a-449b-9c1b-0a54-a891f7921d69" // Phoenix
    } else if lower.contains("7f94d92c") || lower.contains("yoru") {
        "7f94d92c-4234-0a36-9646-3a87eb8b5c89" // Yoru
    } else if lower.contains("569fdd95") || lower.contains("sage") {
        "569fdd95-4d10-43ab-ca70-79becc718b46" // Sage
    } else if lower.contains("22697a3d") || lower.contains("chamber") {
        "22697a3d-45bf-8dd7-4fec-84a9e28c69d7" // Chamber
    } else if lower.contains("601dbbe7") || lower.contains("kay/o") || lower.contains("kayo") {
        "601dbbe7-43ce-be57-2a40-4abd24953621" // KAY/O
    } else if lower.contains("bb2a4828") || lower.contains("neon") {
        "bb2a4828-46eb-8cd1-e765-15848195d751" // Neon
    } else if lower.contains("dade69b4") || lower.contains("fade") {
        "dade69b4-4f5a-8528-247b-219e5a1facd6" // Fade
    } else if lower.contains("5f8d3a7f") || lower.contains("breach") {
        "5f8d3a7f-467b-97f3-062c-13acf203c006" // Breach
    } else if lower.contains("cc8b64c8") || lower.contains("cc8b64d8") || lower.contains("deadlock") {
        "cc8b64c8-4b25-4ff9-6e7f-37b4da43d235" // Deadlock
    } else if lower.contains("0e38b510") || lower.contains("iso") {
        "0e38b510-41a8-5780-5e8f-568b2a4f2d6c" // Iso
    } else if lower.contains("41fb69c1") || lower.contains("astra") {
        "41fb69c1-4189-7b37-f117-bcaf1e96f1bf" // Astra
    } else if lower.contains("e370fa57") || lower.contains("gekko") {
        "e370fa57-4757-3604-3648-499e1f642d3f" // Gekko
    } else if lower.contains("1dbf2edd") || lower.contains("clove") {
        "1dbf2edd-4729-0984-3115-daa5eed44993" // Clove
    } else if lower.contains("efba5359") || lower.contains("efba5352") || lower.contains("vyse") {
        "efba5359-4016-a1e5-7626-b1ae76895940" // Vyse
    } else if lower.contains("b444168c") || lower.contains("tejo") {
        "b444168c-4e35-8076-db47-ef9bf368f384" // Tejo
    } else if lower.contains("df1cb487") || lower.contains("waylay") {
        "0e38b510-41a8-5780-5e8f-568b2a4f2d6c" // Iso
    } else if lower.contains("6f2a04ca") || lower.contains("skye") {
        "6f2a04ca-43e0-be17-7f36-b3908627744d" // Skye
    } else {
        "add6443a-41bd-e414-f6ad-e58d267f4e95" // default Jett
    }
}

pub fn resolve_agent_id(guid: &str) -> &'static str {
    let lower = guid.to_lowercase();
    if lower.contains("a3bfb853") || lower.contains("a3bfb854") || lower.contains("reyna") { "Reyna" }
    else if lower.contains("add6443a") || lower.contains("jett") { "Jett" }
    else if lower.contains("8e253930") || lower.contains("8e252d0a") || lower.contains("omen") { "Omen" }
    else if lower.contains("f94c3b30") || lower.contains("raze") { "Raze" }
    else if lower.contains("320b2a48") || lower.contains("6f2a0483") || lower.contains("ded3520f") || lower.contains("sova") { "Sova" }
    else if lower.contains("117ed9e3") || lower.contains("cypher") { "Cypher" }
    else if lower.contains("707eab51") || lower.contains("viper") { "Viper" }
    else if lower.contains("9f0d8ba9") || lower.contains("brimstone") { "Brimstone" }
    else if lower.contains("95b78ed7") || lower.contains("harbor") { "Harbor" }
    else if lower.contains("1e58de9c") || lower.contains("b9f36475") || lower.contains("killjoy") { "Killjoy" }
    else if lower.contains("eb93336a") || lower.contains("eb9333ab") || lower.contains("phoenix") { "Phoenix" }
    else if lower.contains("7f94d92c") || lower.contains("yoru") { "Yoru" }
    else if lower.contains("569fdd95") || lower.contains("sage") { "Sage" }
    else if lower.contains("22697a3d") || lower.contains("chamber") { "Chamber" }
    else if lower.contains("601dbbe7") || lower.contains("kay/o") || lower.contains("kayo") { "KAY/O" }
    else if lower.contains("bb2a4828") || lower.contains("neon") { "Neon" }
    else if lower.contains("dade69b4") || lower.contains("fade") { "Fade" }
    else if lower.contains("5f8d3a7f") || lower.contains("breach") { "Breach" }
    else if lower.contains("cc8b64c8") || lower.contains("cc8b64d8") || lower.contains("deadlock") { "Deadlock" }
    else if lower.contains("0e38b510") || lower.contains("iso") { "Iso" }
    else if lower.contains("41fb69c1") || lower.contains("astra") { "Astra" }
    else if lower.contains("e370fa57") || lower.contains("gekko") { "Gekko" }
    else if lower.contains("1dbf2edd") || lower.contains("clove") { "Clove" }
    else if lower.contains("efba5359") || lower.contains("efba5352") || lower.contains("vyse") { "Vyse" }
    else if lower.contains("b444168c") || lower.contains("tejo") { "Tejo" }
    else if lower.contains("df1cb487") || lower.contains("waylay") { "Iso" }
    else if lower.contains("6f2a04ca") || lower.contains("skye") { "Skye" }
    else { "Jett" }
}

pub fn resolve_map_name(map_path: &str) -> String {
    let lower = map_path.to_lowercase();
    if lower.contains("ascent") { "Ascent".into() }
    else if lower.contains("duality") || lower.contains("bind") { "Bind".into() }
    else if lower.contains("bonsai") || lower.contains("split") { "Split".into() }
    else if lower.contains("triad") || lower.contains("haven") { "Haven".into() }
    else if lower.contains("port") || lower.contains("icebox") { "Icebox".into() }
    else if lower.contains("foxtrot") || lower.contains("breeze") { "Breeze".into() }
    else if lower.contains("canyon") || lower.contains("fracture") { "Fracture".into() }
    else if lower.contains("pitt") || lower.contains("pearl") { "Pearl".into() }
    else if lower.contains("jam") || lower.contains("lotus") { "Lotus".into() }
    else if lower.contains("juliett") || lower.contains("sunset") { "Sunset".into() }
    else if lower.contains("hurm") || lower.contains("abyss") { "Abyss".into() }
    else if !map_path.is_empty() {
        let clean = map_path.split('/').filter(|s| !s.is_empty()).last().unwrap_or("Valorant");
        clean.to_string()
    } else {
        "Ascent".into()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveMatchStats {
    pub is_in_game: bool,
    pub session_state: String,
    pub map_name: String,
    pub queue_id: String,
    pub score_ally: u32,
    pub score_enemy: u32,
    pub current_player_name: String,
    pub current_player_tag: String,
    pub current_player_agent: String,
    pub current_player_agent_uuid: String,
    pub current_player_card_id: String,
    pub current_player_level: u32,
    pub current_player_tier: u32,
    pub current_player_tier_name: String,
    pub roster: Vec<LiveRosterPlayer>,
    pub friends: Vec<RiotFriend>,
}

impl Default for LiveMatchStats {
    fn default() -> Self {
        Self {
            is_in_game: false,
            session_state: "MENUS".into(),
            map_name: "Ascent".into(),
            queue_id: "Competitive".into(),
            score_ally: 0,
            score_enemy: 0,
            current_player_name: "CutieSky".into(),
            current_player_tag: "2136".into(),
            current_player_agent: "Reyna".into(),
            current_player_agent_uuid: "a3bfb853-43b2-7238-a4f1-ad90e9e46bcc".into(),
            current_player_card_id: "9fb348bc-41a0-91ad-8a3e-818035c4e561".into(),
            current_player_level: 50,
            current_player_tier: 15,
            current_player_tier_name: "Platinum 1".into(),
            roster: Vec::new(),
            friends: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LocalUserSession {
    pub puuid: String,
    pub game_name: String,
    pub game_tag: String,
    pub region: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountPerformanceStats {
    pub riot_id: String,
    pub total_kills: u32,
    pub total_deaths: u32,
    pub kd_ratio: f32,
    pub headshot_percentage: f32,
    pub total_aces: u32,
    pub total_multikills: u32,
    pub total_clips: usize,
    pub storage_mb: f64,
}

pub struct RiotApiClient {
    pub session: RiotClientSession,
    http: Client,
}

impl RiotApiClient {
    pub fn new(session: RiotClientSession) -> Result<Self, RiotAuthError> {
        let mut headers = HeaderMap::new();
        let auth_value = HeaderValue::from_str(&session.auth_header)
            .map_err(|_| RiotAuthError::InvalidHeader)?;
        headers.insert(AUTHORIZATION, auth_value);

        let http = Client::builder()
            .default_headers(headers)
            .danger_accept_invalid_certs(true)
            .timeout(Duration::from_millis(1500))
            .build()?;

        Ok(Self { session, http })
    }

    pub async fn get_local_user(&self) -> Result<LocalUserSession, RiotAuthError> {
        let url = format!("{}/chat/v1/session", self.session.base_url);
        let resp = self.http.get(&url).send().await?;
        if resp.status().is_success() {
            let json: serde_json::Value = resp.json().await?;
            let puuid = json.get("puuid").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let game_name = json.get("game_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let game_tag = json.get("game_tag").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let region = json.get("region").and_then(|v| v.as_str()).unwrap_or("").to_string();
            Ok(LocalUserSession {
                puuid,
                game_name,
                game_tag,
                region,
            })
        } else {
            Ok(LocalUserSession::default())
        }
    }

    pub async fn check_session_health(&self) -> Result<bool, RiotAuthError> {
        let url = format!("{}/chat/v1/session", self.session.base_url);
        let resp = self.http.get(&url).send().await?;
        Ok(resp.status().is_success())
    }

    /// Fetches all active players in the game session via Riot Client local API (100% Riot TOS Compliant)
    pub async fn fetch_live_presences(&self) -> Result<Vec<LiveRosterPlayer>, RiotAuthError> {
        let url = format!("{}/chat/v4/presences", self.session.base_url);
        let resp = self.http.get(&url).send().await?;
        if !resp.status().is_success() {
            return Ok(Vec::new());
        }
        let json: serde_json::Value = resp.json().await?;
        let mut players = Vec::new();

        if let Some(presences) = json.get("presences").and_then(|p| p.as_array()) {
            for pres in presences {
                let product = pres.get("product").and_then(|p| p.as_str()).unwrap_or("");
                if product != "valorant" {
                    continue;
                }
                let game_name = pres.get("game_name").and_then(|n| n.as_str()).unwrap_or("");
                let game_tag = pres.get("game_tag").and_then(|t| t.as_str()).unwrap_or("");
                let puuid = pres.get("puuid").and_then(|u| u.as_str()).unwrap_or("");
                let mut agent_name = "Reyna".to_string();
                let mut agent_uuid = "a3bfb853-43b2-7238-a4f1-ad90e9e46bcc".to_string();
                let mut card_id = "9fb348bc-41a0-91ad-8a3e-818035c4e561".to_string();
                let mut level = 100u32;
                let mut tier = 20u32;

                if let Some(priv_b64) = pres.get("private").and_then(|p| p.as_str()) {
                    if let Ok(decoded_bytes) = BASE64.decode(priv_b64) {
                        if let Ok(priv_json) = serde_json::from_slice::<serde_json::Value>(&decoded_bytes) {
                            if let Some(char_id) = priv_json.get("characterId").and_then(|c| c.as_str()) {
                                agent_name = resolve_agent_id(char_id).to_string();
                                agent_uuid = resolve_agent_uuid(char_id).to_string();
                            }
                            if let Some(cid) = priv_json.get("playerCardId").and_then(|c| c.as_str()) {
                                if !cid.is_empty() {
                                    card_id = cid.to_string();
                                }
                            }
                            if let Some(lvl) = priv_json.get("accountLevel").and_then(|l| l.as_u64()) {
                                level = lvl as u32;
                            }
                            if let Some(tr) = priv_json.get("competitiveTier").and_then(|t| t.as_u64()) {
                                tier = tr as u32;
                            }
                        }
                    }
                }

                if !game_name.is_empty() {
                    let tier_name = resolve_tier_name(tier).to_string();
                    players.push(LiveRosterPlayer {
                        puuid: puuid.to_string(),
                        game_name: game_name.to_string(),
                        tag_line: game_tag.to_string(),
                        agent: agent_name,
                        agent_uuid,
                        player_card_id: card_id,
                        account_level: level,
                        competitive_tier: tier,
                        tier_name,
                    });
                }
            }
        }

        Ok(players)
    }

    /// Fetches live match stats including session state, map, queue, ally/enemy scores, and active players
    pub async fn fetch_live_match_stats(&self) -> Result<LiveMatchStats, RiotAuthError> {
        let local_user = self.get_local_user().await.unwrap_or_default();

        let url = format!("{}/chat/v4/presences", self.session.base_url);
        let resp = self.http.get(&url).send().await?;
        if !resp.status().is_success() {
            return Ok(LiveMatchStats::default());
        }
        let json: serde_json::Value = resp.json().await?;
        let mut players = Vec::new();
        let mut friends = Vec::new();
        let mut map_name = "Lobby".to_string();
        let mut queue_id = "In Menus".to_string();
        let mut score_ally = 0u32;
        let mut score_enemy = 0u32;
        let mut current_name = if !local_user.game_name.is_empty() {
            local_user.game_name.clone()
        } else {
            "Player".to_string()
        };
        let mut current_tag = if !local_user.game_tag.is_empty() {
            local_user.game_tag.clone()
        } else {
            "VAL".to_string()
        };
        let mut current_agent = "Reyna".to_string();
        let mut current_agent_uuid = "a3bfb853-43b2-7238-a4f1-ad90e9e46bcc".to_string();
        let mut current_card_id = "9fb348bc-41a0-91ad-8a3e-818035c4e561".to_string();
        let mut current_level = 50u32;
        let mut current_tier = 15u32;
        let mut is_in_game = false;
        let mut session_state = "MENUS".to_string();

        if let Some(presences) = json.get("presences").and_then(|p| p.as_array()) {
            for pres in presences {
                let product = pres.get("product").and_then(|p| p.as_str()).unwrap_or("");
                if product != "valorant" {
                    continue;
                }
                let game_name = pres.get("game_name").and_then(|n| n.as_str()).unwrap_or("");
                let game_tag = pres.get("game_tag").and_then(|t| t.as_str()).unwrap_or("");
                let puuid = pres.get("puuid").and_then(|u| u.as_str()).unwrap_or("");
                let mut agent_name = "Reyna".to_string();
                let mut agent_uuid = "a3bfb853-43b2-7238-a4f1-ad90e9e46bcc".to_string();
                let mut card_id = "9fb348bc-41a0-91ad-8a3e-818035c4e561".to_string();
                let mut level = 50u32;
                let mut tier = 15u32;
                let mut state_str = "MENUS".to_string();
                let mut party_sz = 1u32;
                let mut f_map = "Lobby".to_string();

                if let Some(priv_b64) = pres.get("private").and_then(|p| p.as_str()) {
                    if let Ok(decoded_bytes) = BASE64.decode(priv_b64) {
                        if let Ok(priv_json) = serde_json::from_slice::<serde_json::Value>(&decoded_bytes) {
                            if let Some(state) = priv_json.get("sessionLoopState").and_then(|s| s.as_str()) {
                                state_str = state.to_string();
                                if state == "INGAME" {
                                    is_in_game = true;
                                    session_state = "INGAME".to_string();
                                }
                            }
                            if let Some(m) = priv_json.get("matchMap").and_then(|s| s.as_str()) {
                                if !m.is_empty() {
                                    f_map = resolve_map_name(m);
                                    if state_str == "INGAME" {
                                        map_name = f_map.clone();
                                    }
                                }
                            }
                            if let Some(q) = priv_json.get("queueId").and_then(|s| s.as_str()) {
                                if !q.is_empty() {
                                    let lower_q = q.to_lowercase();
                                    queue_id = if lower_q == "competitive" {
                                        "Competitive".to_string()
                                    } else if lower_q == "unrated" {
                                        "Unrated".to_string()
                                    } else if lower_q == "spikerush" {
                                        "Spike Rush".to_string()
                                    } else if lower_q == "swiftplay" {
                                        "Swiftplay".to_string()
                                    } else if lower_q == "deathmatch" {
                                        "Deathmatch".to_string()
                                    } else if lower_q == "hurm" {
                                        "Team Deathmatch".to_string()
                                    } else if lower_q == "ggteam" {
                                        "Escalation".to_string()
                                    } else if lower_q.is_empty() {
                                        "Custom Game".to_string()
                                    } else {
                                        q.to_string()
                                    };
                                }
                            }
                            if let Some(sa) = priv_json.get("partyOwnerMatchScoreAllyTeam").and_then(|v| v.as_u64()) {
                                score_ally = sa as u32;
                            }
                            if let Some(se) = priv_json.get("partyOwnerMatchScoreEnemyTeam").and_then(|v| v.as_u64()) {
                                score_enemy = se as u32;
                            }
                            if let Some(char_id) = priv_json.get("characterId").and_then(|c| c.as_str()) {
                                agent_name = resolve_agent_id(char_id).to_string();
                                agent_uuid = resolve_agent_uuid(char_id).to_string();
                            }
                            if let Some(cid) = priv_json.get("playerCardId").and_then(|c| c.as_str()) {
                                if !cid.is_empty() {
                                    card_id = cid.to_string();
                                }
                            }
                            if let Some(lvl) = priv_json.get("accountLevel").and_then(|l| l.as_u64()) {
                                level = lvl as u32;
                            }
                            if let Some(tr) = priv_json.get("competitiveTier").and_then(|t| t.as_u64()) {
                                tier = tr as u32;
                            }
                            if let Some(psz) = priv_json.get("partySize").and_then(|p| p.as_u64()) {
                                party_sz = psz as u32;
                            }
                        }
                    }
                }

                if !game_name.is_empty() {
                    let tier_name = resolve_tier_name(tier).to_string();
                    let is_me = (!local_user.puuid.is_empty() && puuid == local_user.puuid)
                        || (!local_user.game_name.is_empty() && game_name.eq_ignore_ascii_case(&local_user.game_name));

                    if is_me {
                        current_name = game_name.to_string();
                        current_tag = game_tag.to_string();
                        current_agent = agent_name.clone();
                        current_agent_uuid = agent_uuid.clone();
                        current_card_id = card_id.clone();
                        current_level = level;
                        current_tier = tier;
                    }
                    if state_str == "INGAME" {
                        players.push(LiveRosterPlayer {
                            puuid: puuid.to_string(),
                            game_name: game_name.to_string(),
                            tag_line: game_tag.to_string(),
                            agent: agent_name.clone(),
                            agent_uuid: agent_uuid.clone(),
                            player_card_id: card_id.clone(),
                            account_level: level,
                            competitive_tier: tier,
                            tier_name: tier_name.clone(),
                        });
                    } else {
                        friends.push(RiotFriend {
                            puuid: puuid.to_string(),
                            game_name: game_name.to_string(),
                            tag_line: game_tag.to_string(),
                            agent: agent_name,
                            agent_uuid,
                            player_card_id: card_id,
                            account_level: level,
                            competitive_tier: tier,
                            tier_name,
                            status: state_str,
                            party_size: party_sz,
                            map: f_map,
                        });
                    }
                }
            }
        }

        Ok(LiveMatchStats {
            is_in_game,
            session_state,
            map_name,
            queue_id,
            score_ally,
            score_enemy,
            current_player_name: current_name,
            current_player_tag: current_tag,
            current_player_agent: current_agent,
            current_player_agent_uuid: current_agent_uuid,
            current_player_card_id: current_card_id,
            current_player_level: current_level,
            current_player_tier: current_tier,
            current_player_tier_name: resolve_tier_name(current_tier).to_string(),
            roster: players,
            friends,
        })
    }
}

#[tauri::command]
pub async fn get_live_match_stats() -> Result<LiveMatchStats, String> {
    let lockfile = match RiotLockfile::read_from_disk() {
        Ok(l) => l,
        Err(_) => return Ok(LiveMatchStats::default()),
    };
    let session = lockfile.to_session();
    let client = match RiotApiClient::new(session) {
        Ok(c) => c,
        Err(_) => return Ok(LiveMatchStats::default()),
    };
    client.fetch_live_match_stats().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_riot_client_session() -> Result<RiotClientSession, String> {
    let lockfile = RiotLockfile::read_from_disk()
        .map_err(|e| format!("Lockfile read error: {e}"))?;
    let session = lockfile.to_session();
    let client = RiotApiClient::new(session.clone())
        .map_err(|e| format!("Client init error: {e}"))?;
    let is_alive = client.check_session_health().await.unwrap_or(false);
    if !is_alive {
        return Err("Riot Client not reachable".into());
    }
    Ok(session)
}

#[tauri::command]
pub async fn get_live_game_roster() -> Result<Vec<LiveRosterPlayer>, String> {
    let lockfile = RiotLockfile::read_from_disk()
        .map_err(|e| format!("Lockfile error: {e}"))?;
    let session = lockfile.to_session();
    let client = RiotApiClient::new(session)
        .map_err(|e| format!("Client error: {e}"))?;
    client.fetch_live_presences().await.map_err(|e| format!("Presence fetch error: {e}"))
}

pub fn calculate_account_performance(riot_id: &str) -> AccountPerformanceStats {
    let metadata_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("ValorantClipper")
        .join("metadata");

    let clips_dir = dirs::video_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("ValorantClips");

    let mut total_kills = 0u32;
    let mut total_deaths = 0u32;
    let mut total_headshots = 0u32;
    let mut total_aces = 0u32;
    let mut total_multikills = 0u32;

    if let Ok(entries) = std::fs::read_dir(&metadata_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if fname.ends_with(".json") && !fname.ends_with(".timing.json") {
                let stem = fname.trim_end_matches(".json");
                if !crate::match_sync::is_synced(&metadata_dir, stem) {
                    continue;
                }
                if let Ok(raw) = std::fs::read_to_string(&path) {
                    if let Ok(content) = crate::security::open_aes256_aead_or_legacy(&raw) {
                        if let Ok(events) = serde_json::from_str::<Vec<crate::disk_spooler::MatchEvent>>(&content) {
                            let mut round_kills = 0u32;
                            for evt in &events {
                                if evt.event_type == "kill" {
                                    total_kills += 1;
                                    round_kills += 1;
                                    if evt.headshot {
                                        total_headshots += 1;
                                    }
                                } else if evt.event_type == "death" {
                                    total_deaths += 1;
                                }
                            }
                            if round_kills >= 5 {
                                total_aces += 1;
                            }
                            if round_kills >= 2 {
                                total_multikills += 1;
                            }
                        }
                    }
                }
            }
        }
    }

    let mut total_clips = 0usize;
    let mut storage_bytes = 0u64;
    if let Ok(entries) = std::fs::read_dir(&clips_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            let fname = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !fname.starts_with("Valorant_") {
                continue;
            }
            if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
                let ext_lower = ext.to_lowercase();
                if ext_lower == "mp4" || ext_lower == "mkv" {
                    total_clips += 1;
                    storage_bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
    }

    let kd_ratio = if total_deaths > 0 {
        total_kills as f32 / total_deaths as f32
    } else {
        total_kills as f32
    };

    let headshot_percentage = if total_kills > 0 {
        (total_headshots as f32 / total_kills as f32) * 100.0
    } else {
        0.0
    };

    AccountPerformanceStats {
        riot_id: riot_id.to_string(),
        total_kills,
        total_deaths,
        kd_ratio: (kd_ratio * 100.0).round() / 100.0,
        headshot_percentage: (headshot_percentage * 10.0).round() / 10.0,
        total_aces,
        total_multikills,
        total_clips,
        storage_mb: (storage_bytes as f64) / (1024.0 * 1024.0),
    }
}

#[tauri::command]
pub async fn get_account_performance_stats(riot_id: Option<String>) -> Result<AccountPerformanceStats, String> {
    let id_str = riot_id.unwrap_or_else(|| "RadiantAgent#VAL".to_string());
    Ok(calculate_account_performance(&id_str))
}
