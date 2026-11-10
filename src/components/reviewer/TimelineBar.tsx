import { Show, For, createSignal, createEffect, onMount, onCleanup } from 'solid-js';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { MatchEvent } from '../../types';

interface TimelineBarProps {
  selectedClipPath: string | null;
  currentTime: number;
  safeDuration: number;
  isPlaying: boolean;
  isMuted: boolean;
  isScrubbing: boolean;
  playbackSpeed: number;
  isEditMode: boolean;
  trimStart: number;
  trimEnd: number;
  isTrimLooping: boolean;
  isTrimming: boolean;
  clipTitleInput: string;
  combatEvents: MatchEvent[];
  thumbnails?: string[];
  scrubberTrackRef: HTMLDivElement | undefined;
  setScrubberTrackRef: (el: HTMLDivElement) => void;
  onTogglePlay: () => void;
  onCycleSpeed: () => void;
  onSetSpeed: (speed: number) => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
  onScrubberMouseDown: (e: MouseEvent) => void;
  onSeekTo: (seconds: number) => void;
  onSeekToEvent: (seconds: number) => void;
  onSetInAtPlayhead: () => void;
  onSetOutAtPlayhead: () => void;
  onSetTrimRange?: (start: number, end: number) => void;
  onToggleTrimLooping: () => void;
  onExportTrimmedClip: () => void;
  onSetClipTitleInput: (val: string) => void;
  onAddCombatDot: (type: 'kill' | 'death' | 'custom', reason?: string) => void;
  onRemoveCombatDot: (event: MatchEvent) => void;
  onToggleCombatDotType: (event: MatchEvent) => void;
  onUpdateCombatDotReason: (event: MatchEvent, reason: string) => void;
  onMoveCombatDot: (event: MatchEvent, newSec: number) => void;
  onCalibrateCombatTimestamps: (detectedCombatSecs: number[]) => void;
  getNormalizedEventSec: (evt: MatchEvent) => number;
  getEventPercent: (evt: MatchEvent) => number;
  getVictimAgent: (evt: MatchEvent) => string;
  getKillerAgent: (evt: MatchEvent) => string;
}



const SPEED_OPTIONS: { value: number; label: string; badge: string }[] = [
  { value: 0.25, label: '0.25x Slow-Mo', badge: '0.25x' },
  { value: 0.5, label: '0.5x Half Speed', badge: '0.5x' },
  { value: 0.75, label: '0.75x Tactical', badge: '0.75x' },
  { value: 1, label: 'Normal (1x)', badge: 'Normal' },
  { value: 1.25, label: '1.25x Fast', badge: '1.25x' },
  { value: 1.5, label: '1.5x Rapid', badge: '1.5x' },
  { value: 2, label: '2x Double', badge: '2x' },
];

const PRESET_REASONS = [
  { label: 'Headshot', type: 'kill' as const },
  { label: 'Clutch', type: 'custom' as const },
  { label: 'Flick', type: 'kill' as const },
  { label: 'Wallbang', type: 'kill' as const },
  { label: 'Whiff / Death', type: 'death' as const },
  { label: 'Spike Play', type: 'custom' as const },
];

