import { createSignal, createEffect, onMount, onCleanup, Show, For } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { ClipEntry, ClipRoundDetails, ClipRoundPlayer, MatchEvent, RiotUserSession, LiveMatchStats } from '../../types';
import { KillEmblemIcon, SkullDeathIcon } from './TimelineBar';

interface RightPanelProps {
  selectedClip: ClipEntry | null;
  roundDetails: ClipRoundDetails | null;
  clipEvents: MatchEvent[];
  isSyncingRound: boolean;
  onOpenFolder: (e: MouseEvent, clip: ClipEntry) => void;
  onSyncRound: () => void;
  onRenameClip: (clip: ClipEntry, newTitle: string) => Promise<void>;
  onCopyPlayerId: (riotId: string) => void;
}

export interface ValorantAgentInfo {
  name: string;
  uuid: string;
  role: string;
  cardId: string;
}

interface GameStatus {
  is_running: boolean;
  pid: number | null;
  process_name: string | null;
  riot_client_running: boolean;
  status_text: string;
}

export const VALORANT_AGENTS: ValorantAgentInfo[] = [
  { name: 'Jett', uuid: 'add6443a-41bd-e414-f6ad-e58d267f4e95', role: 'Duelist', cardId: '9fb348bc-41a0-91ad-8a3e-818035c4e561' },
  { name: 'Reyna', uuid: 'a3bfb853-43b2-7238-a4f1-ad90e9e46bcc', role: 'Duelist', cardId: '8093112b-42fa-10b2-7640-1a84f3eb7305' },
  { name: 'Phoenix', uuid: 'eb93336a-449b-9c1b-0a54-a891f7921d69', role: 'Duelist', cardId: 'f0c0b3f7-4180-2a8d-b3a6-b5bbd09cebcf' },
  { name: 'Raze', uuid: 'f94c3b30-42be-e959-889c-5dab3194a14d', role: 'Duelist', cardId: 'ec21d46b-45be-0e2f-5f75-3bba30d24be2' },
  { name: 'Yoru', uuid: '7f94d92c-4234-0a36-9646-3a87eb8b5c89', role: 'Duelist', cardId: '6338b368-45e3-6a95-5cb3-29a3ac11ebff' },
  { name: 'Neon', uuid: 'bb2a4828-46eb-8cd1-e765-15848195d73a', role: 'Duelist', cardId: '47d7fa7a-4290-7bf0-c513-5a9e376ffaa4' },
  { name: 'Iso', uuid: '0e38b510-41a8-5780-5e8f-568b2a4f2d6c', role: 'Duelist', cardId: '5b1a03f4-4e48-3197-030b-d290c0137ffb' },
  { name: 'Omen', uuid: '8e252d0a-4ee4-7d20-4e30-229b2803f135', role: 'Controller', cardId: 'a310dd7e-4028-2b89-a292-12b258525b30' },
  { name: 'Viper', uuid: '707eab51-47e6-80d7-2686-cbd40461876e', role: 'Controller', cardId: '3c0a52b8-4c90-e7ef-1976-189f7f44d9f6' },
  { name: 'Brimstone', uuid: '9f0d8ba9-4140-b941-57d3-a7ad57c6b417', role: 'Controller', cardId: 'd66d7e2e-432a-5b1e-b830-41bbd0e0ffb0' },
  { name: 'Astra', uuid: '41fb69c1-4189-7b37-f117-bcaf1e96f1bf', role: 'Controller', cardId: 'b55e8e3a-4415-3852-6c17-18a77f3747bf' },
  { name: 'Harbor', uuid: '95b78ed7-4637-86d9-7e41-71ba8c293152', role: 'Controller', cardId: 'e2cf5e1e-4581-229d-4720-33b6329fc5f4' },
  { name: 'Clove', uuid: '1dbf2edd-4729-0984-3115-daa5eed44993', role: 'Controller', cardId: 'e6371ec3-4886-455b-4395-5ab947513ffb' },
  { name: 'Sova', uuid: 'ded3520f-4264-bfed-162d-b080e2abccf9', role: 'Initiator', cardId: '2b7e28b8-498b-7140-5e04-79a0b12bc743' },
  { name: 'Breach', uuid: '5f8d3a7f-467b-97f3-062c-dd4099cf0af5', role: 'Initiator', cardId: '6b95b21d-4076-218d-94c0-f49553b6ee97' },
  { name: 'Skye', uuid: '6f2a04ca-43e0-be17-7f36-b3908627744d', role: 'Initiator', cardId: '9fa01f5c-43db-e87f-e220-4ea52e7284ad' },
  { name: 'KAY/O', uuid: '601dbbe7-43ce-be57-2a40-4abd24953621', role: 'Initiator', cardId: 'f568a221-4fec-06e1-953e-ecb439f0e137' },
  { name: 'Fade', uuid: 'dade69b4-4f5a-8528-247b-219e5a1facd6', role: 'Initiator', cardId: '1e52db9a-41e7-8bbf-f463-c793fffa00f7' },
  { name: 'Gekko', uuid: 'e370fa57-4757-3604-3648-499e1f642d3f', role: 'Initiator', cardId: '8097b6aa-4d87-32b0-40e8-0ca1a134d16d' },
  { name: 'Killjoy', uuid: '1e58de9c-4950-523c-32c6-a0a6aaac2877', role: 'Sentinel', cardId: 'cbf77f1e-450a-4286-6644-8da8b8e0a3f7' },
  { name: 'Cypher', uuid: '117ed9e3-49f3-6512-3ccf-0cada7e3823b', role: 'Sentinel', cardId: '2b09eb05-4c03-5188-7517-7fa5701a5509' },
  { name: 'Sage', uuid: '569fdd95-4d10-43ab-ca70-79becc718b46', role: 'Sentinel', cardId: '2e90c8a3-4886-455b-4395-5ab947513ffb' },
  { name: 'Chamber', uuid: '22697a3d-45bf-8dd7-4fec-84a9e28c69d7', role: 'Sentinel', cardId: 'd0e37bc6-4074-b5a8-276f-71ba0eb3e134' },
  { name: 'Deadlock', uuid: 'cc8b64c8-4b25-4ff9-6e7f-37b4da43d235', role: 'Sentinel', cardId: '6227db0b-402a-063a-bb96-5bb5e6ebff6b' },
  { name: 'Vyse', uuid: 'efba5359-4016-a1e5-7626-b1ae76895940', role: 'Sentinel', cardId: 'c061beae-463e-324e-b5dc-d48ea5ba9f3b' },
  { name: 'Tejo', uuid: 'b444168c-4e35-8076-db47-ef9bf368f384', role: 'Initiator', cardId: '9fb348bc-41a0-91ad-8a3e-818035c4e561' },
];

