import { createSignal, onMount, onCleanup, Show, For } from 'solid-js';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { MatchEvent, ClipEntry, ClipRoundDetails } from '../types';
import { ClipsSidebar } from './reviewer/ClipsSidebar';
import { VideoPlayer } from './reviewer/VideoPlayer';
import { TimelineBar } from './reviewer/TimelineBar';
import { RightPanel } from './reviewer/RightPanel';
import { notifyClipTriggered } from './ClipOverlayNotification';
import { ShareModal } from './ShareModal';

export function TimelineReviewer(props?: { onOpenSettings?: () => void }) {
  const [clips, setClips] = createSignal<ClipEntry[]>([]);
  const [selectedClip, setSelectedClip] = createSignal<ClipEntry | null>(null);
  const [events, setEvents] = createSignal<MatchEvent[]>([]);
  const [roundDetails, setRoundDetails] = createSignal<ClipRoundDetails | null>(null);
  const [clipThumbnails, setClipThumbnails] = createSignal<string[]>([]);
  const [isShareModalOpen, setIsShareModalOpen] = createSignal<boolean>(false);
  const [clipToShare, setClipToShare] = createSignal<ClipEntry | null>(null);
  const [isSyncingRound, setIsSyncingRound] = createSignal<boolean>(false);
  const [videoDuration, setVideoDuration] = createSignal<number>(30);
  const [currentTime, setCurrentTime] = createSignal<number>(0);
  const [isPlaying, setIsPlaying] = createSignal<boolean>(false);
  const [isMuted, setIsMuted] = createSignal<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = createSignal<number>(1);
  const [isExporting, setIsExporting] = createSignal(false);
  const [isTrimming, setIsTrimming] = createSignal(false);
  const [isConvertingShort, setIsConvertingShort] = createSignal(false);
  const [isFlippedVertical, setIsFlippedVertical] = createSignal(false);
  const [isRepairingFlip, setIsRepairingFlip] = createSignal(false);
  const [isGameActive, setIsGameActive] = createSignal<boolean>(false);
  const [viewMode, setViewMode] = createSignal<'theater' | 'gallery'>('theater');

  // Responsive collapsible workspace panels so the window adapts cleanly at any size
  const [showLeftVault, setShowLeftVault] = createSignal<boolean>(true);
  const [showRightInspector, setShowRightInspector] = createSignal<boolean>(true);

  // Edit / Trim mode
  const [isEditMode, setIsEditMode] = createSignal<boolean>(false);
  const [trimStart, setTrimStart] = createSignal<number>(0);
  const [trimEnd, setTrimEnd] = createSignal<number>(30);
  const [clipTitleInput, setClipTitleInput] = createSignal<string>('');
  const [isTrimLooping, setIsTrimLooping] = createSignal<boolean>(false);

  // Montage multi-select
  const [selectedClipsForMontage, setSelectedClipsForMontage] = createSignal<string[]>([]);
  const [isCreatingMontage, setIsCreatingMontage] = createSignal(false);
  const [isMontageMode, setIsMontageMode] = createSignal(false);

  // Scrubber dragging
  const [isScrubbing, setIsScrubbing] = createSignal(false);

  // Toast notifications
  const [toastMessage, setToastMessage] = createSignal<{ text: string; type: 'error' | 'success' | 'info' } | null>(null);

  const showToast = (text: string, type: 'error' | 'success' | 'info' = 'info') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 3800);
  };

  let videoRef: HTMLVideoElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let scrubberTrackRef: HTMLDivElement | undefined;

  const fetchClipRoundDetails = async (filePath: string) => {
    try {
      const details = await invoke<ClipRoundDetails | null>('get_clip_round_details', {
        filePath,
      });
      setRoundDetails(details ?? null);
      return details;
    } catch {
      setRoundDetails(null);
      return null;
    }
  };

  const refreshClips = async () => {
    try {
      const list = await invoke<ClipEntry[]>('get_recorded_clips');
      const cur = selectedClip();
      if (cur && !list.some((c) => c.full_path === cur.full_path || c.file_name === cur.file_name)) {
        list.unshift(cur);
      }
      setClips(list);
      if (list.length > 0 && !selectedClip()) {
        loadClip(list[0]);
      }
    } catch (err) {
      console.error('Failed to load clips:', err);
    }
  };

  const syncClipEvents = async (filePath?: string) => {
    setIsSyncingRound(true);
    try {
      const report = await invoke<{ clips_synced: number }>('sync_clip_events', {
        filePath: filePath ?? null,
      });
      const cur = selectedClip();
      if (cur) {
        const evts = await invoke<MatchEvent[]>('get_clip_events', { filePath: cur.full_path });
        setEvents(evts);
        await fetchClipRoundDetails(cur.full_path);
      }
    } catch {
      // Riot Client may not be open yet
    } finally {
      setIsSyncingRound(false);
    }
  };

  let currentThumbReqPath = '';
  const loadThumbnailsAsync = (filePath: string, duration: number) => {
    currentThumbReqPath = filePath;
    invoke<string[]>('get_clip_thumbnails', {
      filePath,
      durationSecs: duration > 0 ? duration : 30,
    })
      .then((thumbs) => {
        if (currentThumbReqPath === filePath && thumbs && thumbs.length > 0) {
          setClipThumbnails(thumbs);
        }
      })
      .catch((err) => {
        console.warn('[Thumbnails] Async load skipped:', err);
      });
  };

  const loadClip = async (clip: ClipEntry) => {
    if (videoRef) {
      videoRef.pause();
    }
    setSelectedClip(clip);
    setCurrentTime(0);
    setIsPlaying(false);
    setClipThumbnails([]);
    if (videoRef) {
      videoRef.currentTime = 0;
      videoRef.playbackRate = playbackSpeed();
    }
    try {
      const [evts, rDetails] = await Promise.all([
        invoke<MatchEvent[]>('get_clip_events', { filePath: clip.full_path }),
        fetchClipRoundDetails(clip.full_path),
      ]);
      setEvents(evts);
      setRoundDetails(rDetails ?? null);
    } catch {
      setEvents([]);
      setRoundDetails(null);
    }

    loadThumbnailsAsync(clip.full_path, videoDuration());
  };

  const repairInvertedClip = async () => {
    const clip = selectedClip();
    if (!clip) return;
    setIsRepairingFlip(true);
    try {
      await invoke<string>('repair_inverted_clip', { filePath: clip.full_path });
      setIsFlippedVertical(false);
      showToast('Video file permanently repaired right-side up!', 'success');
      if (videoRef) {
        videoRef.load();
      }
      await refreshClips();
    } catch (err: any) {
      showToast(typeof err === 'string' ? err : 'Failed to repair video file', 'error');
    } finally {
      setIsRepairingFlip(false);
    }
  };

  const addCombatDot = async (type: 'kill' | 'death' | 'custom', customReason?: string) => {
    const sec = currentTime();
    const isKill = type === 'kill';
    const isDeath = type === 'death';
    const currentKills = events().filter((e) => e.event_type === 'kill').length;
    const currentDeaths = events().filter((e) => e.event_type === 'death').length;

    const isDM = roundDetails()?.queue_id?.toLowerCase().includes('deathmatch');
    const selfTeam = roundDetails()?.team_a?.some((p) => p.is_self) ? 'A' : 'B';
    const allPlayers = [...(roundDetails()?.team_a || []), ...(roundDetails()?.team_b || [])];
    const candidateEnemies = isDM
      ? allPlayers.filter((p) => !p.is_self)
      : selfTeam === 'A'
      ? (roundDetails()?.team_b || []).filter((p) => !p.is_self)
      : (roundDetails()?.team_a || []).filter((p) => !p.is_self);
    const targetEnemy = candidateEnemies.length > 0
      ? `${candidateEnemies[(currentKills + currentDeaths) % candidateEnemies.length].game_name} (${candidateEnemies[(currentKills + currentDeaths) % candidateEnemies.length].agent_name || 'Agent'})`
      : 'Enemy';

    const defaultReason = isKill
      ? (targetEnemy !== 'Enemy' ? `Eliminated ${targetEnemy}` : 'Eliminated Enemy')
      : isDeath
      ? (targetEnemy !== 'Enemy' ? `Eliminated by ${targetEnemy}` : 'Eliminated by Enemy')
      : 'Highlight Note';

    const newEvt: MatchEvent = {
      timestamp_pts: Math.round(sec * 60),
      event_time_ms: Math.round(sec * 1000),
      round: roundDetails()?.round_number || 1,
      event_type: type,
      weapon: isKill ? 'Vandal' : isDeath ? 'Vandal' : undefined,
      headshot: isKill && (customReason?.toLowerCase().includes('headshot') ?? true),
      victim: isKill ? (targetEnemy !== 'Enemy' ? targetEnemy : 'Enemy') : (roundDetails()?.user_name || 'Self'),
      killer: isKill ? (roundDetails()?.user_name || 'Self') : (targetEnemy !== 'Enemy' ? targetEnemy : 'Enemy'),
      site: undefined,
      kill_number: isKill ? currentKills + 1 : undefined,
      multi_kill_label: isKill ? `${currentKills + 1}K` : undefined,
      reason: customReason?.trim() && customReason !== 'Kill' && customReason !== 'Death' ? customReason.trim() : defaultReason,
    };
    const updated = [...events(), newEvt].sort((a, b) => a.event_time_ms - b.event_time_ms);
    setEvents(updated);
    if (selectedClip()) {
      try {
        await invoke('save_clip_events', { filePath: selectedClip()!.full_path, events: updated });
        showToast(`${newEvt.reason} @ ${sec.toFixed(1)}s`, 'success');
      } catch (err) {
        console.error('Failed to save events:', err);
      }
    }
  };

  const updateCombatDotReason = async (targetEvent: MatchEvent, newReason: string) => {
    const updated = events().map((e) => {
      if (e === targetEvent || e.event_time_ms === targetEvent.event_time_ms) {
        const isKill = e.event_type === 'kill';
        const clean = newReason.trim();
        const formattedReason = clean
          ? clean.startsWith('Eliminated ') || clean.startsWith('Eliminated by ')
            ? clean
            : isKill
            ? `Eliminated ${clean} (${e.weapon || 'Vandal'})`
            : `Eliminated by ${clean} (${e.weapon || 'Vandal'})`
          : null;
        return {
          ...e,
          reason: formattedReason,
          victim: isKill ? clean || e.victim : e.victim,
          killer: !isKill ? clean || e.killer : e.killer,
        };
      }
      return e;
    });
    setEvents(updated);
    if (selectedClip()) {
      try {
        await invoke('save_clip_events', { filePath: selectedClip()!.full_path, events: updated });
        showToast(newReason ? `Marker updated: "${newReason}"` : 'Marker label cleared', 'success');
      } catch (err) {
        console.error('Failed to update marker reason:', err);
      }
    }
  };

  const removeCombatDot = async (targetEvent: MatchEvent) => {
    const updated = events().filter((e) => e !== targetEvent && e.event_time_ms !== targetEvent.event_time_ms);
    setEvents(updated);
    if (selectedClip()) {
      try {
        await invoke('save_clip_events', { filePath: selectedClip()!.full_path, events: updated });
        showToast('Marker removed', 'info');
      } catch (err) {
        console.error('Failed to remove event:', err);
      }
    }
  };

  const toggleCombatDotType = async (targetEvent: MatchEvent) => {
    const isNowKill = targetEvent.event_type !== 'kill';
    const updated = events().map((e) => {
      if (e === targetEvent || e.event_time_ms === targetEvent.event_time_ms) {
        const oldVictim = e.victim;
        const oldKiller = e.killer;
        const newVictim = isNowKill
          ? oldKiller && oldKiller !== 'Self'
            ? oldKiller
            : 'Enemy'
          : roundDetails()?.user_name || 'Self';
        const newKiller = isNowKill
          ? roundDetails()?.user_name || 'Self'
          : oldVictim && oldVictim !== 'Self'
          ? oldVictim
          : 'Enemy';
        const target = isNowKill ? newVictim : newKiller;
        const weapon = e.weapon || 'Vandal';
        const updatedReason = isNowKill
          ? `Eliminated ${target} (${weapon})`
          : `Eliminated by ${target} (${weapon})`;

        return {
          ...e,
          event_type: (isNowKill ? 'kill' : 'death') as 'kill' | 'death',
          victim: newVictim,
          killer: newKiller,
          weapon,
          reason: updatedReason,
        };
      }
      return e;
    });
    setEvents(updated);
    if (selectedClip()) {
      try {
        await invoke('save_clip_events', { filePath: selectedClip()!.full_path, events: updated });
        showToast(isNowKill ? 'Switched to Kill Marker' : 'Switched to Death Marker', 'info');
      } catch (err) {
        console.error('Failed to toggle event type:', err);
      }
    }
  };

  const checkGameStatus = async () => {
    try {
      const status = await invoke<{ is_running: boolean }>('get_game_status');
      setIsGameActive(status.is_running);
    } catch {
      setIsGameActive(false);
    }
  };

  const copyPlayerId = async (riotId: string) => {
    try {
      await navigator.clipboard.writeText(riotId);
      showToast(`Copied Riot ID: ${riotId}`, 'success');
    } catch {
      showToast(`Riot ID: ${riotId}`, 'info');
    }
  };

  const triggerClip = async () => {
    setIsExporting(true);
    try {
      const savedPath = await invoke<string>('trigger_manual_clip');
      showToast('Highlight saved with game audio & combat markers!', 'success');
      if (savedPath) {
        const fileName = savedPath.split(/[\\/]/).pop() || 'Valorant_Clip.mp4';
        const newClip: ClipEntry = {
          file_name: fileName,
          full_path: savedPath,
          created_at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          file_size_mb: 18.0,
          has_timeline: true,
        };
        loadClip(newClip);
      }
      await refreshClips();
      setTimeout(refreshClips, 1000);
    } catch (err: any) {
      console.error('Failed to trigger clip:', err);
      const msg = typeof err === 'string' ? err : 'Clip buffer initializing, please try again in a moment.';
      showToast(msg, 'error');
    } finally {
      setIsExporting(false);
    }
  };

  const removeClip = async (e: MouseEvent, clip: ClipEntry) => {
    e.stopPropagation();
    try {
      await invoke('delete_clip', { filePath: clip.full_path });
      if (selectedClip()?.file_name === clip.file_name) {
        setSelectedClip(null);
      }
      await refreshClips();
      showToast('Clip removed', 'info');
    } catch (err) {
      console.error('Failed to delete clip:', err);
    }
  };

  const openFolder = async (e: MouseEvent, clip: ClipEntry) => {
    e.stopPropagation();
    try {
      await invoke('open_clip_folder', { filePath: clip.full_path });
    } catch (err) {
      console.error('Failed to open folder:', err);
    }
  };

  const shareClip = (eOrClip: MouseEvent | ClipEntry, maybeClip?: ClipEntry) => {
    if ('stopPropagation' in eOrClip) {
      eOrClip.stopPropagation();
    }
    const target = maybeClip || (eOrClip as ClipEntry);
    if (!target?.full_path) return;
    setClipToShare(target);
    setIsShareModalOpen(true);
  };

  const renameClip = async (clip: ClipEntry, newTitle: string) => {
    try {
      const updated = await invoke<ClipEntry>('rename_clip', {
        filePath: clip.full_path,
        newTitle,
      });
      if (selectedClip()?.full_path === clip.full_path) {
        setSelectedClip(updated);
      }
      await refreshClips();
      showToast(`Renamed clip to "${newTitle}"`, 'success');
    } catch (err: any) {
      console.error('Failed to rename clip:', err);
      showToast(typeof err === 'string' ? err : 'Rename failed', 'error');
    }
  };

  const togglePlay = () => {
    if (!videoRef) return;
    if (isPlaying()) {
      videoRef.pause();
      setIsPlaying(false);
    } else {
      videoRef.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
  };

  const toggleMute = () => {
    if (!videoRef) return;
    videoRef.muted = !videoRef.muted;
    setIsMuted(videoRef.muted);
  };

  const cycleSpeed = () => {
    const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
    const curr = playbackSpeed();
    const idx = speeds.indexOf(curr);
    const next = speeds[(idx + 1) % speeds.length];
    setSpeed(next);
  };

  const setSpeed = (speed: number) => {
    setPlaybackSpeed(speed);
    if (videoRef) {
      videoRef.playbackRate = speed;
    }
  };

  const toggleFullscreen = () => {
    if (!containerRef) return;
    if (!document.fullscreenElement) {
      containerRef.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  // Coalesced hardware-friendly video seek so sliding/scrubbing never stalls the decoder
  let pendingSeekTarget: number | null = null;
  let seekRafId: number | null = null;
  let wasPlayingBeforeScrub = false;

  const commitVideoSeek = () => {
    seekRafId = null;
    if (!videoRef || pendingSeekTarget === null) return;
    if (videoRef.seeking) {
      // Wait for current hardware decode frame to finish, then immediately flush latest target
      const onSeekDone = () => {
        videoRef?.removeEventListener('seeked', onSeekDone);
        if (pendingSeekTarget !== null && videoRef) {
          const nextTarget = pendingSeekTarget;
          pendingSeekTarget = null;
          videoRef.currentTime = nextTarget;
        }
      };
      videoRef.addEventListener('seeked', onSeekDone, { once: true });
      return;
    }
    const target = pendingSeekTarget;
    pendingSeekTarget = null;
    videoRef.currentTime = target;
  };

  const seekTo = (seconds: number) => {
    const clamped = Math.max(0, Math.min(safeDuration(), seconds));
    setCurrentTime(clamped);
    pendingSeekTarget = clamped;
    if (seekRafId === null) {
      seekRafId = requestAnimationFrame(commitVideoSeek);
    }
  };

  const seekToEvent = (seconds: number) => {
    const leadIn = Math.max(0, seconds - 1.2);
    if (videoRef) {
      pendingSeekTarget = null;
      videoRef.currentTime = leadIn;
    }
    setCurrentTime(leadIn);
    if (videoRef) {
      videoRef.play().then(() => setIsPlaying(true)).catch(() => {});
    }
  };

  const moveCombatDot = async (targetEvent: MatchEvent, newSec: number) => {
    const clampedSec = Math.max(0.1, Math.min(safeDuration() - 0.1, newSec));
    const newMs = Math.round(clampedSec * 1000);
    const updated = events()
      .map((e) => {
        if (e === targetEvent || e.event_time_ms === targetEvent.event_time_ms) {
          return {
            ...e,
            event_time_ms: newMs,
            timestamp_pts: Math.round(clampedSec * 60),
          };
        }
        return e;
      })
      .sort((a, b) => a.event_time_ms - b.event_time_ms);
    setEvents(updated);
    if (selectedClip()) {
      try {
        await invoke('save_clip_events', { filePath: selectedClip()!.full_path, events: updated });
      } catch (err) {
        console.error('Failed to save moved marker:', err);
      }
    }
  };

  const calibrateCombatTimestamps = async (detectedCombatSecs: number[]) => {
    if (!detectedCombatSecs.length) return;
    const curEvents = events();
    const dur = safeDuration();
    if (curEvents.length === 0 || dur < 3) return;

    // Check if existing markers are legacy uncalibrated fallback values (e.g., 1.2s / 1.6s at start of clip)
    const allEarly = curEvents.every((e) => e.event_time_ms <= 1850);
    if (!allEarly) return;

    const sortedDetections = [...detectedCombatSecs].sort((a, b) => a - b);
    const updated = curEvents.map((ev, idx) => {
      const targetSec =
        sortedDetections[Math.min(idx, sortedDetections.length - 1)] ??
        Math.max(1.0, dur - 2.2 + idx * 0.85);
      const ms = Math.round(targetSec * 1000);
      return {
        ...ev,
        event_time_ms: ms,
        timestamp_pts: Math.round(targetSec * 60),
      };
    });
    setEvents(updated);
    if (selectedClip()) {
      try {
        await invoke('save_clip_events', { filePath: selectedClip()!.full_path, events: updated });
      } catch {
        // Ignore
      }
    }
  };

  const safeDuration = () => {
    const d = videoDuration();
    return Number.isFinite(d) && d > 0 ? d : 30;
  };

  const combatEvents = () => {
    return events().filter(
      (e) => e.event_type === 'kill' || e.event_type === 'death' || e.event_type === 'custom' || Boolean(e.reason)
    );
  };

  const getNormalizedEventSec = (evt: MatchEvent) => {
    const dur = safeDuration();
    const rawSec =
      typeof evt.event_time_ms === 'number' && evt.event_time_ms > 0
        ? evt.event_time_ms / 1000
        : typeof evt.timestamp_pts === 'number'
        ? evt.timestamp_pts / 60
        : 0;
    return Math.max(0.1, Math.min(rawSec, Math.max(0.2, dur - 0.15)));
  };

  const getEventPercent = (evt: MatchEvent) => {
    const sec = getNormalizedEventSec(evt);
    const dur = safeDuration();
    return dur > 0 ? (sec / dur) * 100 : 0;
  };

  const getVictimAgent = (evt: MatchEvent) => evt.victim || 'Enemy';
  const getKillerAgent = (evt: MatchEvent) => evt.killer || 'Enemy';

  const multiKillBadge = () => {
    const kills = combatEvents().filter((e) => e.event_type === 'kill').length;
    if (kills >= 5) return { label: 'ACE (5K)', badgeClass: 'bg-[#FFFFFF] text-[#000000]' };
    if (kills === 4) return { label: 'QUADRA (4K)', badgeClass: 'bg-[#FFFFFF] text-[#000000]' };
    if (kills === 3) return { label: 'TRIPLE (3K)', badgeClass: 'bg-[#FFFFFF] text-[#000000]' };
    if (kills === 2) return { label: 'DOUBLE (2K)', badgeClass: 'bg-[#BDBDBD] text-[#000000]' };
    return null;
  };

  // Trimming & Exporting
  const setInAtPlayhead = () => {
    const curr = currentTime();
    setTrimStart(Math.min(curr, trimEnd() - 1));
  };

  const setOutAtPlayhead = () => {
    const curr = currentTime();
    setTrimEnd(Math.max(curr, trimStart() + 1));
  };

  const exportTrimmedClip = async () => {
    const clip = selectedClip();
    if (!clip) return;
    setIsTrimming(true);
    try {
      const newClip = await invoke<ClipEntry>('trim_clip', {
        filePath: clip.full_path,
        startSec: trimStart(),
        endSec: trimEnd(),
        title: clipTitleInput() || null,
      });
      showToast('Trimmed highlight exported successfully!', 'success');
      await refreshClips();
      loadClip(newClip);
      setIsEditMode(false);
      setClipTitleInput('');
    } catch (err: any) {
      console.error('Failed to trim clip:', err);
      showToast(typeof err === 'string' ? err : 'Trim export failed', 'error');
    } finally {
      setIsTrimming(false);
    }
  };

  const exportVerticalShort = async () => {
    const clip = selectedClip();
    if (!clip) return;
    setIsConvertingShort(true);
    try {
      const newClip = await invoke<ClipEntry>('export_vertical_short', {
        filePath: clip.full_path,
      });
      showToast('9:16 Shorts clip exported!', 'success');
      await refreshClips();
      loadClip(newClip);
    } catch (err: any) {
      console.error('Failed to convert to vertical:', err);
      showToast(typeof err === 'string' ? err : 'Vertical export failed', 'error');
    } finally {
      setIsConvertingShort(false);
    }
  };

  const toggleSelectForMontage = (path: string) => {
    const current = selectedClipsForMontage();
    if (current.includes(path)) {
      setSelectedClipsForMontage(current.filter((p) => p !== path));
    } else {
      setSelectedClipsForMontage([...current, path]);
    }
  };

  const createMontage = async () => {
    const paths = selectedClipsForMontage();
    if (paths.length < 2) {
      showToast('Select at least 2 clips to merge into a montage', 'info');
      return;
    }
    setIsCreatingMontage(true);
    try {
      const newClip = await invoke<ClipEntry>('create_montage', {
        clipPaths: paths,
        title: 'Highlight_Montage',
      });
      showToast('Highlight montage created successfully!', 'success');
      setSelectedClipsForMontage([]);
      setIsMontageMode(false);
      await refreshClips();
      loadClip(newClip);
    } catch (err: any) {
      console.error('Failed to create montage:', err);
      showToast(typeof err === 'string' ? err : 'Montage creation failed', 'error');
    } finally {
      setIsCreatingMontage(false);
    }
  };

  const handleScrubberMouseDown = (e: MouseEvent) => {
    if (!scrubberTrackRef) return;
    wasPlayingBeforeScrub = isPlaying();
    if (videoRef && wasPlayingBeforeScrub) {
      videoRef.pause();
    }
    setIsScrubbing(true);
    updateScrubberPosition(e);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      updateScrubberPosition(moveEvent);
    };

    const handleMouseUp = () => {
      setIsScrubbing(false);
      if (videoRef && wasPlayingBeforeScrub) {
        videoRef.play().then(() => setIsPlaying(true)).catch(() => {});
      }
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const updateScrubberPosition = (e: MouseEvent) => {
    if (!scrubberTrackRef) return;
    const rect = scrubberTrackRef.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(pos * safeDuration());
  };

  const handleTimeUpdate = () => {
    if (!videoRef || isScrubbing()) return;
    const curr = videoRef.currentTime;
    setCurrentTime(curr);

    if (isEditMode()) {
      if (isTrimLooping()) {
        if (curr >= trimEnd() || curr < trimStart()) {
          videoRef.currentTime = trimStart();
        }
      } else {
        if (curr >= trimEnd()) {
          videoRef.pause();
          setIsPlaying(false);
          videoRef.currentTime = trimEnd();
        }
      }
    } else {
      if (curr >= safeDuration()) {
        videoRef.pause();
        setIsPlaying(false);
        videoRef.currentTime = safeDuration();
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      seekTo(Math.max(0, currentTime() - 2));
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      seekTo(Math.min(safeDuration(), currentTime() + 2));
    } else if (e.key === '[') {
      e.preventDefault();
      setInAtPlayhead();
    } else if (e.key === ']') {
      e.preventDefault();
      setOutAtPlayhead();
    }
  };

  onMount(() => {
    refreshClips();
    checkGameStatus();
    const interval = setInterval(() => {
      refreshClips();
    }, 8000);
    // Defer initial match telemetry reconciliation by 5s so app startup is instant
    const initialSyncTimer = setTimeout(() => {
      syncClipEvents();
    }, 5000);
    window.addEventListener('keydown', handleKeyDown);
    onCleanup(() => {
      clearInterval(interval);
      clearTimeout(initialSyncTimer);
      window.removeEventListener('keydown', handleKeyDown);
    });
  });

  return (
    <div className="flex-1 h-full w-full flex overflow-hidden bg-transparent text-[#FFFFFF]">
      {/* Toast Notification Container */}
      <Show when={toastMessage()}>
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 animate-popIn pointer-events-none">
          <div
            className={`px-3.5 py-1.5 rounded-lg border shadow-2xl flex items-center gap-2 text-xs font-bold ${
              toastMessage()!.type === 'error'
                ? 'bg-[#FFFFFF] text-[#000000] border-[#FFFFFF]'
                : toastMessage()!.type === 'success'
                ? 'bg-[#BDBDBD] text-[#000000] border-[#FFFFFF]'
                : 'bg-[#141414] text-[#000000] border-[#333333]'
            }`}
          >
            <span>{toastMessage()!.text}</span>
          </div>
        </div>
      </Show>

      {/* 1. Left Highlights Vault Sidebar (Collapsible for smaller windows) */}
      <Show when={showLeftVault()}>
        <ClipsSidebar
          clips={clips()}
          selectedClip={selectedClip()}
          isGameActive={isGameActive()}
          isExporting={isExporting()}
          isMontageMode={isMontageMode()}
          selectedClipsForMontage={selectedClipsForMontage()}
          isCreatingMontage={isCreatingMontage()}
          onSelectClip={loadClip}
          onTriggerClip={triggerClip}
          onToggleMontageMode={() => setIsMontageMode(!isMontageMode())}
          onToggleSelectForMontage={toggleSelectForMontage}
          onCreateMontage={createMontage}
          onDeleteClip={removeClip}
          onOpenFolder={openFolder}
          onShareClip={(e, clip) => shareClip(e, clip)}
          onRenameClip={renameClip}
        />
      </Show>

      {/* 2. Central Video & Timeline Stage / Clip Gallery Grid */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-transparent overflow-hidden">
        {/* Compact Stage Subheader Bar with Panel Toggles & View Switcher */}
        <div className="h-9 bg-[#0A0B0E]/90 backdrop-blur-xl border-b border-[#2A2D34] px-3.5 flex items-center justify-between shrink-0 z-20 gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowLeftVault(!showLeftVault())}
              className={`px-2.5 py-1 rounded-md text-[10px] font-mono font-bold border btn-tactile flex items-center gap-1.5 ${
                showLeftVault()
                  ? 'bg-[#12141A] text-[#CBD5E1] hover:text-[#FFFFFF] border-[#2A2D34] hover:bg-[#1A1D24]'
                  : 'bg-[#7C3AED] text-[#FFFFFF] border-[#9333EA]/50 shadow-sm'
              }`}
              title="Toggle Vault Sidebar"
            >
              <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18" />
              </svg>
              <span>{showLeftVault() ? 'Hide Vault' : `Show Vault (${clips().length})`}</span>
            </button>

            <div className="flex items-center gap-1 bg-[#12141A] p-0.5 rounded-md border border-[#2A2D34]">
              <button
                type="button"
                onClick={() => setViewMode('theater')}
                className={`px-2.5 py-0.5 text-[10px] font-mono font-bold rounded flex items-center gap-1 transition-all btn-tactile ${
                  viewMode() === 'theater'
                    ? 'bg-[#7C3AED] text-[#FFFFFF] shadow-sm border border-[#9333EA]/50'
                    : 'text-[#CBD5E1] hover:text-[#FFFFFF] hover:bg-[#1A1D24]'
                }`}
              >
                <span>Theater Player</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('gallery')}
                className={`px-2.5 py-0.5 text-[10px] font-mono font-bold rounded flex items-center gap-1 transition-all btn-tactile ${
                  viewMode() === 'gallery'
                    ? 'bg-[#7C3AED] text-[#FFFFFF] shadow-sm border border-[#9333EA]/50'
                    : 'text-[#CBD5E1] hover:text-[#FFFFFF] hover:bg-[#1A1D24]'
                }`}
              >
                <span>Gallery Grid ({clips().length})</span>
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Direct Visible Settings Shortcut */}
            <button
              type="button"
              onClick={() => props?.onOpenSettings?.()}
              className="px-2.5 py-1 rounded-md text-[10px] font-mono font-bold bg-[#12141A] hover:bg-[#1A1D24] text-[#CBD5E1] hover:text-[#FFFFFF] border border-[#2A2D34] hover:border-[#9333EA]/50 btn-tactile flex items-center gap-1.5 transition-all shadow-sm"
              title="Open Settings & Clipper Engine Controls"
            >
              <svg class="size-3 text-[#C084FC]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l.06-.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>Settings</span>
            </button>

            {/* Direct Share Footage Button */}
            <Show when={selectedClip()}>
              <button
                type="button"
                onClick={() => shareClip(selectedClip()!)}
                className="px-2.5 py-1 rounded-md text-[10px] font-mono font-bold bg-[#7C3AED] hover:bg-[#9333EA] text-white border border-[#9333EA]/60 btn-tactile flex items-center gap-1.5 shadow-sm transition-all"
                title="Share clip: Web link with permission controls, Discord paste, or embed"
              >
                <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                  <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
                  <polyline points="16 6 12 2 8 6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
                <span>Share</span>
              </button>
            </Show>

            <button
              type="button"
              onClick={() => setShowRightInspector(!showRightInspector())}
              className={`px-2.5 py-1 rounded-md text-[10px] font-mono font-bold border btn-tactile flex items-center gap-1.5 ${
                showRightInspector()
                  ? 'bg-[#12141A] text-[#CBD5E1] hover:text-[#FFFFFF] border-[#2A2D34] hover:bg-[#1A1D24]'
                  : 'bg-[#7C3AED] text-[#FFFFFF] border-[#9333EA]/50 shadow-sm'
              }`}
              title="Toggle Round Telemetry Panel"
            >
              <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M15 3v18" />
              </svg>
              <span>{showRightInspector() ? 'Hide Round Stats' : 'Show Round Stats'}</span>
            </button>
          </div>
        </div>

        <Show
          when={viewMode() === 'theater'}
          fallback={
            /* Responsive CSS Grid Gallery View */
            <div className="flex-1 overflow-y-auto p-6 bg-[#000000]/90 scrollbar-thin">
              <div className="flex items-center justify-between mb-5 border-b border-[#333333] pb-3">
                <div>
                  <h2 className="text-xs font-black font-mono uppercase tracking-wider text-[#FFFFFF]">
                    Local Clip Repository
                  </h2>
                  <p className="text-[11px] text-[#BDBDBD] font-mono mt-0.5">
                    Hardware-accelerated replay buffer captures ({clips().length} available on disk)
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
                <For each={clips()}>
                  {(clip) => {
                    const isCur = selectedClip()?.file_name === clip.file_name;
                    return (
                      <div
                        onClick={() => {
                          loadClip(clip);
                          setViewMode('theater');
                        }}
                        className={`group relative rounded-xl border bg-[#141414] hover:bg-[#1C1C1C] transition-all duration-150 overflow-hidden cursor-pointer flex flex-col shadow-lg ${
                          isCur ? 'border-[#FFFFFF] ring-1 ring-[#FFFFFF]' : 'border-[#333333] hover:border-[#BDBDBD]'
                        }`}
                      >
                        <div className="relative aspect-video bg-[#000000] overflow-hidden flex items-center justify-center">
                          <video
                            src={convertFileSrc(clip.full_path)}
                            preload="metadata"
                            muted
                            playsinline
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                            onMouseEnter={(e) => {
                              e.currentTarget.play().catch(() => {});
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.pause();
                              e.currentTarget.currentTime = 0;
                            }}
                          />

                          <div className="absolute top-2 left-2 flex items-center gap-1 pointer-events-none">
                            <span className="px-2 py-0.5 rounded bg-gradient-to-r from-[#FFFFFF] to-[#BDBDBD] text-[#000000] font-mono text-[9px] font-black">
                              30S
                            </span>
                          </div>
                          <div className="absolute bottom-2 right-2 flex items-center gap-1 pointer-events-none">
                            <span className="px-2 py-0.5 rounded bg-[#000000]/90 text-[#FFFFFF] font-mono text-[9px] font-bold">
                              {Number.isFinite(clip.file_size_mb) ? `${clip.file_size_mb.toFixed(1)} MB` : '--'}
                            </span>
                          </div>
                        </div>

                        <div className="p-3.5 flex flex-col gap-1.5">
                          <span className="text-xs font-bold text-[#FFFFFF] font-mono truncate">
                            {clip.file_name.replace(/\.[^/.]+$/, '')}
                          </span>
                          <div className="flex items-center justify-between text-[10px] font-mono text-[#BDBDBD]">
                            <span>{clip.created_at}</span>
                            <span className="text-[#E5E5E5] font-bold group-hover:underline">Open in Studio &rarr;</span>
                          </div>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
          }
        >
          <VideoPlayer
            selectedClip={selectedClip()}
            videoRef={videoRef}
            setVideoRef={(el) => (videoRef = el)}
            containerRef={containerRef}
            setContainerRef={(el) => (containerRef = el)}
            isPlaying={isPlaying()}
            isMuted={isMuted()}
            isFlippedVertical={isFlippedVertical()}
            isRepairingFlip={isRepairingFlip()}
            isEditMode={isEditMode()}
            isConvertingShort={isConvertingShort()}
            multiKillBadge={multiKillBadge()}
            onTogglePlay={togglePlay}
            onToggleEditMode={() => {
              const next = !isEditMode();
              setIsEditMode(next);
              if (next) {
                setTrimStart(0);
                setTrimEnd(safeDuration());
              }
            }}
            onToggleFlipVertical={() => setIsFlippedVertical(!isFlippedVertical())}
            onRepairInvertedClip={repairInvertedClip}
            onExportVerticalShort={exportVerticalShort}
            onShareClip={(clip) => shareClip(clip)}
            onRenameClip={renameClip}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={() => {
              if (videoRef) {
                const dur = Number.isFinite(videoRef.duration) && videoRef.duration > 0 ? videoRef.duration : 30;
                setVideoDuration(dur);
                setTrimEnd(dur);

                // Automatically repair legacy compressed fallback timestamps (1.2s / 1.6s) to match actual clip duration
                const curEvts = events();
                if (
                  curEvts.length === 2 &&
                  curEvts[0].event_time_ms <= 1350 &&
                  curEvts[1].event_time_ms <= 1750 &&
                  dur >= 6.0
                ) {
                  const t1 = Math.max(1.0, dur - 2.3);
                  const t2 = Math.max(1.5, dur - 1.4);
                  const fixed = [
                    { ...curEvts[0], event_time_ms: Math.round(t1 * 1000), timestamp_pts: Math.round(t1 * 60) },
                    { ...curEvts[1], event_time_ms: Math.round(t2 * 1000), timestamp_pts: Math.round(t2 * 60) },
                  ];
                  setEvents(fixed);
                  if (selectedClip()) {
                    invoke('save_clip_events', { filePath: selectedClip()!.full_path, events: fixed }).catch(() => {});
                  }
                }

                if (selectedClip() && clipThumbnails().length === 0) {
                  loadThumbnailsAsync(selectedClip()!.full_path, dur);
                }
              }
            }}
            onEnded={() => {
              setIsPlaying(false);
              if (videoRef) {
                videoRef.currentTime = isEditMode() ? trimStart() : 0;
                setCurrentTime(videoRef.currentTime);
              }
            }}
          />

          <TimelineBar
            selectedClipPath={selectedClip()?.full_path ?? null}
            currentTime={currentTime()}
            safeDuration={safeDuration()}
            isPlaying={isPlaying()}
            isMuted={isMuted()}
            isScrubbing={isScrubbing()}
            playbackSpeed={playbackSpeed()}
            isEditMode={isEditMode()}
            trimStart={trimStart()}
            trimEnd={trimEnd()}
            isTrimLooping={isTrimLooping()}
            isTrimming={isTrimming()}
            clipTitleInput={clipTitleInput()}
            combatEvents={combatEvents()}
            thumbnails={clipThumbnails()}
            scrubberTrackRef={scrubberTrackRef}
            setScrubberTrackRef={(el) => (scrubberTrackRef = el)}
            onTogglePlay={togglePlay}
            onCycleSpeed={cycleSpeed}
            onSetSpeed={setSpeed}
            onToggleMute={toggleMute}
            onToggleFullscreen={toggleFullscreen}
            onScrubberMouseDown={handleScrubberMouseDown}
            onSeekTo={seekTo}
            onSeekToEvent={seekToEvent}
            onSetInAtPlayhead={setInAtPlayhead}
            onSetOutAtPlayhead={setOutAtPlayhead}
            onSetTrimRange={(start, end) => {
              setTrimStart(Math.max(0, start));
              setTrimEnd(Math.min(safeDuration(), end));
            }}
            onToggleTrimLooping={() => setIsTrimLooping(!isTrimLooping())}
            onExportTrimmedClip={exportTrimmedClip}
            onSetClipTitleInput={setClipTitleInput}
            onAddCombatDot={addCombatDot}
            onRemoveCombatDot={removeCombatDot}
            onToggleCombatDotType={toggleCombatDotType}
            onUpdateCombatDotReason={updateCombatDotReason}
            onMoveCombatDot={moveCombatDot}
            onCalibrateCombatTimestamps={calibrateCombatTimestamps}
            getNormalizedEventSec={getNormalizedEventSec}
            getEventPercent={getEventPercent}
            getVictimAgent={getVictimAgent}
            getKillerAgent={getKillerAgent}
          />
        </Show>
      </div>

      {/* 3. Right Clip-Specific Game & Round Telemetry Panel */}
      <Show when={showRightInspector()}>
        <RightPanel
          selectedClip={selectedClip()}
          roundDetails={roundDetails()}
          clipEvents={events()}
          isSyncingRound={isSyncingRound()}
          onOpenFolder={openFolder}
          onSyncRound={() => syncClipEvents(selectedClip()?.full_path)}
          onRenameClip={renameClip}
          onCopyPlayerId={copyPlayerId}
        />
      </Show>

      {/* Share Modal (3 Options: Playable Web Link, Discord File Copy, HTML Embed) */}
      <ShareModal
        clip={clipToShare() || selectedClip()}
        isOpen={isShareModalOpen()}
        onClose={() => setIsShareModalOpen(false)}
        onToast={showToast}
      />
    </div>
  );
}
