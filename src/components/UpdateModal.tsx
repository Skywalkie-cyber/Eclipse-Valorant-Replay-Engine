import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface UpdateInfo {
  available: boolean;
  current_version: string;
  version: string;
  body?: string;
  date?: string;
}

interface DownloadProgress {
  downloaded_bytes: number;
  total_bytes?: number;
  percent: number;
}

export function UpdateModal() {
  const [updateInfo, setUpdateInfo] = createSignal<UpdateInfo | null>(null);
  const [isUpdating, setIsUpdating] = createSignal(false);
  const [downloadProgress, setDownloadProgress] = createSignal<DownloadProgress | null>(null);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  const [isMandatory] = createSignal(true); // User requested: "else it should not work at all"

  // Check for updates on startup
  onMount(() => {
    const checkForUpdates = async () => {
      try {
        const update = await invoke<UpdateInfo | null>('check_for_updates');
        if (update && update.available) {
          setUpdateInfo(update);
        }
      } catch (err: any) {
        // Silently ignore offline or unreleased repository checks on launch
        console.warn('[Auto-Updater] Initial check note:', err);
      }
    };

    // Run check 2 seconds after startup to ensure smooth initial render
    const initialTimer = setTimeout(checkForUpdates, 2000);

    // Periodically re-check every 30 minutes
    const periodicTimer = setInterval(checkForUpdates, 30 * 60 * 1000);

    // Listen for download progress events emitted from native Rust updater
    let unlistenProgress: (() => void) | null = null;
    listen<DownloadProgress>('update-download-progress', (event) => {
      setDownloadProgress(event.payload);
    })
      .then((unsub) => {
        unlistenProgress = unsub;
      })
      .catch(() => {});

    // Allow manual trigger from Settings panel
    const handleManualUpdateEvent = (e: Event) => {
      const custom = e as CustomEvent;
      if (custom.detail) {
        setUpdateInfo(custom.detail);
      }
    };
    window.addEventListener('eclipse:show-update-modal', handleManualUpdateEvent);

    onCleanup(() => {
      clearTimeout(initialTimer);
      clearInterval(periodicTimer);
      if (unlistenProgress) unlistenProgress();
      window.removeEventListener('eclipse:show-update-modal', handleManualUpdateEvent);
    });
  });

  const handleStartUpdate = async () => {
    setIsUpdating(true);
    setErrorMessage(null);
    try {
      await invoke('install_update');
    } catch (err: any) {
      console.error('[Auto-Updater] Installation error:', err);
      setErrorMessage(String(err));
      setIsUpdating(false);
    }
  };

  const formatMB = (bytes: number) => {
    return (bytes / (1024 * 1024)).toFixed(1);
  };

  return (
    <Show when={updateInfo()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-modal-title"
        className="fixed inset-0 z-[999999] flex items-center justify-center p-4 bg-black/85 backdrop-blur-md select-none animate-fadeIn"
      >
        <div className="relative w-full max-w-lg rounded-2xl bg-[#0A0B0E] border-2 border-[#9333EA] p-6 shadow-[0_25px_60px_rgba(0,0,0,0.95),0_0_40px_rgba(147,51,234,0.4)] flex flex-col gap-5 overflow-hidden animate-popIn">
          {/* Ambient Glow Rays */}
          <div className="absolute -right-16 -top-16 size-48 rounded-full bg-[#7C3AED]/20 blur-3xl pointer-events-none" />
          <div className="absolute -left-16 -bottom-16 size-48 rounded-full bg-[#3B82F6]/15 blur-3xl pointer-events-none" />

          {/* Header */}
          <div className="relative z-10 flex items-start justify-between border-b border-[#2A2D34] pb-4">
            <div className="flex items-center gap-3">
              <div className="size-11 rounded-xl bg-gradient-to-br from-[#7C3AED] to-[#9333EA] flex items-center justify-center shadow-[0_0_16px_rgba(147,51,234,0.5)] border border-[#C084FC]/40 shrink-0">
                <svg class="size-6 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </div>
              <div className="flex flex-col">
                <div className="flex items-center gap-2">
                  <h2 id="update-modal-title" className="text-sm font-black font-mono tracking-wider text-white uppercase">
                    MANDATORY UPDATE REQUIRED
                  </h2>
                  <span className="size-2 rounded-full bg-[#00D48F] animate-ping" />
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  A new signed build of Eclipse is ready on GitHub.
                </p>
              </div>
            </div>

            <span className="px-2.5 py-1 rounded-md text-[10px] font-mono font-bold bg-[#7C3AED]/25 text-[#E9D5FF] border border-[#9333EA]/50 uppercase tracking-wider">
              {updateInfo()!.version}
            </span>
          </div>

          {/* Version Comparison Card */}
          <div className="relative z-10 grid grid-cols-2 gap-3 p-3.5 rounded-xl bg-[#12141A] border border-[#2A2D34]">
            <div className="flex flex-col">
              <span className="text-[10px] font-mono uppercase text-slate-500 font-semibold">Installed Version</span>
              <span className="text-xs font-mono font-bold text-slate-300 mt-0.5">
                v{updateInfo()!.current_version}
              </span>
            </div>
            <div className="flex flex-col border-l border-[#2A2D34] pl-3.5">
              <span className="text-[10px] font-mono uppercase text-[#C084FC] font-semibold">Target Release</span>
              <span className="text-xs font-mono font-black text-[#00D48F] mt-0.5 flex items-center gap-1.5">
                v{updateInfo()!.version}
                <span className="text-[8.5px] px-1.5 py-0.2 rounded bg-[#00D48F]/20 text-[#00D48F] border border-[#00D48F]/40 font-mono font-bold uppercase">
                  Signed
                </span>
              </span>
            </div>
          </div>

          {/* Release Notes Preview */}
          <div className="relative z-10 flex flex-col gap-1.5">
            <span className="text-[10px] font-mono uppercase font-bold text-slate-400 tracking-wider">
              Release Notes &amp; Highlights
            </span>
            <div className="max-h-36 overflow-y-auto no-scrollbar rounded-xl bg-[#000000] border border-[#2A2D34] p-3 text-xs text-slate-300 font-mono leading-relaxed whitespace-pre-wrap">
              {updateInfo()!.body || 'Performance optimizations, Vanguard telemetry synchronization, and security hardening.'}
            </div>
          </div>

          {/* Cryptographic Ed25519 Security Notice */}
          <div className="relative z-10 flex items-center gap-2 p-2.5 rounded-lg bg-[#000000] border border-[#9333EA]/30 text-[10px] font-mono text-slate-400">
            <svg class="size-4 text-[#C084FC] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span>
              <strong className="text-white">Minisign Verified:</strong> Signed with developer Ed25519 key. Untrusted or tampered updates will be rejected.
            </span>
          </div>

          {/* Error Message if download failed */}
          <Show when={errorMessage()}>
            <div className="relative z-10 p-3 rounded-lg bg-[#EF4444]/15 border border-[#EF4444]/40 text-xs font-mono text-[#F87171]">
              {errorMessage()}
            </div>
          </Show>

          {/* Progress Bar during Download & Installation */}
          <Show when={isUpdating()}>
            <div className="relative z-10 flex flex-col gap-2 p-3 rounded-xl bg-[#12141A] border border-[#9333EA]/50 animate-fadeIn">
              <div className="flex justify-between text-xs font-mono">
                <span className="text-white font-bold flex items-center gap-2">
                  <span className="size-2 rounded-full bg-[#9333EA] animate-ping" />
                  Downloading &amp; Verifying Package...
                </span>
                <span className="text-[#C084FC] font-black">
                  {downloadProgress() ? `${downloadProgress()!.percent.toFixed(0)}%` : 'Initializing...'}
                </span>
              </div>
              <div className="relative w-full h-2 rounded-full bg-[#000000] overflow-hidden border border-[#2A2D34]">
                <div
                  className="h-full bg-gradient-to-r from-[#7C3AED] via-[#9333EA] to-[#00D48F] transition-all duration-200"
                  style={{ width: `${downloadProgress() ? downloadProgress()!.percent : 15}%` }}
                />
              </div>
              <Show when={downloadProgress() && downloadProgress()!.total_bytes}>
                <div className="flex justify-between text-[10px] font-mono text-slate-500">
                  <span>{formatMB(downloadProgress()!.downloaded_bytes)} MB downloaded</span>
                  <span>{formatMB(downloadProgress()!.total_bytes!)} MB total</span>
                </div>
              </Show>
            </div>
          </Show>

          {/* Actions */}
          <div className="relative z-10 flex items-center gap-3 pt-2">
            <button
              type="button"
              disabled={isUpdating()}
              onClick={handleStartUpdate}
              className={`flex-1 py-3 px-4 rounded-xl text-xs font-black font-mono uppercase tracking-wider transition-all flex items-center justify-center gap-2 shadow-lg btn-tactile ${
                isUpdating()
                  ? 'bg-[#2A2D34] text-slate-500 cursor-not-allowed border border-transparent'
                  : 'bg-gradient-to-r from-[#7C3AED] via-[#9333EA] to-[#A855F7] hover:brightness-110 active:scale-[0.98] text-white border border-[#C084FC]/40 shadow-[0_0_20px_rgba(147,51,234,0.5)]'
              }`}
            >
              <Show
                when={!isUpdating()}
                fallback={
                  <>
                    <svg class="size-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                      <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
                      <path d="M12 2a10 10 0 0 1 10 10" />
                    </svg>
                    <span>INSTALLING &amp; RESTARTING...</span>
                  </>
                }
              >
                <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>UPDATE ECLIPSE NOW</span>
              </Show>
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}

