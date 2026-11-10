import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import { TimelineReviewer } from './components/TimelineReviewer';
import { SettingsPanel } from './components/SettingsPanel';
import { ClipOverlayNotification } from './components/ClipOverlayNotification';
import { UpdateModal } from './components/UpdateModal';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { SecurityStatus } from './types';

interface GameStatus {
  is_running: boolean;
  pid: number | null;
  process_name: string | null;
  riot_client_running: boolean;
  status_text: string;
}

export default function App() {
  const [activeTab, setActiveTab] = createSignal<'reviewer' | 'settings'>('reviewer');
  const [isMaximized, setIsMaximized] = createSignal(false);
  const [, setGameStatus] = createSignal<GameStatus>({
    is_running: false,
    pid: null,
    process_name: null,
    riot_client_running: false,
    status_text: 'Standby',
  });
  const [, setSecurityStatus] = createSignal<SecurityStatus>({
    cipher: 'AES-256-CTR + HMAC-SHA256',
    key_derivation: 'Hardware-Bound SHA-256 KDF',
    anti_interception_active: true,
    encrypted_vault_files: 0,
  });

  const checkStatus = async () => {
    try {
      const status = await invoke<GameStatus>('get_game_status');
      setGameStatus(status);
    } catch (e) {
      console.error('Failed to get game status', e);
    }
    try {
      const sec = await invoke<SecurityStatus>('get_security_status');
      setSecurityStatus(sec);
    } catch {
      // Fallback default
    }
  };

  onMount(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 5000);

    try {
      const win = getCurrentWindow();
      win.isMaximized().then((max) => setIsMaximized(max)).catch(() => {});
      win.onResized(() => {
        win.isMaximized().then((max) => setIsMaximized(max)).catch(() => {});
      }).catch(() => {});
    } catch {
      // running outside tauri
    }

    // Block right-click context menu & DevTools inspection hotkeys
    const blockContextMenu = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const blockInspectKeys = (e: KeyboardEvent) => {
      const k = (e.key || '').toUpperCase();
      const code = e.keyCode || e.which;
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      if (
        k === 'F12' ||
        code === 123 ||
        k === 'F5' ||
        code === 116 ||
        (ctrl && shift && (k === 'I' || k === 'J' || k === 'C' || k === 'K' || k === 'E' || k === 'M')) ||
        (ctrl && (k === 'U' || k === 'R' || k === 'P' || k === 'S'))
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('contextmenu', blockContextMenu, true);
    document.addEventListener('contextmenu', blockContextMenu, true);
    window.addEventListener('keydown', blockInspectKeys, true);

    onCleanup(() => {
      clearInterval(interval);
      window.removeEventListener('contextmenu', blockContextMenu, true);
      document.removeEventListener('contextmenu', blockContextMenu, true);
      window.removeEventListener('keydown', blockInspectKeys, true);
    });
  });

  const handleMinimize = async () => {
    try {
      await invoke('window_minimize');
    } catch {
      try {
        const win = getCurrentWindow();
        await win.minimize();
      } catch (e) {
        console.error(e);
      }
    }
  };

  const handleToggleMaximize = async () => {
    try {
      const max = await invoke<boolean>('window_toggle_maximize');
      setIsMaximized(max);
    } catch {
      try {
        const win = getCurrentWindow();
        await win.toggleMaximize();
        setIsMaximized(await win.isMaximized());
      } catch (e) {
        console.error(e);
      }
    }
  };

  const handleClose = async () => {
    try {
      await invoke('window_close');
    } catch {
      try {
        const win = getCurrentWindow();
        await win.close();
      } catch (e) {
        console.error(e);
      }
    }
  };

  const minimizeToTray = async () => {
    try {
      await invoke('minimize_to_tray');
    } catch {
      try {
        await invoke('trim_working_set');
        const win = getCurrentWindow();
        await win.hide();
      } catch (err) {
        console.error('Failed to minimize to tray:', err);
      }
    }
  };

  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className="relative flex flex-col h-dvh w-full select-none bg-[#07080B] text-[#FFFFFF] overflow-hidden font-sans"
    >
      {/* High-Performance Lightweight Tactical Cyber Grid Background (Zero GPU Overhead) */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-gradient-to-b from-[#0F1117] via-[#0A0B0E] to-[#050608]">
        <div className="absolute inset-0 bg-[radial-gradient(#7C3AED_1px,transparent_1px)] [background-size:32px_32px] opacity-10" />
      </div>

      {/* Compact Native Desktop Command Bar */}
      <header
        data-tauri-drag-region
        className="relative h-11 bg-[#0A0B0E]/95 border-b border-[#2A2D34] flex items-center justify-between px-3 z-40 shrink-0 gap-3 select-none"
      >
        <div className="flex items-center gap-3.5 min-w-0">
          {/* Animated Eclipse Brand Emblem */}
          <div data-tauri-drag-region className="flex items-center gap-2.5 shrink-0 py-0.5 select-none group cursor-default">
            <div className="relative flex items-center justify-center pointer-events-none">
              <img
                src="/eclipse-icon-transparent.png"
                alt="Eclipse"
                className="h-7 w-auto object-contain drop-shadow-[0_0_10px_rgba(168,85,247,0.6)] pointer-events-none"
              />
            </div>
            <div data-tauri-drag-region className="flex items-center gap-1.5 leading-none">
              <span className="font-black tracking-widest text-[13px] uppercase font-mono text-[#FFFFFF]">
                ECLIPSE
              </span>
              <span className="px-1.5 py-0.5 rounded text-[8px] font-black uppercase font-mono bg-[#7C3AED]/25 text-[#C084FC] border border-[#9333EA]/40">
                PRO
              </span>
            </div>
          </div>

          {/* Primary Navigation Tabs */}
          <nav className="flex items-center gap-1 bg-[#12141A]/90 p-0.5 rounded-lg border border-[#2A2D34]">
            <button
              type="button"
              onClick={() => setActiveTab('reviewer')}
              className={`px-3 py-1 rounded-md text-[11px] font-bold btn-tactile flex items-center gap-1.5 focus-visible:ring-2 focus-visible:ring-[#9333EA] focus-visible:outline-none transition-all ${
                activeTab() === 'reviewer'
                  ? 'bg-[#7C3AED] text-[#FFFFFF] shadow-sm border border-[#9333EA]/60 shadow-[0_0_12px_rgba(124,58,237,0.4)]'
                  : 'text-[#CBD5E1] hover:text-[#FFFFFF] hover:bg-[#1A1D24]'
              }`}
            >
              <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              <span>Studio &amp; Timeline</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('settings')}
              className={`px-3 py-1 rounded-md text-[11px] font-bold btn-tactile flex items-center gap-1.5 focus-visible:ring-2 focus-visible:ring-[#9333EA] focus-visible:outline-none transition-all ${
                activeTab() === 'settings'
                  ? 'bg-[#7C3AED] text-[#FFFFFF] shadow-sm border border-[#9333EA]/60 shadow-[0_0_12px_rgba(124,58,237,0.4)]'
                  : 'text-[#CBD5E1] hover:text-[#FFFFFF] hover:bg-[#1A1D24]'
              }`}
            >
              <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l.06-.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>Settings &amp; Engine</span>
            </button>
          </nav>
        </div>

        <div data-tauri-drag-region onDblClick={handleToggleMaximize} className="flex-1 h-full cursor-default" />

        <div className="flex items-center gap-2 shrink-0">
          {/* Background Tray Mode Button */}
          <button
            type="button"
            onClick={minimizeToTray}
            aria-label="Minimize to system tray"
            className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-bold text-[#FFFFFF] bg-[#12141A] hover:bg-[#7C3AED] rounded-md btn-tactile border border-[#2A2D34] hover:border-[#9333EA]/50 transition-all shadow-sm"
            title="Minimize to Windows System Tray"
          >
            <svg class="size-3 text-[#CBD5E1]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
            <span>Tray Mode</span>
          </button>

          {/* Window Control Buttons */}
          <div className="flex items-center gap-0.5 border-l border-[#2A2D34] pl-2">
            <button
              type="button"
              onClick={handleMinimize}
              aria-label="Minimize Window"
              className="size-7 rounded-md flex items-center justify-center text-[#CBD5E1] hover:text-[#FFFFFF] bg-transparent hover:bg-[#1A1D24] active:bg-[#252A35] focus:outline-none focus:bg-transparent transition-colors"
              title="Minimize"
            >
              <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleToggleMaximize}
              aria-label="Maximize Window"
              className="size-7 rounded-md flex items-center justify-center text-[#CBD5E1] hover:text-[#FFFFFF] bg-transparent hover:bg-[#1A1D24] active:bg-[#252A35] focus:outline-none focus:bg-transparent transition-colors"
              title={isMaximized() ? "Restore" : "Maximize"}
            >
              <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="4" y="4" width="16" height="16" rx="2" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close Window"
              className="size-7 rounded-md flex items-center justify-center text-[#CBD5E1] hover:text-[#FFFFFF] bg-transparent hover:bg-[#EF4444] active:bg-[#DC2626] focus:outline-none focus:bg-transparent transition-colors"
              title="Close"
            >
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {/* Main Responsive Desktop Workspace */}
      <main className="relative z-10 flex-1 min-h-0 w-full overflow-hidden">
        <Show when={activeTab() === 'reviewer'}>
          <TimelineReviewer onOpenSettings={() => setActiveTab('settings')} />
        </Show>
        <Show when={activeTab() === 'settings'}>
          <SettingsPanel />
        </Show>
      </main>

      {/* Global In-Game & Desktop Animated Clip HUD Notification Overlay */}
      <ClipOverlayNotification />

      {/* Cryptographically Signed Auto-Update Enforcement Modal */}
      <UpdateModal />
    </div>
  );
}
