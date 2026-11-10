import { createSignal, createEffect, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { ClipEntry } from '../types';
import eclipseBanner from '../assets/eclipse-banner-transparent.png';

interface ShareModalProps {
  clip: ClipEntry | null;
  isOpen: boolean;
  onClose: () => void;
  onToast: (msg: string, type: 'success' | 'info' | 'error') => void;
}

export function ShareModal(props: ShareModalProps) {
  const [copiedVideo, setCopiedVideo] = createSignal(false);
  const [downloaded, setDownloaded] = createSignal(false);
  const [isExporting, setIsExporting] = createSignal(false);

  createEffect(() => {
    if (props.isOpen && props.clip) {
      setCopiedVideo(false);
      setDownloaded(false);
      setIsExporting(false);
    }
  });

  const handleShareVideo = async () => {
    if (!props.clip) return;
    try {
      const msg = await invoke<string>('share_clip', { filePath: props.clip.full_path });
      setCopiedVideo(true);
      props.onToast(msg || 'Video copied to clipboard! Just press Ctrl+V in Discord to send.', 'success');
      setTimeout(() => setCopiedVideo(false), 3000);
    } catch (err: any) {
      const errorMsg = typeof err === 'string' ? err : 'Failed to copy video to clipboard';
      props.onToast(errorMsg, 'error');
    }
  };

  const handleDownload = async () => {
    if (!props.clip) return;
    setIsExporting(true);
    try {
      const destPath = await invoke<string>('export_clip_to_downloads', { filePath: props.clip.full_path });
      setDownloaded(true);
      props.onToast(`Saved to Downloads: ${destPath}`, 'success');
      setTimeout(() => setDownloaded(false), 3500);
    } catch (err: any) {
      const errorMsg = typeof err === 'string' ? err : 'Failed to save clip to Downloads';
      props.onToast(errorMsg, 'error');
    } finally {
      setIsExporting(false);
    }
  };

  const handleOpenFolder = async () => {
    if (!props.clip) return;
    try {
      await invoke('open_clip_folder', { filePath: props.clip.full_path });
    } catch {
      props.onToast('Could not open folder in File Explorer', 'error');
    }
  };

  return (
    <Show when={props.isOpen && props.clip}>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#000000]/80 backdrop-blur-md animate-fadeIn select-none"
        onClick={props.onClose}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-md rounded-2xl bg-[#0C0E14] border border-[#2A2D34] shadow-[0_24px_70px_rgba(0,0,0,0.95),0_0_30px_rgba(147,51,234,0.25)] p-5 sm:p-6 flex flex-col gap-4 overflow-hidden animate-popIn"
        >
          {/* Ambient Purple Light Rays */}
          <div className="absolute -top-24 -right-24 size-52 rounded-full bg-[#7C3AED]/18 blur-3xl pointer-events-none" />
          <div className="absolute -bottom-24 -left-24 size-52 rounded-full bg-[#3B82F6]/12 blur-3xl pointer-events-none" />

          {/* Modal Header with Software Logo */}
          <div className="relative z-10 flex items-center justify-between border-b border-[#2A2D34] pb-3.5">
            <div className="flex items-center gap-3">
              <div className="h-9 px-2 rounded-xl bg-[#12141A] border border-[#9333EA]/40 flex items-center justify-center shadow-sm">
                <img
                  src={eclipseBanner}
                  alt="Eclipse"
                  className="h-6 w-auto object-contain drop-shadow-[0_0_8px_rgba(168,85,247,0.5)]"
                />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-black font-mono tracking-wide text-white uppercase flex items-center gap-1.5">
                  <span>Share &amp; Export</span>
                  <span className="text-[9px] px-1.5 py-0.2 rounded bg-[#7C3AED]/30 text-[#C084FC] border border-[#9333EA]/50 font-bold">
                    LOCAL MP4
                  </span>
                </span>
                <span className="text-[11px] font-mono text-[#94A3B8] truncate max-w-xs">
                  {props.clip?.file_name}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={props.onClose}
              className="size-7 rounded-lg bg-[#1A1D24] hover:bg-[#2A2D34] active:scale-90 text-[#CBD5E1] hover:text-white flex items-center justify-center transition-all duration-150 btn-tactile"
              title="Close"
            >
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Clip Info Card */}
          <div className="relative z-10 bg-[#07080B] border border-[#2A2D34] rounded-xl p-3 flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="size-8 rounded-lg bg-[#7C3AED]/20 border border-[#9333EA]/40 flex items-center justify-center text-[#C084FC] shrink-0">
                <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-bold font-mono text-white truncate">
                  {props.clip?.file_name}
                </span>
                <span className="text-[10px] font-mono text-[#94A3B8]">
                  {props.clip?.file_size_mb.toFixed(1)} MB • {props.clip?.created_at}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleOpenFolder}
              className="px-2 py-1 rounded-md text-[10px] font-mono text-[#CBD5E1] hover:text-white bg-[#12141A] hover:bg-[#1A1D24] border border-[#2A2D34] transition-all btn-tactile flex items-center gap-1 shrink-0"
              title="Reveal original file in File Explorer"
            >
              <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span>Folder</span>
            </button>
          </div>

          {/* Primary Action 1: Share Video / Copy to Clipboard for Discord */}
          <div className="relative z-10 bg-[#07080B] border border-[#7C3AED]/40 hover:border-[#9333EA] rounded-xl p-3.5 flex flex-col gap-2.5 transition-all shadow-[0_0_16px_rgba(124,58,237,0.15)]">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5 min-w-0">
                <div className="size-8 rounded-lg bg-[#7C3AED] text-white flex items-center justify-center shrink-0 shadow-md">
                  <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="18" cy="5" r="3" />
                    <circle cx="6" cy="12" r="3" />
                    <circle cx="18" cy="19" r="3" />
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                  </svg>
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-black font-mono text-white">Share Video (Discord / Chat)</span>
                  <span className="text-[10px] text-[#94A3B8] leading-tight mt-0.5">
                    Copies the MP4 directly onto your Windows clipboard. Just press <kbd class="px-1 py-0.2 rounded bg-[#1A1D24] text-[#C084FC] border border-[#2A2D34] font-mono text-[9px]">Ctrl+V</kbd> in Discord, WhatsApp, or any chat to send.
                  </span>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleShareVideo}
              className={`w-full py-2.5 rounded-lg font-mono text-xs font-black transition-all duration-200 btn-tactile flex items-center justify-center gap-2 border shadow-lg ${
                copiedVideo()
                  ? 'bg-[#00D48F] text-black border-[#00D48F] shadow-[0_0_16px_rgba(0,212,143,0.5)] scale-[1.02]'
                  : 'bg-gradient-to-r from-[#7C3AED] to-[#9333EA] hover:opacity-95 text-white border-[#C084FC]/40 shadow-[0_0_20px_rgba(147,51,234,0.35)]'
              }`}
            >
              <Show
                when={copiedVideo()}
                fallback={
                  <>
                    <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    <span>Copy Video File (Discord Ctrl+V)</span>
                  </>
                }
              >
                <svg class="size-4 animate-bounce" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>Copied! Ready to Paste (Ctrl+V)</span>
              </Show>
            </button>
          </div>

          {/* Primary Action 2: Download / Save to Downloads Folder */}
          <div className="relative z-10 bg-[#07080B] border border-[#2A2D34] hover:border-[#3B82F6]/60 rounded-xl p-3.5 flex flex-col gap-2.5 transition-all">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5 min-w-0">
                <div className="size-8 rounded-lg bg-[#3B82F6]/20 border border-[#3B82F6]/40 text-[#60A5FA] flex items-center justify-center shrink-0 shadow-sm">
                  <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-black font-mono text-white">Download to Folder</span>
                  <span className="text-[10px] text-[#94A3B8] leading-tight mt-0.5">
                    Saves a copy of the MP4 directly into your Windows Downloads folder and reveals it in File Explorer.
                  </span>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleDownload}
              disabled={isExporting()}
              className={`w-full py-2.5 rounded-lg font-mono text-xs font-black transition-all duration-200 btn-tactile flex items-center justify-center gap-2 border shadow-sm ${
                downloaded()
                  ? 'bg-[#00D48F] text-black border-[#00D48F] shadow-[0_0_16px_rgba(0,212,143,0.5)] scale-[1.02]'
                  : 'bg-[#161922] hover:bg-[#3B82F6] text-white border-[#2A2D34] hover:border-[#60A5FA]/60'
              }`}
            >
              <Show
                when={downloaded()}
                fallback={
                  <>
                    <Show
                      when={isExporting()}
                      fallback={
                        <>
                          <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                          </svg>
                          <span>Save to Downloads</span>
                        </>
                      }
                    >
                      <svg class="size-4 animate-spin text-[#60A5FA]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
                        <path d="M12 2a10 10 0 0 1 10 10" />
                      </svg>
                      <span>Saving to Downloads...</span>
                    </Show>
                  </>
                }
              >
                <svg class="size-4 animate-bounce" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span>Saved to Downloads!</span>
              </Show>
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
