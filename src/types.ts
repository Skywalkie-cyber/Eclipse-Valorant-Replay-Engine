export interface MatchEvent {
  timestamp_pts: number;
  event_time_ms: number;
  round: number;
  event_type: string;
  weapon?: string;
  headshot: boolean;
  victim?: string;
  killer?: string;
  site?: string;
  kill_number?: number;
  multi_kill_label?: string;
  reason?: string | null;
}

export interface ClipEntry {
  file_name: string;
  full_path: string;
  created_at: string;
  file_size_mb: number;
  has_timeline: boolean;
}

export interface LiveRosterPlayer {
  puuid: string;
  game_name: string;
  tag_line: string;
  agent: string;
  agent_uuid: string;
  player_card_id: string;
  account_level: number;
  competitive_tier: number;
  tier_name: string;
}

export interface RiotFriend {
  puuid: string;
  game_name: string;
  tag_line: string;
  agent: string;
  agent_uuid: string;
  player_card_id: string;
  account_level: number;
  competitive_tier: number;
  tier_name: string;
  status: string;
  party_size: number;
  map: string;
}

export interface LiveMatchStats {
  is_in_game: boolean;
  session_state: string;
  map_name: string;
  queue_id: string;
  score_ally: number;
  score_enemy: number;
  current_player_name: string;
  current_player_tag: string;
  current_player_agent: string;
  current_player_agent_uuid: string;
  current_player_card_id: string;
  current_player_level: number;
  current_player_tier: number;
  current_player_tier_name: string;
  roster: LiveRosterPlayer[];
  friends: RiotFriend[];
}

export interface AccountPerformanceStats {
  riot_id: string;
  total_kills: number;
  total_deaths: number;
  kd_ratio: number;
  headshot_percentage: number;
  total_aces: number;
  total_multikills: number;
  total_clips: number;
  storage_mb: number;
}

export interface ClipRoundPlayer {
  puuid: string;
  game_name: string;
  tag_line: string;
  team_id: string;
  is_ally: boolean;
  is_self: boolean;
  agent_name: string;
  agent_uuid: string;
  player_card_id?: string;
  account_level?: number;
  competitive_tier: number;
  tier_name: string;
  kills: number;
  deaths: number;
  assists: number;
  combat_score: number;
}

export interface ClipRoundDetails {
  match_id: string;
  round_number: number;
  queue_id: string;
  map_name: string;
  duration_label: string;
  score_ally: number;
  score_enemy: number;
  outcome_label: string;
  ally_won_round: boolean;
  recorded_at_label: string;
  user_name?: string;
  user_tag?: string;
  user_agent?: string;
  user_agent_uuid?: string;
  user_card_id?: string;
  user_level?: number;
  user_tier?: number;
  user_tier_name?: string;
  team_a: ClipRoundPlayer[];
  team_b: ClipRoundPlayer[];
}

export interface SecurityStatus {
  cipher: string;
  key_derivation: string;
  anti_interception_active: boolean;
  encrypted_vault_files: number;
}

export interface RiotUserSession {
  base_url?: string;
  auth_header?: string;
  pid?: number;
  port?: number;
  game_name?: string;
  tag_line?: string;
  player_card_id?: string;
  account_level?: number;
}

export interface ShareData {
  local_url: string;
  lan_url: string;
  stream_url: string;
  access: 'anyone' | 'restricted';
  file_name: string;
  file_path: string;
  custom_domain_url: string;
  encrypted_token: string;
  encryption_key_hex: string;
  stackryze_domain: string;
}

