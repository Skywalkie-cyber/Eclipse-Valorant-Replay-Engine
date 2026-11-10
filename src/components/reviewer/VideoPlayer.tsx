import { Show, createSignal } from 'solid-js';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ClipEntry } from '../../types';

interface VideoPlayerProps {
  selectedClip: ClipEntry | null;
  videoRef: HTMLVideoElement | undefined;
  setVideoRef: (el: HTMLVideoElement) => void;
  containerRef: HTMLDivElement | undefined;
  setContainerRef: (el: HTMLDivElement) => void;
  isPlaying: boolean;
  isMuted: boolean;
  isFlippedVertical: boolean;
  isRepairingFlip: boolean;
  isEditMode: boolean;
  isConvertingShort?: boolean;
  multiKillBadge: { label: string; badgeClass: string } | null;
  onTogglePlay: () => void;
  onToggleEditMode: () => void;
  onToggleFlipVertical: () => void;
  onRepairInvertedClip: () => void;
  onExportVerticalShort?: () => void;
  onShareClip: (clip: ClipEntry) => void;
  onRenameClip: (clip: ClipEntry, newTitle: string) => Promise<void>;
  onTimeUpdate: () => void;
  onLoadedMetadata: () => void;
  onEnded: () => void;
}

export function VideoPlayer(props: VideoPlayerProps) {
  const [isRenamingHeader, setIsRenamingHeader] = createSignal(false);
  const [headerDraft, setHeaderDraft] = createSignal('');

  const formatClipDisplayTitle = (name: string) =>
    name
      .replace(/\.[^/.]+$/, '')
      .replace(/^Valorant_Highlight_/, '')
      .replace(/^Valorant_Clip_/, 'Clip_')
      .replace(/_/g, ' ');

  const beginHeaderRename = () => {
    if (!props.selectedClip) return;
    setHeaderDraft(formatClipDisplayTitle(props.selectedClip.file_name));
    setIsRenamingHeader(true);
  };

  const commitHeaderRename = async () => {
    const clip = props.selectedClip;
    const val = headerDraft().trim();
    setIsRenamingHeader(false);
    if (!clip || !val) return;
    await props.onRenameClip(clip, val);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-transparent overflow-hidden select-none z-10 relative">
      {/* Compact Clip Action Bar */}
      <div className="h-9 bg-[#0A0B0E]/90 backdrop-blur-xl border-b border-[#2A2D34] px-3.5 flex items-center justify-between shrink-0 z-20 gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="size-2 rounded-full bg-[#9333EA] shadow-[0_0_8px_#9333EA] shrink-0" />
          <Show
            when={isRenamingHeader()}
            fallback={
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  onDblClick={beginHeaderRename}
                  className="text-[#FFFFFF] font-black text-xs tracking-wide truncate max-w-sm font-mono cursor-pointer hover:text-[#CBD5E1] transition-colors"
                  title={props.selectedClip ? `${props.selectedClip.file_name} (Double-click to rename)` : ''}
                >
                  {props.selectedClip ? formatClipDisplayTitle(props.selectedClip.file_name) : 'NO CLIP SELECTED'}
                </span>
                <Show when={props.selectedClip}>
                  <button
                    type="button"
                    aria-label="Rename active clip"
                    onClick={beginHeaderRename}
                    className="p-1 rounded text-[#CBD5E1]/70 hover:text-[#FFFFFF] hover:bg-[#12141A] btn-tactile"
                    title="Rename Clip"
                  >
                    <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                    </svg>
                  </button>
                </Show>
              </div>
            }
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={headerDraft()}
                autofocus
                onInput={(e) => setHeaderDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitHeaderRename();
                  if (e.key === 'Escape') setIsRenamingHeader(false);
                }}
                onBlur={commitHeaderRename}
                aria-label="Rename clip title"
                className="bg-[#12141A] border border-[#B91C1C] rounded px-2.5 py-0.5 text-xs text-[#FFFFFF] font-mono focus:outline-none w-56"
              />
            </div>
          </Show>

          <Show when={props.multiKillBadge}>
            <span className="px-2.5 py-0.5 rounded text-[10px] font-mono font-black tracking-wider border bg-gradient-to-r from-[#7C3AED] to-[#9333EA] text-[#FFFFFF] border-[#C084FC]/50 shadow-[0_0_14px_rgba(147,51,234,0.5)]">
              {props.multiKillBadge!.label}
            </span>
          </Show>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Audio Active Pill */}
          <span className="hidden xl:inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#12141A] border border-[#2A2D34] text-[10px] font-mono text-[#3F88C5]">
            <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
            AAC STEREO
          </span>

          {/* Share Footage Button */}
          <Show when={props.selectedClip}>
            <button
              type="button"
              onClick={() => props.selectedClip && props.onShareClip(props.selectedClip)}
              className="px-2.5 py-1 rounded-md text-[11px] font-bold font-mono btn-tactile flex items-center gap-1 border border-[#9333EA]/40 bg-gradient-to-r from-[#7C3AED] to-[#9333EA] hover:opacity-95 text-[#FFFFFF] shadow-sm"
              title="Copy video file to clipboard for instant Ctrl+V sharing in Discord"
            >
              <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
              </svg>
              <span>Share</span>
            </button>
          </Show>

          {/* Trim & Cut Toggle */}
          <button
            type="button"
            onClick={props.onToggleEditMode}
            className={`px-2.5 py-1 rounded-md text-[11px] font-black font-mono btn-tactile flex items-center gap-1 border ${
              props.isEditMode
                ? 'bg-[#7C3AED] text-[#FFFFFF] border-[#9333EA] shadow-sm'
                : 'bg-[#12141A] text-[#CBD5E1] hover:text-[#FFFFFF] border-[#2A2D34]'
            }`}
          >
            <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <circle cx="6" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <line x1="20" y1="4" x2="8.12" y2="15.88" />
              <line x1="14.47" y1="14.48" x2="20" y2="20" />
              <line x1="8.12" y1="8.12" x2="12" y2="12" />
            </svg>
            <span>{props.isEditMode ? 'EXIT TRIM' : 'TRIM'}</span>
          </button>
        </div>
      </div>

      {/* Tight Theater Video Stage */}
      <div className="flex-1 min-h-0 w-full h-full flex items-center justify-center p-2.5 relative overflow-hidden">
        <Show
          when={props.selectedClip}
          fallback={
            <div className="flex flex-col items-center gap-3 text-center text-[#FFFFFF]/80 animate-fadeIn">
              <div className="size-14 rounded-xl bg-[#1C1C1C] border border-[#333333] flex items-center justify-center text-[#FFFFFF] shadow-2xl">
                <svg class="size-7 text-[#FFFFFF] translate-x-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              </div>
              <div className="text-xs font-black text-[#FFFFFF] font-mono uppercase tracking-wider">
                Ready for Highlights
              </div>
              <div className="text-[11px] text-[#FFFFFF]/70 max-w-sm leading-relaxed">
                Press <span className="text-[#FFFFFF] font-black font-mono px-1.5 py-0.5 rounded bg-[#1C1C1C] border border-[#333333]">F8</span> or click <span className="text-[#FFFFFF] font-bold">CLIP 30S</span> to save a 30s hardware replay with game audio &amp; automatic Kill/Death markers.
              </div>
            </div>
          }
        >
          <div
            ref={(el) => props.setContainerRef(el)}
            onClick={props.onTogglePlay}
            className="relative w-full h-full flex items-center justify-center group cursor-pointer"
          >
            <video
              ref={(el) => {
                el.volume = 1.0;
                props.setVideoRef(el);
              }}
              src={props.selectedClip ? convertFileSrc(props.selectedClip.full_path) : ''}
              className="max-w-full max-h-full aspect-video object-contain rounded-lg shadow-[0_14px_40px_rgba(0,0,0,0.85)] border border-[#2A2D34] bg-black transition-transform duration-200"
              style={{
                transform: props.isFlippedVertical ? 'scaleY(-1) translateZ(0)' : 'translateZ(0)',
                'will-change': 'transform',
              }}
              preload="metadata"
              onTimeUpdate={props.onTimeUpdate}
              onLoadedMetadata={props.onLoadedMetadata}
              onEnded={props.onEnded}
              muted={props.isMuted}
              playsinline
            />

            {/* Central Hero Play/Pause Overlay Icon */}
            <div className={`absolute z-30 transition-opacity duration-150 pointer-events-none ${props.isPlaying ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}>
              <div className="size-14 rounded-full bg-[#141414]/90 backdrop-blur-md border border-[#FFFFFF]/30 flex items-center justify-center text-[#FFFFFF] shadow-[0_0_24px_rgba(0,0,0,0.65)]">
                <Show
                  when={props.isPlaying}
                  fallback={
                    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor" className="translate-x-0.5">
                      <polygon points="5 3 19 12 5 21 5 3" />
                    </svg>
                  }
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" />
                    <rect x="14" y="4" width="4" height="16" />
                  </svg>
                </Show>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