/** Tactical Valorant Headshot/Crossed-Blades Kill Emblem SVG */
export function KillEmblemIcon(props: { class?: string }) {
  return (
    <svg
      class={props.class || 'size-3'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polygon points="12 2 15.2 8.8 22 12 15.2 15.2 12 22 8.8 15.2 2 12 8.8 8.8 12 2" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" />
    </svg>
  );
}

/** Crisp Skull SVG Icon for Death Markers */
export function SkullDeathIcon(props: { class?: string }) {
  return (
    <svg
      class={props.class || 'size-3'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M12 3a8 8 0 0 0-8 8c0 2.9 1.5 5.4 3.8 6.8L8 21h8l.2-3.2C18.5 16.4 20 13.9 20 11a8 8 0 0 0-8-8z" />
      <circle cx="9" cy="11.5" r="1.5" fill="currentColor" />
      <circle cx="15" cy="11.5" r="1.5" fill="currentColor" />
      <path d="M10.5 17v3M13.5 17v3" />
    </svg>
  );
}

function formatMarkerTargetLabel(raw: string): string {
  const cleaned = (raw || '').trim();
  if (!cleaned || cleaned === 'Unknown' || cleaned === 'Enemy') return 'Enemy';
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    return cleaned.slice(1, -1).trim() || 'Enemy';
  }
  const parenIdx = cleaned.indexOf('(');
  if (parenIdx > 0) {
    const player = cleaned.slice(0, parenIdx).trim();
    const agent = cleaned
      .slice(parenIdx + 1)
      .replace(')', '')
      .trim();
    return agent ? `${player} (${agent})` : player;
  }
  return cleaned;
}

export function TimelineBar(props: TimelineBarProps) {
  const [hoverSec, setHoverSec] = createSignal<number | null>(null);
  const [hoverPercent, setHoverPercent] = createSignal<number | null>(null);
  const [showPinComposer, setShowPinComposer] = createSignal(false);
  const [showSpeedMenu, setShowSpeedMenu] = createSignal(false);
  const [customReasonText, setCustomReasonText] = createSignal('');
  const [composerType, setComposerType] = createSignal<'kill' | 'death' | 'custom'>('kill');
  const [editingMarkerId, setEditingMarkerId] = createSignal<string | null>(null);
  const [pinnedMarkerId, setPinnedMarkerId] = createSignal<string | null>(null);
  const [hoveredMarkerId, setHoveredMarkerId] = createSignal<string | null>(null);
  let markerHoverTimeout: any = null;
  const [markerReasonDraft, setMarkerReasonDraft] = createSignal('');
  const [bufferDuration, setBufferDuration] = createSignal(30);

  onMount(async () => {
    try {
      const cfg = await invoke<{ buffer_length_seconds: number }>('get_config');
      if (cfg && cfg.buffer_length_seconds) {
        setBufferDuration(cfg.buffer_length_seconds);
      }
    } catch {}
  });

  // Auto-dismiss pinned marker telemetry popover when clicking anywhere outside
  createEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('.group\\/marker')) {
        setPinnedMarkerId(null);
        setHoveredMarkerId(null);
        setEditingMarkerId(null);
      }
    };
    window.addEventListener('click', handleOutsideClick);
    onCleanup(() => window.removeEventListener('click', handleOutsideClick));
  });

  const isAnyScrubbing = () => props.isScrubbing;
  const previewThumbForSec = (sec: number): string | null => {
    if (!props.thumbnails || props.thumbnails.length === 0 || props.safeDuration <= 0) return null;
    const ratio = Math.max(0, Math.min(0.999, sec / props.safeDuration));
    const idx = Math.floor(ratio * props.thumbnails.length);
    return props.thumbnails[idx] || null;
  };

  // Deduplicate and uniquely identify timeline markers so cards never duplicate or clutter
  const staggeredMarkers = () => {
    const sorted = [...props.combatEvents].sort((a, b) => {
      const aSec = props.getNormalizedEventSec(a);
      const bSec = props.getNormalizedEventSec(b);
      return aSec - bSec;
    });

    const unique: MatchEvent[] = [];
    for (const evt of sorted) {
      const sec = props.getNormalizedEventSec(evt);
      const isDup = unique.some(
        (u) =>
          Math.abs(props.getNormalizedEventSec(u) - sec) < 0.08 &&
          u.event_type === evt.event_type &&
          (u.reason || '') === (evt.reason || '')
      );
      if (!isDup) unique.push(evt);
    }

    return unique.map((evt, idx) => {
      const uid = `marker_${evt.event_time_ms || 0}_${evt.timestamp_pts || 0}_${idx}`;
      return { evt, uid };
    });
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const formatTimeMs = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    const ms = Math.floor((secs % 1) * 10);
    return `${m}:${s < 10 ? '0' : ''}${s}.${ms}`;
  };

  const formatExactSec = (sec: number) => `${sec.toFixed(1)}s`;

  const handleMouseMove = (e: MouseEvent) => {
    if (!props.scrubberTrackRef) return;
    const rect = props.scrubberTrackRef.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverPercent(pos * 100);
    setHoverSec(pos * props.safeDuration);
  };

  const handleMouseLeave = () => {
    setHoverSec(null);
    setHoverPercent(null);
  };


  // Drag individual marker along the timeline to fine-tune exact kill/death timestamp
  const handleMarkerMouseDown = (e: MouseEvent, evt: MatchEvent, eventSec: number) => {
    e.stopPropagation();
    const startX = e.clientX;
    let moved = false;

    const onMove = (moveEv: MouseEvent) => {
      if (Math.abs(moveEv.clientX - startX) > 4) {
        moved = true;
      }
      if (moved && props.scrubberTrackRef) {
        const rect = props.scrubberTrackRef.getBoundingClientRect();
        const ratio = Math.max(0.01, Math.min(0.99, (moveEv.clientX - rect.left) / rect.width));
        const newSec = ratio * props.safeDuration;
        props.onSeekTo(newSec);
        props.onMoveCombatDot(evt, newSec);
      }
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (!moved) {
        props.onSeekToEvent(eventSec);
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleTrimDrag = (e: MouseEvent, type: 'start' | 'end') => {
    e.stopPropagation();
    e.preventDefault();
    const track = props.scrubberTrackRef;
    if (!track) return;

    const onMove = (moveEv: MouseEvent) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (moveEv.clientX - rect.left) / rect.width));
      const sec = ratio * props.safeDuration;
      if (type === 'start') {
        const next = Math.max(0, Math.min(sec, props.trimEnd - 0.5));
        if (props.onSetTrimRange) {
          props.onSetTrimRange(next, props.trimEnd);
        }
        props.onSeekTo(next);
      } else {
        const next = Math.min(props.safeDuration, Math.max(sec, props.trimStart + 0.5));
        if (props.onSetTrimRange) {
          props.onSetTrimRange(props.trimStart, next);
        }
        props.onSeekTo(next);
      }
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Smooth wheel scrubbing across timeline & frame strip
  const handleTimelineWheel = (e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    const step = delta > 0 ? 0.25 : -0.25;
    const nextSec = Math.max(0, Math.min(props.safeDuration, props.currentTime + step));
    props.onSeekTo(nextSec);
  };

  const submitCustomPin = () => {
    const reason =
      customReasonText().trim() ||
      (composerType() === 'kill'
        ? 'Kill'
        : composerType() === 'death'
        ? 'Death'
        : 'Tactical Note');
    props.onAddCombatDot(composerType(), reason);
    setCustomReasonText('');
    setShowPinComposer(false);
  };

  return (
    <div
      onWheel={handleTimelineWheel}
      className="bg-[#0A0B0E] border-t border-[#2A2D34] px-3.5 pt-8 pb-3 flex flex-col gap-3 shrink-0 select-none relative w-full z-40 overflow-visible"
    >
      <Show
        when={props.selectedClipPath}
        fallback={
          <div className="h-28 w-full flex flex-col items-center justify-center gap-2 text-center text-[#CBD5E1] py-4 select-none">
            <div className="flex items-center gap-2.5">
              <span className="size-2 rounded-full bg-[#9333EA] animate-ping" />
              <span className="size-2.5 rounded-full bg-[#7C3AED]" />
              <span className="text-xs font-black font-mono tracking-widest text-[#FFFFFF] uppercase">
                HARDWARE BUFFER ACTIVE • READY FOR CLIPS
              </span>
            </div>
            <div className="text-[11px] font-mono text-[#94A3B8]">
              Press <span className="px-2 py-0.5 rounded bg-[#12141A] text-[#C084FC] border border-[#9333EA]/40 font-black">F8</span> in Valorant to capture instant {bufferDuration()}-second replay highlight with audio &amp; kill telemetry
            </div>
          </div>
        }
      >
        {/* Custom Marker Composer Popover */}
        <Show when={showPinComposer()}>
        <div
          role="dialog"
          aria-label="Add timeline marker with reason"
          className="absolute bottom-full mb-2 left-4 z-50 w-96 rounded-xl bg-[#0A0A0A] border border-[#FFFFFF] p-3.5 shadow-[0_18px_45px_rgba(0,0,0,0.85)] animate-popIn flex flex-col gap-2.5"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-black font-mono uppercase tracking-wider text-[#FFFFFF]">
              ADD MARKER @ {formatTimeMs(props.currentTime)}
            </span>
            <button
              type="button"
              aria-label="Close marker composer"
              onClick={() => setShowPinComposer(false)}
              className="size-5 rounded flex items-center justify-center text-[#FFFFFF]/60 hover:text-[#FFFFFF] hover:bg-[#1C1C1C] transition-colors"
            >
              <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <div className="flex items-center gap-1.5 text-[11px] font-mono font-bold">
            <button
              type="button"
              onClick={() => setComposerType('kill')}
              className={`flex-1 py-1.5 rounded-lg border btn-tactile flex items-center justify-center gap-1 ${
                composerType() === 'kill'
                  ? 'bg-[#FFFFFF] text-[#000000] border-[#FFFFFF]'
                  : 'bg-[#1C1C1C] text-[#000000]/70 border-[#333333]'
              }`}
            >
              <KillEmblemIcon class="size-3" />
              <span>Kill</span>
            </button>
            <button
              type="button"
              onClick={() => setComposerType('death')}
              className={`flex-1 py-1.5 rounded-lg border btn-tactile flex items-center justify-center gap-1 ${
                composerType() === 'death'
                  ? 'bg-[#BDBDBD] text-[#000000] border-[#FFFFFF] font-black'
                  : 'bg-[#1C1C1C] text-[#000000]/70 border-[#333333]'
              }`}
            >
              <SkullDeathIcon class="size-3" />
              <span>Death</span>
            </button>
            <button
              type="button"
              onClick={() => setComposerType('custom')}
              className={`flex-1 py-1.5 rounded-lg border btn-tactile ${
                composerType() === 'custom'
                  ? 'bg-[#FFFFFF] text-[#000000] border-[#FFFFFF] font-black'
                  : 'bg-[#1C1C1C] text-[#000000]/70 border-[#333333]'
              }`}
            >
              Reason Note
            </button>
          </div>

          <div className="flex flex-wrap gap-1">
            <For each={PRESET_REASONS}>
              {(preset) => (
                <button
                  type="button"
                  onClick={() => {
                    props.onAddCombatDot(preset.type, preset.label);
                    setShowPinComposer(false);
                  }}
                  className="px-2 py-0.5 rounded bg-[#1C1C1C] hover:bg-[#FFFFFF] hover:text-[#000000] text-[#FFFFFF] border border-[#333333] text-[10px] font-mono font-semibold btn-tactile"
                >
                  + {preset.label}
                </button>
              )}
            </For>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Player / Reason (e.g. Eliminated Jett)..."
              value={customReasonText()}
              autofocus
              onInput={(e) => setCustomReasonText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitCustomPin();
                if (e.key === 'Escape') setShowPinComposer(false);
              }}
              aria-label="Marker reason description"
              className="flex-1 bg-[#1C1C1C] border border-[#333333] rounded-lg px-2.5 py-1 text-xs text-[#FFFFFF] placeholder-[#FFFFFF]/40 font-mono focus:outline-none focus:border-[#FFFFFF]"
            />
            <button
              type="button"
              onClick={submitCustomPin}
              className="px-3 py-1 rounded-lg bg-gradient-to-r from-[#FFFFFF] to-[#BDBDBD] hover:opacity-95 text-[#000000] font-black text-xs font-mono btn-tactile"
            >
              PLACE
            </button>
          </div>
        </div>
      </Show>

      {/* Speed Multiplier Popover with Explicit "Normal (1x)" Option */}
      <Show when={showSpeedMenu()}>
        <div
          role="dialog"
          aria-label="Select playback speed multiplier"
          className="absolute bottom-full mb-2 right-14 z-50 w-52 rounded-xl bg-[#0A0B0E] border border-[#9333EA]/50 p-2 shadow-[0_18px_45px_rgba(0,0,0,0.9),0_0_20px_rgba(147,51,234,0.25)] animate-popIn flex flex-col gap-1 backdrop-blur-xl"
        >
          <div className="px-2 py-1 text-[10px] font-mono font-black uppercase tracking-wider text-[#FFFFFF] border-b border-[#2A2D34] flex items-center justify-between">
            <span className="text-[#C084FC] flex items-center gap-1.5">
              <svg class="size-3 text-[#A855F7]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              SPEED MULTIPLIER
            </span>
            <button
              type="button"
              aria-label="Close speed menu"
              onClick={() => setShowSpeedMenu(false)}
              className="size-4.5 rounded flex items-center justify-center text-[#94A3B8] hover:text-[#FFFFFF] hover:bg-[#1A1D24] transition-colors"
            >
              <svg class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <For each={SPEED_OPTIONS}>
            {(opt) => {
              const active = () => props.playbackSpeed === opt.value;
              return (
                <button
                  type="button"
                  onClick={() => {
                    props.onSetSpeed(opt.value);
                    setShowSpeedMenu(false);
                  }}
                  className={`w-full px-3 py-2 rounded-lg text-left text-xs font-mono flex items-center justify-between transition-all btn-tactile ${
                    active()
                      ? 'bg-gradient-to-r from-[#7C3AED] to-[#9333EA] text-[#FFFFFF] font-black shadow-md border border-[#C084FC]/60 shadow-[0_0_12px_rgba(124,58,237,0.4)]'
                      : 'text-[#FFFFFF] bg-[#161922] hover:bg-[#7C3AED]/25 hover:border-[#9333EA]/60 border border-[#2A2E3B]'
                  }`}
                >
                  <span className={active() ? 'text-[#FFFFFF] font-black' : 'text-[#FFFFFF] font-bold'}>{opt.label}</span>
                  <Show when={opt.value === 1}>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[9px] font-black tracking-wider uppercase ${
                        active()
                          ? 'bg-[#FFFFFF] text-[#581C87]'
                          : 'bg-[#2A1B4E] text-[#D8B4FE] border border-[#9333EA]/60'
                      }`}
                    >
                      DEFAULT
                    </span>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>

      {/* Row 2: Crisp Smooth Scrubber Track with Tactical Combat DOTS (Hover to reveal telemetry) */}
      <div
        ref={(el) => props.setScrubberTrackRef(el)}
        onMouseDown={props.onScrubberMouseDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className="relative w-full h-8 mt-1 flex items-center cursor-pointer select-none group/timeline"
      >
        {/* Main Track Rail */}
        <div className="relative w-full h-2.5 bg-[#12141A] rounded-full overflow-hidden border border-[#2A2D34] shadow-inner">
          <Show when={props.isEditMode}>
            <div
              className="absolute top-0 bottom-0 bg-[#7C3AED]/35 border-x-2 border-[#9333EA] z-10 pointer-events-none"
              style={{
                left: `${(props.trimStart / props.safeDuration) * 100}%`,
                width: `${((props.trimEnd - props.trimStart) / props.safeDuration) * 100}%`,
              }}
            />
          </Show>

          {/* Zero transition lag while scrubbing so sliding feels instantaneous */}
          <div
            className={`absolute left-0 top-0 bottom-0 bg-gradient-to-r from-[#581C87] via-[#7C3AED] to-[#3F88C5] rounded-full ${
              isAnyScrubbing() ? '' : 'transition-[width] duration-75'
            }`}
            style={{ width: `${(props.currentTime / props.safeDuration) * 100}%` }}
          />
        </div>

        {/* Interactive Draggable Trim Handles */}
        <Show when={props.isEditMode}>
          <div
            onMouseDown={(e) => handleTrimDrag(e, 'start')}
            style={{ left: `${(props.trimStart / props.safeDuration) * 100}%` }}
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-35 cursor-ew-resize flex flex-col items-center select-none"
            title={`Trim Start: ${props.trimStart.toFixed(1)}s (Drag to adjust)`}
          >
            <div className="w-3.5 h-6 rounded bg-[#9333EA] text-white flex items-center justify-center text-[9px] font-black shadow-lg border border-white">
              [
            </div>
          </div>
          <div
            onMouseDown={(e) => handleTrimDrag(e, 'end')}
            style={{ left: `${(props.trimEnd / props.safeDuration) * 100}%` }}
            className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-35 cursor-ew-resize flex flex-col items-center select-none"
            title={`Trim End: ${props.trimEnd.toFixed(1)}s (Drag to adjust)`}
          >
            <div className="w-3.5 h-6 rounded bg-[#9333EA] text-white flex items-center justify-center text-[9px] font-black shadow-lg border border-white">
              ]
            </div>
          </div>
        </Show>

        {/* Live Floating Frame & Timestamp Preview While Hovering or Sliding */}
        <Show when={hoverPercent() !== null && hoverSec() !== null}>
          <div
            className="absolute top-0 bottom-0 w-[2px] bg-[#FFFFFF]/85 pointer-events-none z-20"
            style={{ left: `${hoverPercent()}%` }}
          />
          <div
            className="absolute bottom-full mb-1.5 -translate-x-1/2 pointer-events-none z-40 flex flex-col items-center gap-1"
            style={{ left: `${Math.max(6, Math.min(94, hoverPercent()!))}%` }}
          >
            <Show when={previewThumbForSec(hoverSec()!)}>
              {(thumbUrl) => (
                <div className="w-28 h-16 rounded-lg overflow-hidden border border-[#2A2D34] shadow-[0_8px_24px_rgba(0,0,0,0.85)] bg-[#000000]">
                  <img src={thumbUrl()} alt="Preview" className="w-full h-full object-cover" />
                </div>
              )}
            </Show>
            <div className="px-2 py-0.5 rounded bg-[#0A0B0E] text-[#FFFFFF] font-mono tabular-nums text-[9px] font-black border border-[#2A2D34] shadow-xl">
              {formatTimeMs(hoverSec()!)}
            </div>
          </div>
        </Show>

        {/* Current Playhead Handle (Zero lag during scrubbing) */}
        <div
          className={`absolute size-3.5 bg-[#FFFFFF] rounded-full shadow-[0_0_8px_rgba(255,255,255,0.4)] pointer-events-none -translate-x-1/2 top-1/2 -translate-y-1/2 z-30 border-2 border-[#9333EA] ${
            isAnyScrubbing() ? 'scale-125' : ''
          }`}
          style={{ left: `${(props.currentTime / props.safeDuration) * 100}%` }}
        />

        {/* Clean Combat DOTS (Hover to reveal telemetry) */}
        <For each={staggeredMarkers()}>
          {(item) => {
            const evt = item.evt;
            const eventSec = () => props.getNormalizedEventSec(evt);
            const posPct = () => props.getEventPercent(evt);
            const isKill = () => evt.event_type === 'kill';
            const isDeath = () => evt.event_type === 'death';
            const isHeadshot = () => evt.headshot;
            const victim = () => props.getVictimAgent(evt);
            const killer = () => props.getKillerAgent(evt);
            const killNum = () => evt.kill_number || 1;
            const reasonText = () => evt.reason;

            const targetAgentOrPlayer = () => {
              const r = reasonText()?.trim();
              if (r) {
                if (r.startsWith('Eliminated by ')) {
                  return r.replace('Eliminated by ', '').replace(/\s*\([^)]*\)\s*$/, '').trim() || r;
                }
                if (r.startsWith('Eliminated ')) {
                  return r.replace('Eliminated ', '').replace(/\s*\([^)]*\)\s*$/, '').trim() || r;
                }
                return r;
              }
              const raw = isKill() ? victim() : killer();
              const label = formatMarkerTargetLabel(raw);
              return label && label !== 'Enemy' ? label : 'Enemy';
            };

            const markerTitle = () => {
              const r = reasonText()?.trim();
              if (r) {
                if (r.startsWith('Eliminated ') || r.startsWith('Eliminated by ')) {
                  return r;
                }
                if (r.toLowerCase().includes('kill')) {
                  const cleaned = r.replace(/kill/gi, '').replace(/[()]/g, '').trim();
                  const weapon = evt.weapon ? ` (${evt.weapon})` : '';
                  if (cleaned) {
                    return `${cleaned} Elimination${weapon}`;
                  }
                  return `Eliminated Enemy${weapon}`;
                }
                const weapon = evt.weapon ? ` (${evt.weapon})` : '';
                return isKill()
                  ? `Eliminated ${r}${weapon}`
                  : isDeath()
                  ? `Eliminated by ${r}${weapon}`
                  : r;
              }
              const target = targetAgentOrPlayer();
              const weapon = evt.weapon ? ` (${evt.weapon})` : '';
              if (isKill()) return `Eliminated ${target}${weapon}`;
              if (isDeath()) return `Eliminated by ${target}${weapon}`;
              return evt.event_type === 'custom' ? 'Custom Note' : 'Combat Event';
            };

            const popoverAlign = () => {
              const pct = posPct();
              if (pct < 18) return 'left-0 translate-x-0';
              if (pct > 72) return 'right-0 translate-x-0';
              return 'left-1/2 -translate-x-1/2';
            };

            const caretAlign = () => {
              const pct = posPct();
              if (pct < 18) return 'self-start ml-3.5';
              if (pct > 72) return 'self-end mr-3.5';
              return 'self-center';
            };

            const markerUid = item.uid;
            const isThisMarkerActive = () => (editingMarkerId() ?? pinnedMarkerId() ?? hoveredMarkerId()) === markerUid;

            return (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  props.onSeekToEvent(eventSec());
                  const isCurrent = pinnedMarkerId() === markerUid;
                  setPinnedMarkerId(isCurrent ? null : markerUid);
                  setHoveredMarkerId(isCurrent ? null : markerUid);
                }}
                onMouseEnter={() => {
                  if (markerHoverTimeout) clearTimeout(markerHoverTimeout);
                  setHoveredMarkerId(markerUid);
                }}
                onMouseLeave={() => {
                  if (markerHoverTimeout) clearTimeout(markerHoverTimeout);
                  markerHoverTimeout = setTimeout(() => {
                    setHoveredMarkerId(null);
                  }, 400);
                }}
                onMouseDown={(e) => handleMarkerMouseDown(e, evt, eventSec())}
                style={{
                  left: `${posPct()}%`,
                }}
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 group/marker z-40 cursor-grab active:cursor-grabbing flex flex-col items-center justify-center p-2.5 -m-2.5"
                title={`${markerTitle()} @ ${formatExactSec(eventSec())} (Click to pin • Drag to adjust)`}
              >
                {/* Tactical Luminous Combat Dot */}
                <div
                  className={`size-4 rounded-full flex items-center justify-center transition-all duration-150 group-hover/marker:scale-125 border ${
                    isKill()
                      ? 'bg-[#7C3AED] text-white border-[#9333EA] shadow-[0_0_12px_rgba(124,58,237,0.55)]'
                      : isDeath()
                      ? 'bg-[#1E222A] text-white border-[#CBD5E1] shadow-[0_0_8px_rgba(255,255,255,0.4)]'
                      : 'bg-[#3F88C5] text-white border-[#3F88C5] shadow-[0_0_8px_rgba(63,136,197,0.6)]'
                  }`}
                >
                  <Show when={isKill()}>
                    <KillEmblemIcon class="size-2 text-white" />
                  </Show>
                  <Show when={isDeath()}>
                    <SkullDeathIcon class="size-2 text-white" />
                  </Show>
                  <Show when={!isKill() && !isDeath()}>
                    <span className="size-1 rounded-full bg-white" />
                  </Show>
                </div>

                {/* Telemetry Popover (Strictly Single Active Popover, Positioned Above Scrubber to Prevent Overlap) */}
                <Show when={isThisMarkerActive()}>
                  <div
                    onClick={(e) => e.stopPropagation()}
                    onMouseEnter={() => {
                      if (markerHoverTimeout) clearTimeout(markerHoverTimeout);
                      setHoveredMarkerId(markerUid);
                    }}
                    onMouseLeave={() => {
                      if (markerHoverTimeout) clearTimeout(markerHoverTimeout);
                      markerHoverTimeout = setTimeout(() => {
                        setHoveredMarkerId(null);
                      }, 400);
                    }}
                    className={`absolute bottom-[calc(100%+16px)] ${popoverAlign()} flex flex-col items-center pointer-events-auto z-50 animate-popover`}
                  >
                  {/* Invisible hit-area bridge so moving mouse between dot and popover never drops hover */}
                  <div className="absolute inset-x-0 -bottom-5 h-7 pointer-events-auto" />
                  <div className="bg-[#0A0B0E]/98 text-[#FFFFFF] border border-[#9333EA]/60 px-3 py-1.5 rounded-xl shadow-[0_16px_40px_rgba(0,0,0,0.95),0_0_16px_rgba(147,51,234,0.3)] text-[10px] font-mono whitespace-nowrap flex flex-col gap-1 backdrop-blur-md">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`px-1.5 py-0.2 rounded text-[8px] font-black flex items-center gap-1 ${
                            isKill()
                              ? 'bg-[#7C3AED] text-white border border-[#9333EA]/50'
                              : isDeath()
                              ? 'bg-[#1E222A] text-white border border-[#CBD5E1]/40'
                              : 'bg-[#3F88C5] text-white'
                          }`}
                        >
                          <Show when={isKill()}>
                            <KillEmblemIcon class="size-2" />
                          </Show>
                          <Show when={isDeath()}>
                            <SkullDeathIcon class="size-2" />
                          </Show>
                          <span>{isKill() ? (killNum() > 1 ? `${killNum()}K ELIM` : 'KILL') : isDeath() ? 'DEATH' : 'NOTE'}</span>
                        </span>

                        <span className="font-bold text-[#FFFFFF] text-[10px]">{markerTitle()}</span>

                        <Show when={isHeadshot()}>
                          <span className="px-1 py-0.2 rounded bg-[#7C3AED] text-white text-[7px] font-black">
                            HEADSHOT
                          </span>
                        </Show>

                        <span className="text-[#C084FC] text-[9px] font-bold tabular-nums">
                          @{formatExactSec(eventSec())}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPinnedMarkerId(null);
                          setHoveredMarkerId(null);
                        }}
                        className="size-4.5 rounded flex items-center justify-center text-[#94A3B8] hover:text-[#FFFFFF] hover:bg-[#1A1D24] transition-colors"
                        title="Close"
                      >
                        <svg class="size-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-0.5 border-t border-[#2A2D34]/80">
                      <span className="text-[8px] text-[#94A3B8]">Drag dot to fine-tune timestamp</span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingMarkerId(markerUid);
                            setMarkerReasonDraft(targetAgentOrPlayer());
                          }}
                          className="text-[8px] px-1.5 py-0.2 rounded bg-[#12141A] hover:bg-[#2A2D34] text-[#FFFFFF] border border-[#2A2D34] font-mono btn-tactile"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            props.onToggleCombatDotType(evt);
                          }}
                          className="text-[8px] px-1.5 py-0.2 rounded bg-[#12141A] hover:bg-[#7C3AED] text-[#FFFFFF] border border-[#2A2D34] font-mono btn-tactile"
                        >
                          {isKill() ? 'To Death' : 'To Kill'}
                        </button>
                        <button
                          type="button"
                          aria-label="Remove marker"
                          onClick={(e) => {
                            e.stopPropagation();
                            props.onRemoveCombatDot(evt);
                            if (pinnedMarkerId() === markerUid) {
                              setPinnedMarkerId(null);
                            }
                          }}
                          className="size-4 rounded flex items-center justify-center bg-[#12141A] hover:bg-[#E11D48] text-[#CBD5E1] hover:text-white border border-[#2A2D34] transition-colors btn-tactile"
                          title="Delete this marker"
                        >
                          <svg class="size-2 text-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    <Show when={editingMarkerId() === markerUid}>
                      <div
                        className="flex items-center gap-1.5 pt-1.5 border-t border-[#2A2D34]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="text"
                          value={markerReasonDraft()}
                          placeholder="Agent or Player (e.g. Phoenix, Jett, Raze)..."
                          autofocus
                          onInput={(e) => setMarkerReasonDraft(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') {
                              props.onUpdateCombatDotReason(evt, markerReasonDraft().trim());
                              setEditingMarkerId(null);
                            }
                            if (e.key === 'Escape') {
                              setEditingMarkerId(null);
                            }
                          }}
                          className="bg-[#12141A] border border-[#2A2D34] rounded px-2 py-0.5 text-[10px] text-white font-mono focus:border-[#9333EA] focus:outline-none w-52"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            props.onUpdateCombatDotReason(evt, markerReasonDraft().trim());
                            setEditingMarkerId(null);
                          }}
                          className="px-2 py-0.5 rounded bg-[#7C3AED] hover:bg-[#9333EA] text-white font-bold text-[9px] font-mono"
                        >
                          Save
                        </button>
                      </div>
                    </Show>
                  </div>
                  {/* Tooltip caret accurately pointing down to dot */}
                  <div className={`size-2 -mt-1 rotate-45 bg-[#0A0B0E] border-r border-b border-[#2A2D34] ${caretAlign()}`} />
                </div>
              </Show>
            </div>
            );
          }}
        </For>
      </div>

      
      {/* Row 1: Single-Row Compact Playback & Marker Controls Bar (Strictly Single Line, No Scrollbar, Perfectly Aligned) */}
      <div className="flex items-center justify-between text-xs gap-1.5 w-full shrink-0 flex-nowrap h-7.5 select-none overflow-hidden">
        <div className="flex items-center gap-1.5 shrink min-w-0">
          {/* Play/Pause Button */}
          <button
            type="button"
            onClick={props.onTogglePlay}
            aria-label={props.isPlaying ? 'Pause' : 'Play'}
            className="size-7 rounded-md bg-[#7C3AED] hover:bg-[#9333EA] text-[#FFFFFF] flex items-center justify-center btn-tactile shadow-[0_2px_8px_rgba(0,0,0,0.5)] shrink-0 border border-[#9333EA]/60"
            title="Play/Pause (Space)"
          >
            <Show
              when={props.isPlaying}
              fallback={
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="translate-x-0.5">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              }
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            </Show>
          </button>

          {/* Time Counter */}
          <div className="h-7 font-mono tabular-nums text-[10.5px] tracking-tight flex items-center gap-1 bg-[#12141A] px-2 rounded-md border border-[#2A2D34] shrink-0">
            <span className="text-[#FFFFFF] font-black">{formatTimeMs(props.currentTime)}</span>
            <span className="text-[#CBD5E1]/50">/</span>
            <span className="text-[#CBD5E1] font-semibold">{formatTime(props.safeDuration)}</span>
          </div>

          {/* Kill & Skull-Death Summary Pills */}
          <div className="flex items-center gap-1 pl-1 border-l border-[#2A2D34] shrink-0">
            <span className="h-7 px-1.5 rounded-md bg-[#7C3AED]/30 text-[#FFFFFF] border border-[#9333EA]/50 text-[10px] font-mono font-bold tabular-nums flex items-center gap-1 shadow-sm shrink-0">
              <KillEmblemIcon class="size-2.5 text-[#C084FC]" />
              <span>{props.combatEvents.filter((e) => e.event_type === 'kill').length} Kills</span>
            </span>

            <span className="h-7 px-1.5 rounded-md bg-[#1E222A] text-[#CBD5E1] border border-[#3F88C5]/40 text-[10px] font-mono font-bold tabular-nums flex items-center gap-1 shrink-0">
              <SkullDeathIcon class="size-2.5 text-[#3F88C5]" />
              <span>{props.combatEvents.filter((e) => e.event_type === 'death').length} Deaths</span>
            </span>
          </div>

          {/* Compact Manual & Custom Marker Buttons */}
          <div className="flex items-center gap-1 pl-1 border-l border-[#2A2D34] shrink-0">
            <button
              type="button"
              onClick={() => props.onAddCombatDot('kill', 'Kill')}
              className="h-7 px-2 rounded-md bg-[#7C3AED] hover:bg-[#9333EA] text-[#FFFFFF] text-[10px] font-mono font-bold flex items-center gap-1 btn-tactile border border-[#9333EA]/60 shadow-sm shrink-0"
              title="Insert Kill Marker at current playhead"
            >
              <KillEmblemIcon class="size-2.5" />
              <span>+ Kill</span>
            </button>
            <button
              type="button"
              onClick={() => props.onAddCombatDot('death', 'Death')}
              className="h-7 px-2 rounded-md bg-[#1E222A] hover:bg-[#2A2D34] text-[#FFFFFF] text-[10px] font-mono font-bold flex items-center gap-1 btn-tactile border border-[#CBD5E1]/30 shrink-0"
              title="Insert Skull Death Marker at current playhead"
            >
              <SkullDeathIcon class="size-2.5 text-[#CBD5E1]" />
              <span>+ Death</span>
            </button>
            <button
              type="button"
              onClick={() => setShowPinComposer(!showPinComposer())}
              className={`h-7 px-2 rounded-md border text-[10px] font-mono font-bold flex items-center gap-1 btn-tactile shrink-0 ${
                showPinComposer()
                  ? 'bg-[#3F88C5] text-[#FFFFFF] border-[#3F88C5] font-black shadow-[0_0_8px_rgba(63,136,197,0.4)]'
                  : 'bg-[#12141A] hover:bg-[#1A1D24] text-[#3F88C5] border-[#3F88C5]/50'
              }`}
              title="Add Custom Reason Marker (Clutch, Flick, Wallbang...)"
            >
              <span>+ Reason</span>
            </button>
          </div>
        </div>

        {/* Right Playback Utilities (Speed Multiplier with Explicit "Normal" Option) */}
        <div className="flex items-center gap-1 shrink-0 pl-1">
          {/* Instant "Normal" Speed Pill + Speed Multiplier Selector */}
          <div className="h-7 flex items-center gap-0.5 bg-[#12141A] p-0.5 rounded-md border border-[#2A2D34]">
            <button
              type="button"
              onClick={() => props.onSetSpeed(1)}
              className={`h-6 px-1.5 rounded text-[10px] font-mono font-bold transition-all btn-tactile flex items-center ${
                props.playbackSpeed === 1
                  ? 'bg-[#7C3AED] text-[#FFFFFF] shadow-sm border border-[#9333EA]/50'
                  : 'text-[#CBD5E1] hover:text-[#FFFFFF] hover:bg-[#1A1D24]'
              }`}
              title="Run video at Normal (1.0x) real-time speed"
            >
              Normal
            </button>

            <button
              type="button"
              onClick={() => setShowSpeedMenu(!showSpeedMenu())}
              aria-label="Open playback speed multiplier menu"
              className={`h-6 px-1.5 font-mono tabular-nums text-[10px] font-bold rounded flex items-center gap-0.5 btn-tactile ${
                props.playbackSpeed !== 1
                  ? 'bg-[#7C3AED] text-[#FFFFFF] font-black'
                  : 'bg-[#1A1D24] text-[#CBD5E1] hover:bg-[#2A2D34]'
              }`}
              title="Select Speed Multiplier (0.25x, 0.5x, Normal 1x, 1.5x, 2x)"
            >
              <span>{props.playbackSpeed === 1 ? '1x' : `${props.playbackSpeed}x`}</span>
              <svg class="size-2 opacity-80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>

          <button
            type="button"
            onClick={props.onToggleMute}
            aria-label={props.isMuted ? 'Unmute' : 'Mute'}
            className={`size-7 rounded-md flex items-center justify-center btn-tactile border shrink-0 ${
              props.isMuted
                ? 'bg-[#7C3AED]/30 text-[#C084FC] border-[#9333EA]/50'
                : 'bg-[#12141A] hover:bg-[#1A1D24] text-[#FFFFFF] border-[#2A2D34]'
            }`}
            title={props.isMuted ? 'Unmute Audio' : 'Audio Active (Click to Mute)'}
          >
            <Show
              when={props.isMuted}
              fallback={
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                </svg>
              }
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
            </Show>
          </button>

          <button
            type="button"
            onClick={props.onToggleFullscreen}
            aria-label="Toggle Fullscreen"
            className="size-7 rounded-md bg-[#12141A] hover:bg-[#1A1D24] text-[#FFFFFF] flex items-center justify-center btn-tactile border border-[#2A2D34] shrink-0"
            title="Fullscreen"
          >
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Row 3: Frame by Frame Interactive Filmstrip Timeline */}
      <div className="flex flex-col gap-1 pt-1.5 border-t border-[#2A2D34]/50 select-none">
        <div className="flex items-center justify-between text-[9px] font-mono font-bold">
          <span className="text-[#C084FC] uppercase tracking-wider flex items-center gap-1.5">
            <svg class="size-2.5 text-[#A855F7]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
              <line x1="7" y1="2" x2="7" y2="22" />
              <line x1="17" y1="2" x2="17" y2="22" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <line x1="2" y1="7" x2="7" y2="7" />
              <line x1="2" y1="17" x2="7" y2="17" />
              <line x1="17" y1="17" x2="22" y2="17" />
              <line x1="17" y1="7" x2="22" y2="7" />
            </svg>
            FRAME TIMELINE
          </span>
          <span className="text-[#94A3B8]/80 text-[8.5px]">
            slide smoothly across frames or markers to scrub in real time
          </span>
        </div>

        {/* 10 Interactive Filmstrip Frame Slots across the clip duration */}
        <div className="grid grid-cols-10 gap-1.5 h-11 w-full">
          <For each={Array.from({ length: 10 })}>
            {(_, idx) => {
              const frameSec = () => (idx() / 10) * props.safeDuration;
              const nextSec = () => ((idx() + 1) / 10) * props.safeDuration;
              const isCurrentFrame = () => props.currentTime >= frameSec() && props.currentTime < nextSec();
              const frameEvents = () => props.combatEvents.filter(
                (e) => (e.event_time_ms / 1000) >= frameSec() && (e.event_time_ms / 1000) < nextSec()
              );
              const hasKill = () => frameEvents().some((e) => e.event_type === 'kill');
              const hasDeath = () => frameEvents().some((e) => e.event_type === 'death');

              return (
                <button
                  type="button"
                  onClick={() => props.onSeekTo(frameSec())}
                  className={`relative rounded-md overflow-hidden flex flex-col justify-between p-1 text-left transition-all btn-tactile border ${
                    isCurrentFrame()
                      ? 'bg-[#7C3AED]/25 border-[#C084FC] shadow-[0_0_10px_rgba(168,85,247,0.4)] ring-1 ring-[#A855F7]'
                      : 'bg-[#12141A]/90 hover:bg-[#1A1D24] border-[#2A2D34] hover:border-[#9333EA]/50'
                  }`}
                  title={`Jump to ${frameSec().toFixed(1)}s`}
                >
                  {/* Real Extracted Frame Photo from Clip */}
                  <Show when={props.thumbnails && props.thumbnails[idx()] && props.thumbnails[idx()].length > 0}>
                    <img
                      src={props.thumbnails![idx()]}
                      alt={`Frame ${idx() + 1}`}
                      className="absolute inset-0 w-full h-full object-cover pointer-events-none opacity-85 group-hover:opacity-100 transition-opacity"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-[#0A0B0E]/85 via-transparent to-[#0A0B0E]/60 pointer-events-none" />
                  </Show>

                  {/* Subtle Tactical Grid / Scanline Motif */}
                  <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:100%_4px] pointer-events-none" />

                  {/* Top Bar: Timestamp */}
                  <div className="flex items-center justify-between w-full z-10">
                    <span className={`text-[8.5px] font-mono tabular-nums font-bold ${
                      isCurrentFrame() ? 'text-[#FFFFFF] font-black' : 'text-[#94A3B8]'
                    }`}>
                      {frameSec().toFixed(1)}s
                    </span>

                    {/* Kill / Death mini emblems */}
                    <div className="flex items-center gap-0.5">
                      <Show when={hasKill()}>
                        <span className="size-2 rounded-full bg-[#7C3AED] flex items-center justify-center text-[6px] text-white font-black" title="Kill in this frame">
                          K
                        </span>
                      </Show>
                      <Show when={hasDeath()}>
                        <span className="size-2 rounded-full bg-[#EF4444] flex items-center justify-center text-[6px] text-white font-black" title="Death in this frame">
                          D
                        </span>
                      </Show>
                    </div>
                  </div>

                  {/* Bottom Accent Indicator */}
                  <div className={`h-0.5 w-full rounded-full z-10 transition-colors ${
                    isCurrentFrame()
                      ? 'bg-gradient-to-r from-[#C084FC] to-[#7C3AED]'
                      : hasKill()
                      ? 'bg-[#7C3AED]/70'
                      : 'bg-[#2A2D34]'
                  }`} />
                </button>
              );
            }}
          </For>
        </div>
      </div>

      {/* Row 4: Collapsible Precision Trim Studio Drawer */}
      <Show when={props.isEditMode}>
        <div className="pt-2 border-t border-[#333333] flex flex-wrap items-center justify-between gap-2 text-xs animate-fadeIn">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono uppercase tracking-wider text-[#E5E5E5] font-black">
              TRIM RANGE:
            </span>
            <button
              type="button"
              onClick={props.onSetInAtPlayhead}
              className="px-2.5 py-1 bg-[#000000] hover:bg-[#1C1C1C] text-[#FFFFFF] rounded border border-[#333333] font-mono tabular-nums text-[11px] font-bold btn-tactile"
            >
              [ IN: {props.trimStart.toFixed(1)}s
            </button>
            <button
              type="button"
              onClick={props.onSetOutAtPlayhead}
              className="px-2.5 py-1 bg-[#000000] hover:bg-[#1C1C1C] text-[#FFFFFF] rounded border border-[#333333] font-mono tabular-nums text-[11px] font-bold btn-tactile"
            >
              OUT: {props.trimEnd.toFixed(1)}s ]
            </button>
            <button
              type="button"
              onClick={props.onToggleTrimLooping}
              className={`px-2.5 py-1 rounded text-[11px] font-mono font-bold border btn-tactile ${
                props.isTrimLooping
                  ? 'bg-[#BDBDBD] text-[#000000] border-[#FFFFFF]'
                  : 'bg-[#000000] text-[#000000]/70 border-[#333333]'
              }`}
            >
              Loop: {props.isTrimLooping ? 'ON' : 'OFF'}
            </button>
          </div>

            {/* Quick Trim Preset Ranges */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => props.onSetTrimRange && props.onSetTrimRange(Math.max(0, props.safeDuration - 5), props.safeDuration)}
                className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#12141A] hover:bg-[#7C3AED] hover:text-white text-[#CBD5E1] border border-[#2A2D34] btn-tactile"
              >
                Last 5s
              </button>
              <button
                type="button"
                onClick={() => props.onSetTrimRange && props.onSetTrimRange(Math.max(0, props.safeDuration - 10), props.safeDuration)}
                className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#12141A] hover:bg-[#7C3AED] hover:text-white text-[#CBD5E1] border border-[#2A2D34] btn-tactile"
              >
                Last 10s
              </button>
              <button
                type="button"
                onClick={() => props.onSetTrimRange && props.onSetTrimRange(Math.max(0, props.safeDuration - 15), props.safeDuration)}
                className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#12141A] hover:bg-[#7C3AED] hover:text-white text-[#CBD5E1] border border-[#2A2D34] btn-tactile"
              >
                Last 15s
              </button>
              <button
                type="button"
                onClick={() => props.onSetTrimRange && props.onSetTrimRange(0, props.safeDuration)}
                className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#12141A] hover:bg-[#7C3AED] hover:text-white text-[#CBD5E1] border border-[#2A2D34] btn-tactile"
              >
                Full Clip
              </button>
            </div>

          <div className="flex items-center gap-2 flex-1 max-w-md justify-end">
            <input
              type="text"
              placeholder="Clip title (optional)..."
              value={props.clipTitleInput}
              onInput={(e) => props.onSetClipTitleInput(e.currentTarget.value)}
              aria-label="Exported clip title"
              className="bg-[#12141A] border border-[#2A2D34] rounded px-2.5 py-1 text-xs text-[#FFFFFF] placeholder-[#94A3B8]/60 focus:outline-none focus:border-[#9333EA] w-44 font-mono"
            />
            <button
              type="button"
              onClick={props.onExportTrimmedClip}
              disabled={props.isTrimming}
              className="px-3.5 py-1 bg-gradient-to-r from-[#7C3AED] to-[#9333EA] hover:opacity-95 text-[#FFFFFF] font-black text-xs rounded shadow-md btn-tactile disabled:opacity-50 font-mono border border-[#C084FC]/50"
            >
              {props.isTrimming ? 'SAVING...' : `SAVE TRIM (${(props.trimEnd - props.trimStart).toFixed(1)}s)`}
            </button>
          </div>
        </div>
      </Show>
      </Show>
    </div>
  );
}