export const VALORANT_RANKS: { tier: number; name: string; color: string }[] = [
  { tier: 0, name: 'Unranked', color: '#94A3B8' },
  { tier: 3, name: 'Iron 1', color: '#6B7280' },
  { tier: 4, name: 'Iron 2', color: '#6B7280' },
  { tier: 5, name: 'Iron 3', color: '#6B7280' },
  { tier: 6, name: 'Bronze 1', color: '#A16207' },
  { tier: 7, name: 'Bronze 2', color: '#A16207' },
  { tier: 8, name: 'Bronze 3', color: '#A16207' },
  { tier: 9, name: 'Silver 1', color: '#CBD5E1' },
  { tier: 10, name: 'Silver 2', color: '#CBD5E1' },
  { tier: 11, name: 'Silver 3', color: '#CBD5E1' },
  { tier: 12, name: 'Gold 1', color: '#EAB308' },
  { tier: 13, name: 'Gold 2', color: '#EAB308' },
  { tier: 14, name: 'Gold 3', color: '#EAB308' },
  { tier: 15, name: 'Platinum 1', color: '#06B6D4' },
  { tier: 16, name: 'Platinum 2', color: '#06B6D4' },
  { tier: 17, name: 'Platinum 3', color: '#06B6D4' },
  { tier: 18, name: 'Diamond 1', color: '#C084FC' },
  { tier: 19, name: 'Diamond 2', color: '#C084FC' },
  { tier: 20, name: 'Diamond 3', color: '#C084FC' },
  { tier: 21, name: 'Ascendant 1', color: '#10B981' },
  { tier: 22, name: 'Ascendant 2', color: '#10B981' },
  { tier: 23, name: 'Ascendant 3', color: '#10B981' },
  { tier: 24, name: 'Immortal 1', color: '#F43F5E' },
  { tier: 25, name: 'Immortal 2', color: '#F43F5E' },
  { tier: 26, name: 'Immortal 3', color: '#F43F5E' },
  { tier: 27, name: 'Radiant', color: '#FDE047' },
];

export function getTierName(tier: any): string {
  const num = typeof tier === 'number' && Number.isFinite(tier) ? tier : 0;
  const match = VALORANT_RANKS.find((r) => r.tier === num);
  return match ? match.name : num === 0 ? 'Unranked' : `Tier ${num}`;
}

const DEFAULT_BANNER_CARD_ID = '9fb348bc-41a0-91ad-8a3e-818035c4e561';

function resolveAgentForClip(
  clipFileName: string,
  events: MatchEvent[],
  roundDetails: ClipRoundDetails | null,
  overrideAgent: string | null,
  liveAgent?: string | null
): ValorantAgentInfo {
  // 1. Manual user override for this clip
  if (overrideAgent) {
    const found = VALORANT_AGENTS.find((a) => a.name.toLowerCase() === overrideAgent.toLowerCase());
    if (found) return found;
  }
  if (clipFileName) {
    const saved = localStorage.getItem(`val_clip_agent_${clipFileName}`);
    if (saved) {
      const found = VALORANT_AGENTS.find((a) => a.name.toLowerCase() === saved.toLowerCase());
      if (found) return found;
    }
  }

  // 2. From verified roundDetails
  if (roundDetails?.user_agent) {
    const found = VALORANT_AGENTS.find(
      (a) => a.name.toLowerCase() === roundDetails.user_agent!.toLowerCase() || a.uuid === roundDetails.user_agent_uuid
    );
    if (found) return found;
  }
  const selfP = [...(roundDetails?.team_a || []), ...(roundDetails?.team_b || [])].find((p) => p.is_self);
  if (selfP?.agent_name) {
    const found = VALORANT_AGENTS.find((a) => a.name.toLowerCase() === selfP.agent_name.toLowerCase());
    if (found) return found;
  }

  // 3. Scan clip events for the player's agent
  for (const evt of events) {
    // If user made a kill, killer might be "Player (Reyna)" or "Reyna"
    const killerStr = (evt.killer || '').toLowerCase();
    for (const a of VALORANT_AGENTS) {
      const aLow = a.name.toLowerCase();
      if (killerStr.includes(`(${aLow})`) || killerStr === aLow) {
        return a;
      }
    }
    // If user died, victim might be "Player (Reyna)" or "Reyna"
    const victimStr = (evt.victim || '').toLowerCase();
    for (const a of VALORANT_AGENTS) {
      const aLow = a.name.toLowerCase();
      if (victimStr.includes(`(${aLow})`) || victimStr === aLow) {
        return a;
      }
    }
  }

  // 4. Scan clip file name (e.g. Valorant_Highlight_Reyna_... or Clip_Jett_...)
  const fLower = clipFileName.toLowerCase();
  for (const a of VALORANT_AGENTS) {
    const aLower = a.name.toLowerCase();
    if (fLower.includes(`_${aLower}_`) || fLower.includes(`_${aLower}.`) || fLower.includes(`-${aLower}-`) || fLower.includes(`(${aLower})`)) {
      return a;
    }
  }

  // 5. Active live in-game agent from Riot Client session
  if (liveAgent) {
    const found = VALORANT_AGENTS.find((a) => a.name.toLowerCase() === liveAgent.toLowerCase());
    if (found) return found;
  }

  // Default fallback
  return VALORANT_AGENTS[0]; // Jett
}

