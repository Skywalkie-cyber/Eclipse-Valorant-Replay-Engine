import { createSignal, Show, For } from 'solid-js';
import { ClipEntry } from '../../types';

interface ClipsSidebarProps {
  clips: ClipEntry[];
  selectedClip: ClipEntry | null;
  isGameActive: boolean;
  isExporting: boolean;
  isMontageMode: boolean;
  selectedClipsForMontage: string[];
  isCreatingMontage: boolean;
  onSelectClip: (clip: ClipEntry) => void;
  onTriggerClip: () => void;
  onToggleMontageMode: () => void;
  onToggleSelectForMontage: (path: string) => void;
  onCreateMontage: () => void;
  onDeleteClip: (e: MouseEvent, clip: ClipEntry) => void;
  onOpenFolder: (e: MouseEvent, clip: ClipEntry) => void;
  onShareClip: (e: MouseEvent, clip: ClipEntry) => void;
  onRenameClip: (clip: ClipEntry, newTitle: string) => Promise<void>;
}

export function ClipsSidebar(props: ClipsSidebarProps) {
  const [searchQuery, setSearchQuery] = createSignal('');
  const [eventFilter, setEventFilter] = createSignal<'all' | 'kill' | 'death'>('all');
  const [renamingFile, setRenamingFile] = createSignal<string | null>(null);
  const [renameDraft, setRenameDraft] = createSignal('');

  const filteredClips = () => {
    return props.clips.filter((c) => {
      const matchesSearch = c.file_name.toLowerCase().includes(searchQuery().toLowerCase());
      if (!matchesSearch) return false;
      if (eventFilter() === 'kill') {
        return c.file_name.toLowerCase().includes('kill') || c.file_name.toLowerCase().includes('highlight');
      }
      if (eventFilter() === 'death') {
        return c.file_name.toLowerCase().includes('death') || c.file_name.toLowerCase().includes('eliminated');
      }
      return true;
    });
  };

  const formatSize = (mb: number) => {
    if (!Number.isFinite(mb)) return '--';
    if (mb < 0.1) return `${Math.round(mb * 1024)} KB`;
    return `${mb.toFixed(1)} MB`;
  };

  const formatDisplayName = (name: string) => {
    return name
      .replace(/\.[^/.]+$/, '')
      .replace(/^Valorant_Highlight_/, '')
      .replace(/^Valorant_Clip_/, 'Clip_')
      .replace(/_/g, ' ');
  };

  const startRename = (e: MouseEvent, clip: ClipEntry) => {
    e.stopPropagation();
    setRenamingFile(clip.full_path);
    setRenameDraft(formatDisplayName(clip.file_name));
  };

  const commitRename = async (clip: ClipEntry) => {
    const val = renameDraft().trim();
    setRenamingFile(null);
    if (!val) return;
    await props.onRenameClip(clip, val);
  };

  const getClipBadge = (name: string) => {
    const lower = name.toLowerCase();
    if (lower.includes('ace') || lower.includes('5k')) {
      return { text: 'ACE • 5K', class: 'bg-[#FFFFFF] text-[#000000] border-[#FFFFFF]' };
    }
    if (lower.includes('quadra') || lower.includes('4k')) {
      return { text: 'QUADRA • 4K', class: 'bg-[#FFFFFF] text-[#000000] border-[#FFFFFF]/60' };
    }
    if (lower.includes('triple') || lower.includes('3k')) {
      return { text: 'TRIPLE • 3K', class: 'bg-[#FFFFFF]/85 text-[#FFFFFF] border-[#FFFFFF]' };
    }
    if (lower.includes('double') || lower.includes('2k')) {
      return { text: 'DOUBLE • 2K', class: 'bg-[#FFFFFF]/30 text-[#FFFFFF] border-[#FFFFFF]' };
    }
    if (lower.includes('death') || lower.includes('eliminated')) {
      return { text: 'DEATH LOG', class: 'bg-[#BDBDBD]/30 text-[#FFFFFF] border-[#BDBDBD]' };
    }
    return { text: '30S REPLAY', class: 'bg-[#000000] text-[#BDBDBD] border-[#333333]' };
  };

  return (
    <aside
      className="w-72 h-full min-h-0 bg-[#0A0B0E]/90 backdrop-blur-xl border-r border-[#2A2D34] flex flex-col select-none shrink-0"
      aria-label="Highlights Sidebar"
    >
      {/* Top Capture Trigger Header */}
      <div className="px-3 py-2.5 border-b border-[#2A2D34] flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className={`size-2 rounded-full ${props.isGameActive ? 'bg-[#3F88C5] animate-pulse' : 'bg-[#7C3AED]'}`} />
          <span className="font-black text-[11px] uppercase tracking-widest text-[#FFFFFF] font-mono tabular-nums">
            VAULT ({props.clips.length})
          </span>
        </div>

        <button
          type="button"
          onClick={props.onTriggerClip}
          disabled={props.isExporting}
          className="px-3 py-1 rounded-md text-[11px] font-black font-mono btn-tactile flex items-center gap-1.5 bg-[#7C3AED] hover:bg-[#9333EA] text-[#FFFFFF] shadow-sm border border-[#9333EA]/50 disabled:opacity-50"
          title="Flush Rolling 30s Hardware Buffer with Audio to Disk (or press F8 in-game)"
        >
          <Show
            when={props.isExporting}
            fallback={
              <>
                <svg class="size-3 text-current" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <circle cx="12" cy="12" r="9" />
                  <circle cx="12" cy="12" r="3" fill="currentColor" />
                </svg>
                <span>CLIP 30S (F8)</span>
              </>
            }
          >
            <span className="animate-pulse">SAVING...</span>
          </Show>
        </button>
      </div>

      {/* Filter and Search Box */}
      <div className="p-2.5 border-b border-[#2A2D34] flex flex-col gap-2 bg-[#0A0B0E]/95">
        <div className="relative">
          <label for="clip-search-input" className="sr-only">
            Search clips by name, agent, or weapon
          </label>
          <input
            id="clip-search-input"
            type="search"
            placeholder="Search clips, agents, or tags..."
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            className="w-full bg-[#12141A] border border-[#2A2D34] rounded-md pl-7 pr-2.5 py-1.5 text-[11px] text-[#FFFFFF] placeholder-[#CBD5E1]/40 focus:outline-none focus:border-[#9333EA] transition-colors font-mono"
          />
          <svg class="size-3 text-[#CBD5E1]/70 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>

        <div className="flex items-center gap-1.5 text-[10px] font-bold font-mono" role="tablist" aria-label="Clip category filters">
          <button
            type="button"
            role="tab"
            aria-selected={eventFilter() === 'all' && !props.isMontageMode}
            onClick={() => setEventFilter('all')}
            className={`flex-1 py-1 rounded btn-tactile text-center border ${
              eventFilter() === 'all' && !props.isMontageMode
                ? 'bg-[#7C3AED] text-[#FFFFFF] border-[#9333EA]/50 shadow-sm'
                : 'bg-[#12141A] text-[#CBD5E1] hover:text-[#FFFFFF] border-[#2A2D34]'
            }`}
          >
            All Clips
          </button>
          <button
            type="button"
            onClick={props.onToggleMontageMode}
            className={`px-3 py-1 rounded btn-tactile text-center border ${
              props.isMontageMode
                ? 'bg-[#3F88C5] text-[#FFFFFF] font-black border-[#3F88C5] shadow-sm'
                : 'bg-[#12141A] text-[#CBD5E1] hover:text-[#FFFFFF] border-[#2A2D34]'
            }`}
            title="Combine multiple highlights into a single reel"
          >
            Reel Montage
          </button>
        </div>
      </div>

      {/* Montage Action Banner */}
      <Show when={props.isMontageMode}>
        <div className="p-2.5 bg-[#000000] border-b border-[#FFFFFF] flex items-center justify-between animate-fadeIn">
          <div className="flex flex-col">
            <span className="text-[10px] font-bold text-[#FFFFFF] font-mono tabular-nums">
              REEL QUEUE: {props.selectedClipsForMontage.length} CLIPS
            </span>
            <span className="text-[9px] text-[#FFFFFF]/70">Select 2+ clips to stitch</span>
          </div>
          <button
            type="button"
            onClick={props.onCreateMontage}
            disabled={props.selectedClipsForMontage.length < 2 || props.isCreatingMontage}
            className="px-3 py-1 rounded bg-[#FFFFFF] hover:bg-[#FFFFFF]/90 text-[#000000] font-black text-[11px] font-mono btn-tactile disabled:opacity-40"
          >
            <Show when={props.isCreatingMontage} fallback={<span>STITCH</span>}>
              <span className="animate-pulse">STITCHING...</span>
            </Show>
          </button>
        </div>
      </Show>

      {/* Compact Clips List */}
      <div className="flex-1 overflow-y-auto p-2.5 flex flex-col gap-2 no-scrollbar" role="list">
        <Show
          when={filteredClips().length > 0}
          fallback={
            <div className="flex flex-col items-center justify-center p-8 text-center text-[#FFFFFF]/65 gap-2" role="status">
              <svg class="size-7 text-[#A3A3A3]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              <span className="text-xs font-bold text-[#FFFFFF] font-mono">NO CLIPS IN VAULT</span>
              <span className="text-[10px] text-[#FFFFFF]/60">Press F8 or click CLIP 30S to save</span>
            </div>
          }
        >
          <For each={filteredClips()}>
            {(clip) => {
              const isSelected = () => props.selectedClip?.full_path === clip.full_path;
              const isMontageSelected = () => props.selectedClipsForMontage.includes(clip.full_path);
              const badge = () => getClipBadge(clip.file_name);
              const isRenaming = () => renamingFile() === clip.full_path;

              return (
                <div
                  role="listitem"
                  tabIndex={0}
                  onClick={() => {
                    if (isRenaming()) return;
                    if (props.isMontageMode) {
                      props.onToggleSelectForMontage(clip.full_path);
                    } else {
                      props.onSelectClip(clip);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (isRenaming()) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      props.onSelectClip(clip);
                    }
                  }}
                  className={`p-2.5 rounded-lg border cursor-pointer transition-all duration-150 flex flex-col gap-1.5 relative group ${
                    isSelected()
                      ? 'bg-[#12141A] border-[#B91C1C] shadow-[0_0_14px_rgba(185,28,28,0.4)] ring-1 ring-[#B91C1C]/50'
                      : isMontageSelected()
                      ? 'bg-[#12141A] border-[#3F88C5]'
                      : 'bg-[#0A0B0E]/80 hover:bg-[#12141A] border-[#2A2D34] hover:border-[#B91C1C]/50'
                  }`}
                >
                  {/* Top Row: Title / Inline Rename & Quick Actions */}
                  <div className="flex items-center justify-between gap-1.5">
                    <Show
                      when={isRenaming()}
                      fallback={
                        <span
                          onDblClick={(e) => startRename(e, clip)}
                          className="text-[11px] font-bold text-[#FFFFFF] truncate font-mono tracking-tight"
                          title={`${clip.file_name} (Double-click to rename)`}
                        >
                          {formatDisplayName(clip.file_name)}
                        </span>
                      }
                    >
                      <input
                        type="text"
                        value={renameDraft()}
                        autofocus
                        onClick={(e) => e.stopPropagation()}
                        onInput={(e) => setRenameDraft(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') commitRename(clip);
                          if (e.key === 'Escape') setRenamingFile(null);
                        }}
                        onBlur={() => commitRename(clip)}
                        aria-label="New clip title"
                        className="w-full bg-[#1C1C1C] border border-[#FFFFFF] rounded px-2 py-0.5 text-[11px] text-[#FFFFFF] font-mono focus:outline-none"
                      />
                    </Show>

                    <div className="flex items-center gap-0.5 opacity-75 group-hover:opacity-100 transition-opacity shrink-0">
                      <button
                        type="button"
                        aria-label="Rename clip"
                        onClick={(e) => startRename(e, clip)}
                        className="p-1 rounded text-[#FFFFFF]/70 hover:text-[#FFFFFF] hover:bg-[#1C1C1C]"
                        title="Rename clip"
                      >
                        <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        aria-label="Share clip to clipboard"
                        onClick={(e) => props.onShareClip(e, clip)}
                        className="p-1 rounded text-[#FFFFFF]/70 hover:text-[#A3A3A3] hover:bg-[#1C1C1C]"
                        title="Copy clip file to clipboard"
                      >
                        <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <circle cx="18" cy="5" r="3" />
                          <circle cx="6" cy="12" r="3" />
                          <circle cx="18" cy="19" r="3" />
                          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        aria-label="Reveal clip in Explorer"
                        onClick={(e) => props.onOpenFolder(e, clip)}
                        className="p-1 rounded text-[#FFFFFF]/70 hover:text-[#FFFFFF] hover:bg-[#1C1C1C]"
                        title="Reveal in File Explorer"
                      >
                        <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        aria-label="Delete clip"
                        onClick={(e) => props.onDeleteClip(e, clip)}
                        className="p-1 rounded text-[#FFFFFF]/70 hover:text-[#FFFFFF] hover:bg-[#1C1C1C]"
                        title="Delete clip"
                      >
                        <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Middle Row: Date & File Size */}
                  <div className="flex items-center justify-between text-[10px] text-[#FFFFFF]/65 font-mono tabular-nums">
                    <span>{clip.created_at}</span>
                    <span className="text-[#FFFFFF]/85 font-semibold">{formatSize(clip.file_size_mb ?? 0)}</span>
                  </div>

                  {/* Bottom Row: Tags & Sync Status */}
                  <div className="flex items-center justify-between pt-0.5">
                    <span className={`px-1.5 py-0.5 rounded text-[8px] font-mono font-black border ${badge().class}`}>
                      {badge().text}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[8px] font-mono font-bold border ${
                        clip.has_timeline
                          ? 'bg-[#BDBDBD]/25 text-[#E5E5E5] border-[#FFFFFF]/60'
                          : 'bg-[#1C1C1C] text-[#FFFFFF]/60 border-[#333333]'
                      }`}
                    >
                      {clip.has_timeline ? 'MARKERS + AUDIO' : 'RAW'}
                    </span>
                  </div>
                </div>
              );
            }}
          </For>
        </Show>
      </div>
    </aside>
  );
}