export function RightPanel(props: RightPanelProps) {
  const [showMatchStats] = createSignal(true);
  const [showAlbumDropdown, setShowAlbumDropdown] = createSignal(false);
  const [selectedAlbums, setSelectedAlbums] = createSignal<string[]>(['Valorant Highlights']);
  const [customAlbumInput, setCustomAlbumInput] = createSignal('');
  const [liveSession, setLiveSession] = createSignal<RiotUserSession | null>(null);
  const [liveMatch, setLiveMatch] = createSignal<LiveMatchStats | null>(null);
  const [clipAgentOverride, setClipAgentOverride] = createSignal<string | null>(null);
  const [showAgentPicker, setShowAgentPicker] = createSignal(false);
  const [agentSearchFilter, setAgentSearchFilter] = createSignal('');
  const [copiedRiotId, setCopiedRiotId] = createSignal<string | null>(null);
  const [gameStatus, setGameStatus] = createSignal<GameStatus>({
    is_running: false,
    pid: null,
    process_name: null,
    riot_client_running: false,
    status_text: 'Standby',
  });
  const [bufferDuration, setBufferDuration] = createSignal<number>(30);

  const handleCopyPlayerId = (riotId: string) => {
    props.onCopyPlayerId(riotId);
    setCopiedRiotId(riotId);
    setTimeout(() => {
      setCopiedRiotId((curr) => (curr === riotId ? null : curr));
    }, 1600);
  };

  const availableAlbums = ['Valorant Highlights', 'Clutch Rounds', 'Multi-Kills', 'Competitive VODs'];

  onMount(async () => {
    const updateGameStatus = async () => {
      try {
        const s = await invoke<GameStatus>('get_game_status');
        if (s) setGameStatus(s);
      } catch {}
    };
    updateGameStatus();
    const gameInterval = setInterval(updateGameStatus, 3000);

    try {
      const cfg = await invoke<{ buffer_length_seconds: number }>('get_config');
      if (cfg && cfg.buffer_length_seconds) {
        setBufferDuration(cfg.buffer_length_seconds);
      }
    } catch {}

    onCleanup(() => {
      clearInterval(gameInterval);
    });

    try {
      const session = await invoke<RiotUserSession>('get_riot_client_session');
      if (session && session.game_name) {
        setLiveSession(session);
      }
    } catch {
      // Riot client not running
    }
    try {
      const matchStats = await invoke<LiveMatchStats>('get_live_match_stats');
      if (matchStats && matchStats.current_player_name) {
        setLiveMatch(matchStats);
      }
    } catch {
      // Live stats not ready
    }
  });

  // Whenever the active clip changes, automatically load its persisted or detected agent
  createEffect(() => {
    const clip = props.selectedClip;
    if (!clip) {
      setClipAgentOverride(null);
      return;
    }

    const local = localStorage.getItem(`val_clip_agent_${clip.file_name}`);
    if (local) {
      setClipAgentOverride(local);
    } else {
      setClipAgentOverride(null);
    }

    invoke<string | null>('get_clip_agent', { filePath: clip.full_path })
      .then((saved) => {
        if (saved) {
          setClipAgentOverride(saved);
        }
      })
      .catch(() => {});
  });

  // Auto-dismiss agent picker when clicking outside
  createEffect(() => {
    if (!showAgentPicker()) return;
    const handleOutside = () => setShowAgentPicker(false);
    window.addEventListener('click', handleOutside);
    onCleanup(() => window.removeEventListener('click', handleOutside));
  });

  const [showRankPicker, setShowRankPicker] = createSignal(false);
  const getInitialRank = (): number | null => {
    try {
      const saved = localStorage.getItem('eclipse_user_rank');
      if (saved && /^\d+$/.test(saved.trim())) {
        const parsed = parseInt(saved.trim(), 10);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 27) {
          return parsed;
        }
      } else if (saved) {
        localStorage.removeItem('eclipse_user_rank');
      }
    } catch {}
    return null;
  };
  const [userRankOverride, setUserRankOverride] = createSignal<number | null>(getInitialRank());

  // Auto-dismiss rank picker when clicking outside
  createEffect(() => {
    if (!showRankPicker()) return;
    const handleOutside = () => setShowRankPicker(false);
    window.addEventListener('click', handleOutside);
    onCleanup(() => window.removeEventListener('click', handleOutside));
  });

  const handleSelectRank = (tier: number) => {
    setUserRankOverride(tier);
    localStorage.setItem('eclipse_user_rank', tier.toString());
    setShowRankPicker(false);
  };

  const handleSelectAgent = async (agentName: string) => {
    setClipAgentOverride(agentName);
    setShowAgentPicker(false);
    const clip = props.selectedClip;
    if (clip) {
      localStorage.setItem(`val_clip_agent_${clip.file_name}`, agentName);
      try {
        await invoke('set_clip_agent', { filePath: clip.full_path, agentName });
      } catch (e) {
        console.error('Failed to persist clip agent:', e);
      }
    }
  };

  const filteredAgents = () => {
    const q = agentSearchFilter().toLowerCase().trim();
    if (!q) return VALORANT_AGENTS;
    return VALORANT_AGENTS.filter(
      (a) => a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q)
    );
  };

  const toggleAlbum = async (album: string) => {
    const current = selectedAlbums();
    if (current.includes(album)) {
      setSelectedAlbums(current.filter((a) => a !== album));
    } else {
      setSelectedAlbums([...current, album]);
    }
  };

  const addCustomAlbum = async () => {
    const trimmed = customAlbumInput().trim();
    if (!trimmed) return;
    if (!selectedAlbums().includes(trimmed)) {
      setSelectedAlbums([...selectedAlbums(), trimmed]);
    }
    setCustomAlbumInput('');
    setShowAlbumDropdown(false);
  };

  const effectiveRoundDetails = () => {
    return props.roundDetails ?? null;
  };

  const clipRoundNumber = () => {
    if (props.roundDetails?.round_number) return props.roundDetails.round_number;
    const firstWithRound = props.clipEvents.find((e) => typeof e.round === 'number' && e.round > 0);
    return firstWithRound?.round || 1;
  };

  const selfPlayerFromRoster = (): ClipRoundPlayer | null => {
    const d = props.roundDetails;
    if (!d) return null;
    const all = [...(d.team_a || []), ...(d.team_b || [])];
    return all.find((p) => p.is_self) || all[0] || null;
  };

  const userProfile = () => {
    const clip = props.selectedClip;
    const d = props.roundDetails;
    const selfP = selfPlayerFromRoster();
    const sess = liveSession();
    const lStats = liveMatch();

    const agent = resolveAgentForClip(
      clip?.file_name || '',
      props.clipEvents,
      d,
      clipAgentOverride(),
      lStats?.current_player_agent
    );

    const rawName =
      (d?.user_name && d.user_name.trim() && d.user_name !== d.user_agent ? d.user_name : '') ||
      (lStats?.current_player_name && lStats.current_player_name !== 'Valorant Player' ? lStats.current_player_name : '') ||
      (selfP?.game_name && selfP.game_name.trim() && selfP.game_name !== selfP.agent_name ? selfP.game_name : '') ||
      (sess?.game_name && sess.game_name !== 'Valorant Player' ? sess.game_name : '') ||
      'CutieSky';

    const tag = d?.user_tag || lStats?.current_player_tag || selfP?.tag_line || sess?.tag_line || '2136';
    const cardId = agent.cardId || DEFAULT_BANNER_CARD_ID;
    const level = d?.user_level || lStats?.current_player_level || selfP?.account_level || sess?.account_level || 142;
    const rawOverride = userRankOverride();
    const overrideTier = typeof rawOverride === 'number' && Number.isFinite(rawOverride) ? rawOverride : null;
    const rawTier = overrideTier !== null
      ? overrideTier
      : (typeof d?.user_tier === 'number'
          ? d.user_tier
          : typeof lStats?.current_player_tier === 'number'
          ? lStats.current_player_tier
          : typeof selfP?.competitive_tier === 'number'
          ? selfP.competitive_tier
          : 0);
    const tier = Number.isFinite(rawTier) ? rawTier : 0;
    const tierName = getTierName(tier);
    const kills = props.clipEvents.length > 0
      ? props.clipEvents.filter((e) => e.event_type === 'kill').length
      : (selfP?.kills ?? 1);
    const deaths = props.clipEvents.length > 0
      ? props.clipEvents.filter((e) => e.event_type === 'death').length
      : (selfP?.deaths ?? 0);
    const assists = selfP?.assists ?? (props.clipEvents.length > 0 ? 0 : 4);

    return {
      name: rawName,
      tag,
      agentName: agent.name,
      agentUuid: agent.uuid,
      role: agent.role,
      cardId,
      level,
      tier,
      tierName,
      kills,
      deaths,
      assists,
    };
  };

  const resolveDistinctPlayerName = (player: ClipRoundPlayer, index: number, _teamPrefix: string) => {
    const gName = (player.game_name || '').trim();
    const aName = (player.agent_name || 'Agent').trim();
    if (player.is_self) {
      return userProfile().name || 'You';
    }
    if (gName && gName.toLowerCase() !== 'unknown' && gName.toLowerCase() !== 'player') {
      return gName;
    }
    return aName || `Player ${index + 1}`;
  };

  const isDeathmatch = (d?: ClipRoundDetails | null) => {
    if (!d) return false;
    const q = (d.queue_id || '').toLowerCase();
    return q === 'deathmatch' || q.includes('deathmatch');
  };

  const sortedDeathmatchPlayers = (d?: ClipRoundDetails | null) => {
    if (!d) return [];
    const all = [...(d.team_a || []), ...(d.team_b || [])];
    return all.sort((a, b) => (b.kills || 0) - (a.kills || 0));
  };

  const renderRankBadge = (player: ClipRoundPlayer, rankIndex?: number) => {
    if (rankIndex !== undefined) {
      const rankNum = rankIndex + 1;
      const rankStyle =
        rankNum === 1
          ? 'bg-gradient-to-br from-[#F59E0B] to-[#D97706] text-[#000000] font-black border-[#FCD34D]'
          : rankNum === 2
          ? 'bg-gradient-to-br from-[#E2E8F0] to-[#94A3B8] text-[#000000] font-black border-[#F8FAFC]'
          : rankNum === 3
          ? 'bg-gradient-to-br from-[#D97706] to-[#78350F] text-[#FFFFFF] font-black border-[#FBBF24]'
          : 'bg-[#12141A] text-[#94A3B8] font-bold border-[#2A2D34]';

      return (
        <div
          className={`size-4.5 rounded flex items-center justify-center shrink-0 border text-[9px] font-mono tabular-nums shadow-sm ${rankStyle}`}
          title={`Leaderboard Rank #${rankNum}`}
        >
          {rankNum}
        </div>
      );
    }

    if (player.competitive_tier && player.competitive_tier >= 3) {
      return (
        <div
          className="size-4.5 rounded-full bg-[#000000] border border-[#333333] flex items-center justify-center shrink-0 overflow-hidden"
          title={`Rank Tier ${player.competitive_tier}`}
        >
          <img
            src={`https://media.valorant-api.com/competitivetiers/03621f52-342b-cf4e-4f86-9350a49c6d04/${player.competitive_tier}/smallicon.png`}
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
            alt="Rank"
            className="size-3.5 object-contain"
          />
        </div>
      );
    }

    return (
      <div
        className="size-4.5 rounded-full bg-[#000000] border border-[#333333] flex items-center justify-center shrink-0 text-[#C084FC]"
        title="Competitive Match Tier"
      >
        <svg class="size-2.5 fill-current" viewBox="0 0 24 24">
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      </div>
    );
  };

  const renderPlayerRow = (player: ClipRoundPlayer, index: number, teamPrefix: 'A' | 'B' | 'FFA', rankIndex?: number) => {
    const displayName = resolveDistinctPlayerName(player, index, teamPrefix === 'FFA' ? 'FFA' : teamPrefix);
    const rawAgent = (player.agent_name || 'Agent').trim();
    const isWaylay = rawAgent.toLowerCase() === 'waylay';
    const characterName = player.is_self ? userProfile().agentName : (isWaylay ? 'Iso' : rawAgent);
    const characterUuid = player.is_self
      ? userProfile().agentUuid
      : (isWaylay ? '0e38b510-41a8-5780-5e8f-568b2a4f2d6c' : player.agent_uuid);
    const riotId = player.tag_line ? `${displayName}#${player.tag_line}` : displayName;

    const avatarBorder =
      teamPrefix === 'FFA'
        ? rankIndex === 0
          ? 'border-[#F59E0B]'
          : rankIndex === 1
          ? 'border-[#CBD5E1]'
          : rankIndex === 2
          ? 'border-[#D97706]'
          : 'border-[#2A2D34]'
        : teamPrefix === 'A'
        ? 'border-[#00D48F]/60'
        : 'border-[#FF4655]/55';

    return (
      <div
        className={`group px-3 py-2 flex items-center justify-between gap-2.5 border-b border-[#333333]/55 last:border-b-0 transition-all ${
          player.is_self
            ? 'bg-gradient-to-r from-[#FFFFFF]/20 via-[#BDBDBD]/10 to-transparent hover:from-[#FFFFFF]/25'
            : 'bg-[#000000]/85 hover:bg-[#1C1C1C]/95'
        }`}
      >
        {/* Left: Agent Portrait + Rank Icon + Player Name + Character Badge */}
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div
            className={`relative size-7 rounded-full overflow-hidden border bg-[#141414] shrink-0 shadow-sm transition-transform duration-200 group-hover:scale-105 ${avatarBorder}`}
          >
            <img
              src={`https://media.valorant-api.com/agents/${characterUuid}/displayicon.png`}
              onError={(e) => {
                e.currentTarget.src = `https://media.valorant-api.com/agents/${VALORANT_AGENTS[0].uuid}/displayicon.png`;
              }}
              alt={characterName}
              className="w-full h-full object-cover scale-110"
            />
          </div>

          {renderRankBadge(player, rankIndex)}

          <div className="flex flex-col min-w-0 flex-1 leading-tight gap-0.5">
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className="text-[11px] truncate font-bold tracking-tight text-[#FFFFFF]"
                title={`${riotId} • Character: ${characterName}`}
              >
                {displayName}
              </span>
              <Show when={player.is_self}>
                <span className="px-1 py-0.2 rounded text-[8px] font-black uppercase tracking-wider bg-[#7C3AED] text-[#FFFFFF]">
                  YOU
                </span>
              </Show>
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className={`inline-flex items-center px-1.5 py-0.2 rounded text-[9px] font-mono font-bold tracking-wide border ${
                  player.is_self
                    ? 'bg-[#7C3AED]/20 text-[#C084FC] border-[#9333EA]/40'
                    : teamPrefix === 'FFA'
                    ? 'bg-[#3F88C5]/15 text-[#93C5FD] border-[#3F88C5]/30'
                    : teamPrefix === 'A'
                    ? 'bg-[#00D48F]/15 text-[#00D48F] border-[#00D48F]/40'
                    : 'bg-[#FF4655]/15 text-[#FF8A93] border-[#FF4655]/35'
                }`}
              >
                {characterName}
              </span>
            </div>
          </div>
        </div>

        {/* Center-Right: Single-Line Spaced KDA */}
        <div className="min-w-[98px] whitespace-nowrap text-right font-mono text-[11px] font-bold text-[#FFFFFF] tabular-nums shrink-0 px-2 py-0.5 rounded bg-[#000000]/85 border border-[#333333]/80">
          <span className="text-[#FFFFFF]">{player.kills}</span>
          <span className="text-[#BDBDBD]/70 mx-1">/</span>
          <span className="text-[#E5E5E5]">{player.deaths}</span>
          <span className="text-[#BDBDBD]/70 mx-1">/</span>
          <span className="text-[#FFFFFF]">{player.assists}</span>
        </div>

        {/* Right: Action Pill (Copy ID / YOU) */}
        <div className="w-[66px] flex justify-end shrink-0">
          <Show
            when={!player.is_self}
            fallback={
              <span className="px-2 py-0.5 rounded text-[9px] font-black tracking-wider uppercase bg-[#7C3AED]/20 text-[#C084FC] border border-[#9333EA]/40">
                YOU
              </span>
            }
          >
            <button
              type="button"
              onClick={() => handleCopyPlayerId(riotId)}
              className={`px-2 py-0.5 rounded text-[9px] font-mono font-bold transition-all btn-tactile flex items-center justify-center gap-1 border ${
                copiedRiotId() === riotId
                  ? 'bg-[#00D48F] text-[#000000] border-[#00D48F] font-black shadow-sm'
                  : 'border-[#2A2D34] bg-[#12141A] hover:bg-[#7C3AED] hover:text-[#FFFFFF] hover:border-[#9333EA] text-[#CBD5E1]'
              }`}
              title={`Copy Riot ID: ${riotId}`}
            >
              <Show
                when={copiedRiotId() === riotId}
                fallback={
                  <>
                    <svg class="size-2.5 opacity-80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    <span>Copy ID</span>
                  </>
                }
              >
                <span>Copied!</span>
              </Show>
            </button>
          </Show>
        </div>
      </div>
    );
  };

  return (
    <aside
      className="relative w-[378px] xl:w-[396px] h-full min-h-0 bg-[#0A0A0A]/82 backdrop-blur-xl border-l border-[#333333] flex flex-col select-none shrink-0 text-[#FFFFFF] overflow-hidden"
      aria-label="Clip Round Match Stats"
    >
      {/* Ambient Translucent User Banner Backdrop in the Right Panel Background */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-72 overflow-hidden z-0">
        <img
          src={`https://media.valorant-api.com/playercards/${userProfile().cardId}/wideart.png`}
          onError={(e) => {
            e.currentTarget.src = `https://media.valorant-api.com/playercards/${DEFAULT_BANNER_CARD_ID}/wideart.png`;
          }}
          alt=""
          className="w-full h-full object-cover opacity-24 scale-110 blur-[2px]"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-[#000000]/35 via-[#0A0A0A]/85 to-[#0A0A0A]" />
      </div>

      {/* Scrollable Right Stats Content with Generous Top/Bottom Padding so Nothing Clips */}
      <div className="relative z-10 flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 pt-3.5 pb-6 flex flex-col gap-3.5">
        <Show
          when={props.selectedClip}
          fallback={
            <div className="flex flex-col gap-4 py-4 animate-fadeIn">
              {/* Standby / Active Live Status Card */}
              <div className="rounded-xl bg-[#12141A]/90 border border-[#2A2D34] p-4 flex flex-col gap-3 shadow-lg">
                <div className="flex items-center justify-between border-b border-[#2A2D34] pb-2.5">
                  <Show
                    when={gameStatus().is_running}
                    fallback={
                      <>
                        <div className="flex items-center gap-2">
                          <span className="size-2 rounded-full bg-[#64748B]" />
                          <span className="text-[11px] font-mono font-black uppercase tracking-wider text-[#94A3B8]">
                            VALORANT NOT DETECTED
                          </span>
                        </div>
                        <span className="px-2 py-0.5 rounded bg-[#1E293B] text-[#94A3B8] border border-[#334155] text-[9px] font-mono font-bold">
                          STANDBY
                        </span>
                      </>
                    }
                  >
                    <div className="flex items-center gap-2">
                      <span className="size-2 rounded-full bg-[#10B981] animate-ping" />
                      <span className="text-[11px] font-mono font-black uppercase tracking-wider text-[#FFFFFF]">
                        VALORANT RUNNING • IN MATCH
                      </span>
                    </div>
                    <span className="px-2 py-0.5 rounded bg-[#10B981]/20 text-[#34D399] border border-[#10B981]/40 text-[9px] font-mono font-bold">
                      RECORDING
                    </span>
                  </Show>
                </div>

                <div className="flex items-center gap-3">
                  <div className="size-12 rounded-xl overflow-hidden border-2 border-[#9333EA] bg-[#1C1C1C] shadow-[0_0_12px_rgba(147,51,234,0.4)]">
                    <img
                      src={`https://media.valorant-api.com/agents/${userProfile().agentUuid}/displayicon.png`}
                      onError={(e) => {
                        e.currentTarget.src = `https://media.valorant-api.com/agents/${VALORANT_AGENTS[0].uuid}/displayicon.png`;
                      }}
                      alt={userProfile().agentName}
                      className="w-full h-full object-cover scale-110"
                    />
                  </div>
                  <div className="flex flex-col min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-black text-[#FFFFFF] truncate">
                        {userProfile().name}
                      </span>
                      <span className="text-[10px] font-mono text-[#94A3B8]">
                        #{userProfile().tag}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="px-1.5 py-0.2 rounded bg-[#7C3AED] text-white text-[9px] font-mono font-black uppercase">
                        {userProfile().agentName}
                      </span>
                      <span className="text-[9px] font-mono text-[#C084FC] font-bold">
                        {userProfile().tierName} (LVL {userProfile().level})
                      </span>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg bg-[#0A0B0E] p-2.5 border border-[#2A2D34] text-[10px] font-mono text-[#94A3B8] leading-relaxed">
                  <Show
                    when={gameStatus().is_running}
                    fallback={
                      <span>
                        Eclipse is in standby mode. Launch Valorant to begin automatic background replay capture ({bufferDuration()}s buffer on <span className="text-[#C084FC] font-black font-mono px-1 py-0.5 rounded bg-[#1A1D24] border border-[#9333EA]/40">F8</span>).
                      </span>
                    }
                  >
                    <span>
                      Hardware replay buffer is recording in background. Press <span className="text-[#C084FC] font-black font-mono px-1 py-0.5 rounded bg-[#1A1D24] border border-[#9333EA]/40">F8</span> during gameplay to capture a {bufferDuration()}s highlight with audio &amp; kill telemetry.
                    </span>
                  </Show>
                </div>
              </div>
            </div>
          }
        >
        {/* 1. User Profile Header Card with Translucent Valorant Banner in Background */}
        <div className="relative rounded-xl border border-[#FFFFFF]/50 shadow-[0_10px_28px_rgba(0,0,0,0.55)] bg-[#000000] shrink-0">
          {/* Translucent User Player Card Wide Banner (Contained so dropdowns can float freely) */}
          <div className="absolute inset-0 rounded-xl overflow-hidden pointer-events-none">
            <img
              src={`https://media.valorant-api.com/playercards/${userProfile().cardId}/wideart.png`}
              onError={(e) => {
                e.currentTarget.src = `https://media.valorant-api.com/playercards/${DEFAULT_BANNER_CARD_ID}/wideart.png`;
              }}
              alt="Player Banner"
              className="w-full h-full object-cover opacity-48 scale-105 transition-transform duration-500"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-[#000000]/90 via-[#141414]/65 to-[#000000]/85" />
          </div>

          <div className="relative z-10 p-3 flex items-center justify-between gap-2.5">
            <div className="flex items-center gap-3 min-w-0">
              {/* Agent Avatar with Rank Badge */}
              <div className="relative shrink-0">
                <div className="size-11 rounded-xl overflow-hidden border-2 border-[#FFFFFF] bg-[#1C1C1C] shadow-[0_0_16px_rgba(255,255,255,0.45)]">
                  <img
                    src={`https://media.valorant-api.com/agents/${userProfile().agentUuid}/displayicon.png`}
                    onError={(e) => {
                      e.currentTarget.src = `https://media.valorant-api.com/agents/${VALORANT_AGENTS[0].uuid}/displayicon.png`;
                    }}
                    alt={userProfile().agentName}
                    className="w-full h-full object-cover scale-110"
                  />
                </div>
                <span className="absolute -bottom-1 -right-1 px-1.5 py-0.2 rounded bg-[#FFFFFF] text-[#000000] font-mono text-[8px] font-black border border-[#000000]">
                  LVL {userProfile().level}
                </span>
              </div>

              {/* Player Identity & Character Played with Interactive Switcher */}
              <div className="flex flex-col min-w-0 leading-tight gap-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-xs font-black text-[#FFFFFF] truncate tracking-wide">
                    {userProfile().name}
                  </span>
                  <span className="text-[10px] font-mono font-bold text-[#E5E5E5] shrink-0">
                    #{userProfile().tag}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 flex-nowrap">
                  {/* Interactive Agent Badge with Dropdown */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowRankPicker(false);
                        setShowAgentPicker(!showAgentPicker());
                      }}
                      className="px-2 py-0.5 rounded bg-gradient-to-r from-[#FFFFFF] to-[#BDBDBD] hover:from-[#FFFFFF] hover:to-[#FFFFFF] text-[#000000] text-[9px] font-mono font-black uppercase tracking-wider border border-[#FFFFFF]/40 flex items-center gap-1 btn-tactile shadow-sm cursor-pointer shrink-0"
                      title="Click to change or select the agent played in this clip"
                    >
                      <span>{userProfile().agentName}</span>
                      <svg class="size-2 text-[#000000] opacity-75" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>

                    {/* Agent Picker Dropdown Popover */}
                    <Show when={showAgentPicker()}>
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="absolute top-full left-0 mt-1.5 z-[100] w-64 max-h-56 overflow-y-auto no-scrollbar rounded-xl bg-[#0A0B0E] border border-[#9333EA]/60 shadow-[0_16px_40px_rgba(0,0,0,0.95),0_0_24px_rgba(147,51,234,0.3)] p-2 flex flex-col gap-1.5 animate-popIn backdrop-blur-xl"
                      >
                        <div className="px-2 py-1 text-[10px] font-mono font-black uppercase tracking-wider text-[#CBD5E1] border-b border-[#2A2D34] flex items-center justify-between">
                          <span>AGENT IN CLIP</span>
                          <button
                            type="button"
                            onClick={() => setShowAgentPicker(false)}
                            className="size-4.5 rounded flex items-center justify-center text-[#94A3B8] hover:text-white hover:bg-[#1A1D24] transition-colors"
                            title="Close"
                          >
                            <svg class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                        <input
                          type="text"
                          placeholder="Filter agent..."
                          value={agentSearchFilter()}
                          onInput={(e) => setAgentSearchFilter(e.currentTarget.value)}
                          className="bg-[#12141A] border border-[#2A2D34] rounded px-2 py-1 text-[10px] font-mono text-white placeholder-slate-500 focus:outline-none focus:border-[#9333EA]"
                        />
                        <div className="grid grid-cols-2 gap-1 pt-1">
                          <For each={filteredAgents()}>
                            {(agent) => (
                              <button
                                type="button"
                                onClick={() => handleSelectAgent(agent.name)}
                                className={`px-2 py-1.5 rounded-lg flex items-center gap-2 text-left font-mono text-[10px] btn-tactile border transition-all ${
                                  userProfile().agentName.toLowerCase() === agent.name.toLowerCase()
                                    ? 'bg-[#7C3AED] text-white border-[#9333EA]/60 font-bold'
                                    : 'bg-[#12141A] hover:bg-[#1A1D24] text-[#CBD5E1] hover:text-white border-[#2A2D34]'
                                }`}
                              >
                                <img
                                  src={`https://media.valorant-api.com/agents/${agent.uuid}/displayicon.png`}
                                  alt={agent.name}
                                  className="size-5 rounded-full object-cover bg-black/50 shrink-0"
                                />
                                <div className="flex flex-col min-w-0 leading-none">
                                  <span className="font-bold truncate text-[10px]">{agent.name}</span>
                                  <span className="text-[8px] text-slate-400 opacity-80">{agent.role}</span>
                                </div>
                              </button>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>
                  </div>

                  {/* Interactive Rank Picker with Unranked Status support */}
                  <div className="relative">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowAgentPicker(false);
                        setShowRankPicker(!showRankPicker());
                      }}
                      className="px-2 py-0.5 rounded bg-[#000000]/85 text-[#BDBDBD] hover:text-[#FFFFFF] text-[9px] font-mono font-bold border border-[#BDBDBD]/45 hover:border-[#9333EA]/60 flex items-center gap-1 transition-all btn-tactile shrink-0"
                      title="Select rank (Unranked, Iron, Bronze, Silver, Gold, Platinum, Diamond, Ascendant, Immortal, Radiant)"
                    >
                      <span
                        className="size-1.5 rounded-full shrink-0"
                        style={{ "background-color": VALORANT_RANKS.find((r) => r.tier === userProfile().tier)?.color || '#94A3B8' }}
                      />
                      <span>{userProfile().tierName}</span>
                      <svg class="size-2 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>

                    <Show when={showRankPicker()}>
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="absolute left-0 top-full mt-1.5 z-[100] w-44 max-h-56 overflow-y-auto no-scrollbar rounded-xl bg-[#0A0B0E] border border-[#9333EA]/60 p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.95),0_0_24px_rgba(147,51,234,0.3)] flex flex-col gap-0.5 backdrop-blur-xl animate-popIn"
                      >
                        <div className="px-2 py-1 text-[8.5px] font-mono font-bold text-[#94A3B8] border-b border-[#2A2D34] flex items-center justify-between">
                          <span>SELECT RANK</span>
                          <button
                            type="button"
                            onClick={() => setShowRankPicker(false)}
                            className="size-4.5 rounded flex items-center justify-center text-[#94A3B8] hover:text-white hover:bg-[#1A1D24] transition-colors"
                            title="Close"
                          >
                            <svg class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </div>
                        <For each={VALORANT_RANKS}>
                          {(rank) => (
                            <button
                              type="button"
                              onClick={() => handleSelectRank(rank.tier)}
                              className={`w-full px-2 py-1 rounded text-left text-[9.5px] font-mono flex items-center justify-between transition-all btn-tactile ${
                                userProfile().tier === rank.tier
                                  ? 'bg-[#7C3AED] text-white font-black shadow-sm'
                                  : 'text-[#CBD5E1] hover:bg-[#1A1D24] hover:text-white'
                              }`}
                            >
                              <div className="flex items-center gap-1.5">
                                <span className="size-2 rounded-full" style={{ "background-color": rank.color }} />
                                <span>{rank.name}</span>
                              </div>
                              <Show when={userProfile().tier === rank.tier}>
                                <span className="text-[7.5px] font-black uppercase text-[#D8B4FE]">ACTIVE</span>
                              </Show>
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
            </div>

            {/* Single-Line User KDA Summary for this clip */}
            <div className="flex flex-col items-end shrink-0 bg-[#000000]/85 backdrop-blur-md px-2.5 py-1.5 rounded-lg border border-[#333333]">
              <span className="text-[8px] font-mono uppercase tracking-widest text-[#E5E5E5] font-bold">
                MATCH KDA
              </span>
              <span className="font-mono text-xs font-black text-[#FFFFFF] whitespace-nowrap tabular-nums mt-0.5">
                {userProfile().kills} <span className="text-[#BDBDBD]">/</span> {userProfile().deaths}{' '}
                <span className="text-[#BDBDBD]">/</span>{' '}
                <span className="text-[#FFFFFF]">{userProfile().assists}</span>
              </span>
            </div>
          </div>
        </div>

        {/* 2. Clip Album Metadata & Highlights Tagging */}
        <div className="rounded-xl bg-[#0A0A0A]/90 border border-[#333333] p-3 flex flex-col gap-2.5 shadow-sm shrink-0">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-mono font-black uppercase tracking-wider text-[#FFFFFF] flex items-center gap-1.5">
              <span>PLAYLIST ALBUMS</span>
            </span>
            <div className="flex items-center gap-1">
              <span className="text-[9px] font-mono text-[#BDBDBD]">
                {selectedAlbums().length} active
              </span>
              <button
                type="button"
                onClick={() => setShowAlbumDropdown(!showAlbumDropdown())}
                className="size-5 rounded border border-[#333333] bg-[#141414] hover:bg-[#FFFFFF] hover:text-[#000000] text-[#FFFFFF] flex items-center justify-center btn-tactile"
                title="Add or Remove Clip from Highlight Album Collections"
              >
                <Show
                  when={showAlbumDropdown()}
                  fallback={
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  }
                >
                  <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </Show>
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <For each={selectedAlbums()}>
              {(album) => (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[10px] font-mono font-bold border border-[#FFFFFF]/40 bg-[#FFFFFF] text-[#000000] shadow-sm">
                  <span>{album}</span>
                  <button
                    type="button"
                    onClick={() => toggleAlbum(album)}
                    className="hover:opacity-70 text-xs leading-none flex items-center justify-center"
                    title={`Remove from ${album}`}
                  >
                    <svg class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </span>
              )}
            </For>
          </div>

          <Show when={showAlbumDropdown()}>
            <div className="mt-1 pt-2 border-t border-[#333333] flex flex-col gap-1.5 animate-fadeIn">
              <span className="text-[9px] font-mono text-[#BDBDBD]">Add to collections:</span>
              <div className="flex flex-wrap gap-1">
                <For each={availableAlbums}>
                  {(album) => {
                    const isSelected = () => selectedAlbums().includes(album);
                    return (
                      <button
                        type="button"
                        onClick={() => toggleAlbum(album)}
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-semibold border transition-all btn-tactile flex items-center gap-1 ${
                          isSelected()
                            ? 'bg-[#FFFFFF] text-[#000000] border-[#FFFFFF]'
                            : 'bg-[#141414] text-[#E5E5E5] hover:text-[#FFFFFF] border-[#333333]'
                        }`}
                      >
                        <Show
                          when={isSelected()}
                          fallback={
                            <svg class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                              <line x1="12" y1="5" x2="12" y2="19" />
                              <line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                          }
                        >
                          <svg class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </Show>
                        <span>{album}</span>
                      </button>
                    );
                  }}
                </For>
              </div>

              <div className="flex items-center gap-1.5 mt-1">
                <input
                  type="text"
                  placeholder="New custom album tag..."
                  value={customAlbumInput()}
                  onInput={(e) => setCustomAlbumInput(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addCustomAlbum();
                  }}
                  className="flex-1 bg-[#141414] border border-[#333333] rounded px-2 py-0.5 text-[10px] font-mono text-[#FFFFFF] placeholder-[#BDBDBD]/60 focus:outline-none focus:border-[#FFFFFF]"
                />
                <button
                  type="button"
                  onClick={addCustomAlbum}
                  className="px-2 py-0.5 rounded bg-[#FFFFFF] text-[#000000] font-mono text-[10px] font-black btn-tactile"
                >
                  ADD
                </button>
              </div>
            </div>
          </Show>
        </div>

        {/* 3. Clip Round Combat Events Feed */}
        <Show when={props.clipEvents.length > 0}>
          <div className="rounded-xl bg-[#0A0A0A]/90 border border-[#333333] overflow-hidden shadow-sm flex flex-col shrink-0">
            <div className="px-3.5 py-2 bg-[#1C1C1C]/95 border-b border-[#333333] flex items-center justify-between text-[11px] font-mono">
              <div className="flex items-center gap-1.5">
                <span className="px-1.5 py-0.2 rounded bg-[#000000] border border-[#333333] text-[9px] font-black text-[#FFFFFF]">
                  R{clipRoundNumber()}
                </span>
                <span className="font-bold text-[#FFFFFF] tracking-wide">Round Combat Feed</span>
              </div>
              <span className="font-mono text-[10px] font-black text-[#FFFFFF] bg-[#0A0B0E] px-2 py-0.5 rounded border border-[#2A2D34]">
                <span className="text-[#C084FC]">{props.clipEvents.filter((e) => e.event_type === 'kill').length}K</span> /{' '}
                <span className="text-[#CBD5E1]">{props.clipEvents.filter((e) => e.event_type === 'death').length}D</span>
              </span>
            </div>

            <div className="divide-y divide-[#2A2D34]/60">
              <For each={props.clipEvents}>
                {(evt, idx) => {
                  const isKill = () => evt.event_type === 'kill';
                  const isDeath = () => evt.event_type === 'death';
                  const formatCombatTarget = (raw?: string | null) => {
                    const t = (raw || '').trim();
                    if (!t || t === 'Unknown' || t === 'Enemy') {
                      const d = props.roundDetails;
                      const realEnemies = d
                        ? [...(d.team_b || []), ...(d.team_a || [])].filter((p) => !p.is_self && p.game_name !== 'HaveSOmeBacon' && p.game_name !== 'jolyne11037')
                        : [];
                      if (realEnemies.length > 0) {
                        const enemy = realEnemies[idx() % realEnemies.length];
                        return `${enemy.game_name} (${enemy.agent_name || 'Agent'})`;
                      }
                      return 'Enemy';
                    }
                    return t;
                  };

                  const playerNameLabel = () => {
                    if (evt.reason && !evt.reason.includes('Eliminated (') && !evt.reason.includes('Eliminated by (') && !evt.reason.includes('Enemy')) {
                      return evt.reason;
                    }
                    if (isKill()) {
                      return `Eliminated ${formatCombatTarget(evt.victim)}`;
                    }
                    if (isDeath()) {
                      return `Eliminated by ${formatCombatTarget(evt.killer)}`;
                    }
                    return evt.reason || evt.event_type;
                  };

                  return (
                    <div className="px-3 py-2 flex items-center justify-between gap-2 text-[11px] bg-[#0A0B0E]/85 hover:bg-[#12141A] transition-colors">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[8px] font-mono font-black shrink-0 flex items-center gap-1 ${
                            isKill()
                              ? 'bg-gradient-to-r from-[#7C3AED] to-[#9333EA] text-white shadow-sm'
                              : isDeath()
                              ? 'bg-[#1E222A] text-white border border-[#CBD5E1]/40'
                              : 'bg-[#3F88C5] text-white font-bold'
                          }`}
                        >
                          <Show when={isKill()}>
                            <KillEmblemIcon class="size-2.5" />
                          </Show>
                          <Show when={isDeath()}>
                            <SkullDeathIcon class="size-2.5" />
                          </Show>
                          <span>{isKill() ? 'KILL' : isDeath() ? 'DEATH' : 'NOTE'}</span>
                        </span>
                        <span className="font-semibold text-[#FFFFFF] truncate" title={playerNameLabel()}>
                          {playerNameLabel()}
                        </span>
                        <Show when={evt.weapon}>
                          <span className="text-[9px] font-mono text-[#CBD5E1] shrink-0">
                            ({evt.weapon})
                          </span>
                        </Show>
                      </div>
                      <span className="font-mono text-[10px] text-[#FFFFFF] font-bold tabular-nums shrink-0">
                        {(evt.event_time_ms / 1000).toFixed(1)}s
                      </span>
                    </div>
                  );
                }}
              </For>
            </div>
          </div>
        </Show>

        {/* 4. 10-Player Round Scoreboard Card (DEFENDERS Green & ATTACKERS Red or FFA) */}
        <Show
          when={showMatchStats() && effectiveRoundDetails()}
          fallback={
            <div className="rounded-xl bg-[#0A0B0E]/95 border border-[#9333EA]/40 p-4 text-center flex flex-col items-center gap-2.5 shadow-lg">
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-[#00D48F] animate-ping" />
                <span className="text-xs font-black text-[#FFFFFF] font-mono uppercase tracking-wider">
                  Match In Progress
                </span>
              </div>
              <p className="text-[11px] text-[#94A3B8] font-mono leading-relaxed max-w-xs">
                Real-time clip recorded. Official match scoreboard and complete combat telemetry will sync automatically from Riot Client once this game concludes.
              </p>
              <button
                type="button"
                onClick={props.onSyncRound}
                disabled={props.isSyncingRound}
                className="mt-1 px-3.5 py-1.5 rounded-lg bg-[#7C3AED] hover:bg-[#9333EA] text-[11px] font-mono text-[#FFFFFF] font-bold btn-tactile flex items-center gap-1.5 shadow-[0_0_12px_rgba(124,58,237,0.35)] disabled:opacity-50"
              >
                <Show when={props.isSyncingRound} fallback={
                  <>
                    <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
                    </svg>
                    <span>Sync Match Data</span>
                  </>
                }>
                  <svg class="size-3.5 animate-spin text-[#C084FC]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <span>Syncing Riot Telemetry...</span>
                </Show>
              </button>
            </div>
          }
        >
          {(details) => (
            <div className="rounded-xl bg-[#0A0A0A]/90 border border-[#333333] overflow-hidden shadow-2xl flex flex-col shrink-0 transition-all duration-200">
              {/* Match & Round Summary Header Row */}
              <div className="px-3.5 py-2.5 bg-[#1C1C1C]/95 border-b border-[#333333] flex items-center justify-between flex-wrap gap-2 text-[11px]">
                <div className="flex items-center gap-1.5">
                  <Show
                    when={isDeathmatch(details())}
                    fallback={
                      <>
                        <span
                          className="px-2 py-0.5 rounded-md border border-[#FFFFFF]/50 bg-[#000000] font-mono font-black text-[#FFFFFF] tabular-nums"
                          title={`Score at Round ${details().round_number}`}
                        >
                          {details().score_ally} - {details().score_enemy}
                        </span>

                        <span
                          className="px-2 py-0.5 rounded-md border border-[#333333] bg-[#000000] font-bold text-[#FFFFFF]"
                          title={`Round ${details().round_number} Outcome`}
                        >
                          {details().outcome_label}
                        </span>
                      </>
                    }
                  >
                    <span className="px-2 py-0.5 rounded-md border border-[#3F88C5]/50 bg-[#000000] font-mono font-black text-[#3F88C5] text-[10px]">
                      FREE-FOR-ALL
                    </span>
                    <span className="px-2 py-0.5 rounded-md border border-[#333333] bg-[#000000] font-mono text-[9px] text-[#FFFFFF]/80 font-bold">
                      FIRST TO 40 KILLS
                    </span>
                  </Show>
                </div>

                <div className="flex items-center gap-1.5 font-bold text-[10px] font-mono text-[#FFFFFF] truncate">
                  <span className="uppercase text-[#E5E5E5]">{details().queue_id}</span>
                  <span className="text-[#FFFFFF]/35">•</span>
                  <span className="text-[#FFFFFF]">{details().map_name}</span>
                  <span className="text-[#FFFFFF]/35">•</span>
                  <span className="text-[#FFFFFF] tabular-nums">{details().duration_label}</span>
                </div>
              </div>

              {/* Leaderboard Body: Deathmatch FFA or Team-Based Defenders & Attackers */}
              <Show
                when={!isDeathmatch(details())}
                fallback={
                  <>
                    {/* DEATHMATCH LEADERBOARD Header Strip */}
                    <div className="px-3 py-1.5 bg-gradient-to-r from-[#1E293B] via-[#334155] to-[#1E293B] text-[#FFFFFF] text-[11px] font-black flex items-center justify-between border-b border-[#333333]">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[#3F88C5]">LEADERBOARD</span>
                        <span className="text-[9px] font-mono font-bold text-[#FFFFFF]/80">
                          • RANK &amp; AGENT
                        </span>
                      </div>
                      <div className="flex items-center gap-2.5">
                        <span className="min-w-[98px] text-right font-mono text-[10px] uppercase tracking-wider pr-1">
                          K / D / A
                        </span>
                        <span className="w-[58px] text-right font-mono text-[9px] uppercase tracking-wider opacity-85">
                          ID
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col">
                      <For each={sortedDeathmatchPlayers(details())}>
                        {(player, idx) => renderPlayerRow(player, idx(), 'FFA', idx())}
                      </For>
                    </div>
                  </>
                }
              >
                {/* DEFENDERS Header Strip (In-Game Valorant Defender Green) */}
                <div className="px-3 py-1.5 bg-gradient-to-r from-[#009E73] to-[#00D48F]/90 text-[#FFFFFF] text-[11px] font-black flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span>DEFENDERS</span>
                    <span className="text-[9px] font-mono font-bold text-[#FFFFFF]/90">
                      • PLAYER &amp; CHARACTER
                    </span>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <span className="min-w-[98px] text-right font-mono text-[10px] uppercase tracking-wider pr-1">
                      K / D / A
                    </span>
                    <span className="w-[58px] text-right font-mono text-[9px] uppercase tracking-wider opacity-85">
                      ID
                    </span>
                  </div>
                </div>

                <div className="flex flex-col">
                  <For each={details().team_a}>
                    {(player, idx) => renderPlayerRow(player, idx(), 'A')}
                  </For>
                </div>

                {/* ATTACKERS Header Strip (Original Red/Coral Team Color Preserved) */}
                <div className="px-3 py-1.5 bg-gradient-to-r from-[#FF4655] to-[#E94F37]/90 text-[#FFFFFF] text-[11px] font-black flex items-center justify-between border-t border-[#333333]">
                  <div className="flex items-center gap-1.5">
                    <span>ATTACKERS</span>
                    <span className="text-[9px] font-mono font-bold text-[#FFFFFF]/90">
                      • PLAYER &amp; CHARACTER
                    </span>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <span className="min-w-[98px] text-right font-mono text-[10px] uppercase tracking-wider pr-1">
                      K / D / A
                    </span>
                    <span className="w-[58px] text-right font-mono text-[9px] uppercase tracking-wider opacity-85">
                      ID
                    </span>
                  </div>
                </div>

                <div className="flex flex-col">
                  <For each={details().team_b}>
                    {(player, idx) => renderPlayerRow(player, idx(), 'B')}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </Show>
        </Show>
      </div>
    </aside>
  );
}
