import { createSignal, onMount, onCleanup, Show, For } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { playSoftClipChime } from '../utils/audioChime';
import { notifyClipTriggered } from './ClipOverlayNotification';

export interface AppConfig {
  mode: 'instantreplay' | 'fullmatchvod';
  resolution: 'native' | 'res4k' | 'res1440p' | 'res1080p' | 'res720p';
  target_fps: number;
  target_bitrate_kbps: number;
  buffer_length_seconds: number;
  encoder: 'auto' | 'nvenc' | 'amf' | 'qsv' | 'cpu';
  audio: {
    capture_game_audio: boolean;
    game_audio_volume: number;
    capture_system_audio?: boolean;
    system_audio_volume?: number;
    capture_microphone: boolean;
    mic_volume: number;
    separate_audio_tracks: boolean;
    push_to_talk: boolean;
  };
  auto_clip_kills: boolean;
  auto_clip_headshots: boolean;
  auto_clip_multikills: boolean;
  auto_clip_deaths: boolean;
  auto_clip_spike_events: boolean;
  post_roll_seconds: number;
  clip_save_directory: string;
  hotkey_vk_code: number;
  hotkey_label: string;
  hotkey_modifiers?: number;
  hotkey_mark_in?: string;
  hotkey_mark_out?: string;
  hotkey_play_pause?: string;
  max_storage_gb: number;
  auto_delete_days: number;
  low_memory_mode: boolean;
  faststart_movflags: boolean;
  flip_vertical: boolean;
}

export function SettingsPanel() {
  const [config, setConfig] = createSignal<AppConfig | null>(null);
  const [saveStatus, setSaveStatus] = createSignal<string>('');
  const [activeTab, setActiveTab] = createSignal<'video' | 'audio' | 'triggers' | 'hotkeys' | 'storage' | 'updates'>('video');
  const [overlayEnabled, setOverlayEnabled] = createSignal(
    localStorage.getItem('eclipse_overlay_enabled') !== 'false'
  );
  const [soundEnabled, setSoundEnabled] = createSignal(
    localStorage.getItem('eclipse_overlay_sound') !== 'false'
  );

  const [updateCheckStatus, setUpdateCheckStatus] = createSignal<'idle' | 'checking' | 'available' | 'latest' | 'error'>('idle');
  const [updatePayload, setUpdatePayload] = createSignal<any>(null);
  const [updateError, setUpdateError] = createSignal<string>('');

  const checkUpdatesManually = async () => {
    setUpdateCheckStatus('checking');
    setUpdateError('');
    try {
      const res: any = await invoke('check_for_updates');
      if (res && res.available) {
        setUpdateCheckStatus('available');
        setUpdatePayload(res);
        const ev = new CustomEvent('eclipse:show-update-modal', { detail: res });
        window.dispatchEvent(ev);
      } else {
        setUpdateCheckStatus('latest');
      }
    } catch (e: any) {
      console.warn('[Updater] Manual check notice:', e);
      setUpdateCheckStatus('error');
      setUpdateError(String(e));
    }
  };

  let scrollContainerRef: HTMLDivElement | undefined;
  let isProgrammaticScroll = false;
  let scrollTimeout: any = null;

  const sectionIds: ('video' | 'audio' | 'triggers' | 'hotkeys' | 'storage' | 'updates')[] = [
    'video',
    'audio',
    'triggers',
    'hotkeys',
    'storage',
    'updates',
  ];

  const handleScroll = () => {
    if (isProgrammaticScroll || !scrollContainerRef) return;
    const containerTop = scrollContainerRef.getBoundingClientRect().top;

    let activeId = sectionIds[0];
    for (const id of sectionIds) {
      const el = document.getElementById(`settings-${id}`);
      if (el) {
        const rect = el.getBoundingClientRect();
        if (rect.top - containerTop <= 140) {
          activeId = id;
        }
      }
    }
    if (activeTab() !== activeId) {
      setActiveTab(activeId);
    }
  };

  const toggleOverlay = (enabled: boolean) => {
    setOverlayEnabled(enabled);
    localStorage.setItem('eclipse_overlay_enabled', String(enabled));
  };

  const toggleSound = (enabled: boolean) => {
    setSoundEnabled(enabled);
    localStorage.setItem('eclipse_overlay_sound', String(enabled));
  };

  onMount(async () => {
    try {
      const cfg = await invoke<AppConfig>('get_config');
      setConfig(cfg);
    } catch (err) {
      console.error('Failed to get config:', err);
    }

    const onKeyDownListener = (e: KeyboardEvent) => {
      handleGlobalKeyDown(e);
    };
    window.addEventListener('keydown', onKeyDownListener, true);
    onCleanup(() => {
      window.removeEventListener('keydown', onKeyDownListener, true);
    });
  });

  const [recordingHotkey, setRecordingHotkey] = createSignal<'manual_clip' | 'mark_in' | 'mark_out' | 'play_pause' | null>(null);

  const parseKeyEvent = (e: KeyboardEvent): { label: string; vkCode: number; modifiers: number } | null => {
    // Ignore stand-alone modifier key presses so user can press Ctrl then another key
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
      return null;
    }

    const parts: string[] = [];
    let modifiers = 0;

    if (e.ctrlKey) {
      parts.push('Ctrl');
      modifiers |= 2;
    }
    if (e.altKey) {
      parts.push('Alt');
      modifiers |= 1;
    }
    if (e.shiftKey) {
      parts.push('Shift');
      modifiers |= 4;
    }
    if (e.metaKey) {
      parts.push('Win');
      modifiers |= 8;
    }

    let keyName = e.key;
    let vkCode = e.keyCode || e.which || 0x77;

    if (e.code.startsWith('Key')) {
      keyName = e.code.replace('Key', '').toUpperCase();
      vkCode = keyName.charCodeAt(0);
    } else if (e.code.startsWith('Digit')) {
      keyName = e.code.replace('Digit', '');
      vkCode = 0x30 + parseInt(keyName, 10);
    } else if (e.code.startsWith('Numpad')) {
      keyName = 'Num ' + e.code.replace('Numpad', '');
    } else if (/^F\d+$/i.test(e.code)) {
      keyName = e.code.toUpperCase();
      const fNum = parseInt(keyName.replace('F', ''), 10);
      vkCode = 0x70 + (fNum - 1);
    } else if (e.code === 'Space') {
      keyName = 'Space';
      vkCode = 0x20;
    } else if (e.code === 'BracketLeft') {
      keyName = '[';
      vkCode = 0xDB;
    } else if (e.code === 'BracketRight') {
      keyName = ']';
      vkCode = 0xDD;
    } else if (e.code === 'Backslash') {
      keyName = '\\';
      vkCode = 0xDC;
    } else if (e.code === 'Semicolon') {
      keyName = ';';
      vkCode = 0xBA;
    } else if (e.code === 'Quote') {
      keyName = "'";
      vkCode = 0xDE;
    } else if (e.code === 'Comma') {
      keyName = ',';
      vkCode = 0xBC;
    } else if (e.code === 'Period') {
      keyName = '.';
      vkCode = 0xBE;
    } else if (e.code === 'Slash') {
      keyName = '/';
      vkCode = 0xBF;
    } else if (e.code === 'Minus') {
      keyName = '-';
      vkCode = 0xBD;
    } else if (e.code === 'Equal') {
      keyName = '=';
      vkCode = 0xBB;
    } else if (e.code === 'Backquote') {
      keyName = '`';
      vkCode = 0xC0;
    } else if (e.code === 'Tab') {
      keyName = 'Tab';
      vkCode = 0x09;
    } else if (e.code === 'Enter') {
      keyName = 'Enter';
      vkCode = 0x0D;
    } else if (e.code === 'Backspace') {
      keyName = 'Backspace';
      vkCode = 0x08;
    } else if (e.code === 'Insert') {
      keyName = 'Insert';
      vkCode = 0x2D;
    } else if (e.code === 'Delete') {
      keyName = 'Delete';
      vkCode = 0x2E;
    } else if (e.code === 'Home') {
      keyName = 'Home';
      vkCode = 0x24;
    } else if (e.code === 'End') {
      keyName = 'End';
      vkCode = 0x23;
    } else if (e.code === 'PageUp') {
      keyName = 'PageUp';
      vkCode = 0x21;
    } else if (e.code === 'PageDown') {
      keyName = 'PageDown';
      vkCode = 0x22;
    } else {
      keyName = keyName.length === 1 ? keyName.toUpperCase() : keyName;
    }

    parts.push(keyName);

    return {
      label: parts.join(' + '),
      vkCode,
      modifiers,
    };
  };

  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    const target = recordingHotkey();
    if (!target) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      setRecordingHotkey(null);
      return;
    }

    const res = parseKeyEvent(e);
    if (!res) return;

    const cur = config();
    if (!cur) return;

    const updated = { ...cur };
    if (target === 'manual_clip') {
      updated.hotkey_label = res.label;
      updated.hotkey_vk_code = res.vkCode;
      updated.hotkey_modifiers = res.modifiers;
    } else if (target === 'mark_in') {
      updated.hotkey_mark_in = res.label;
    } else if (target === 'mark_out') {
      updated.hotkey_mark_out = res.label;
    } else if (target === 'play_pause') {
      updated.hotkey_play_pause = res.label;
    }

    setConfig(updated);
    setRecordingHotkey(null);

    invoke('update_config', { newConfig: updated }).catch((err) => console.error('Failed to update config:', err));
    localStorage.setItem('eclipse_hotkey_mark_in', updated.hotkey_mark_in || '[');
    localStorage.setItem('eclipse_hotkey_mark_out', updated.hotkey_mark_out || ']');
    localStorage.setItem('eclipse_hotkey_play_pause', updated.hotkey_play_pause || 'Space');
    window.dispatchEvent(new CustomEvent('eclipse:hotkeys-updated', { detail: updated }));
    setSaveStatus(`Saved hotkey: ${res.label}`);
    setTimeout(() => setSaveStatus(''), 2500);
  };

  const resetHotkey = (target: 'manual_clip' | 'mark_in' | 'mark_out' | 'play_pause') => {
    const cur = config();
    if (!cur) return;
    const updated = { ...cur };
    if (target === 'manual_clip') {
      updated.hotkey_label = 'F8';
      updated.hotkey_vk_code = 0x77;
      updated.hotkey_modifiers = 0;
    } else if (target === 'mark_in') {
      updated.hotkey_mark_in = '[';
    } else if (target === 'mark_out') {
      updated.hotkey_mark_out = ']';
    } else if (target === 'play_pause') {
      updated.hotkey_play_pause = 'Space';
    }
    setConfig(updated);
    invoke('update_config', { newConfig: updated }).catch(() => { });
    localStorage.setItem('eclipse_hotkey_mark_in', updated.hotkey_mark_in || '[');
    localStorage.setItem('eclipse_hotkey_mark_out', updated.hotkey_mark_out || ']');
    localStorage.setItem('eclipse_hotkey_play_pause', updated.hotkey_play_pause || 'Space');
    window.dispatchEvent(new CustomEvent('eclipse:hotkeys-updated', { detail: updated }));
    setSaveStatus(`Reset hotkey to default!`);
    setTimeout(() => setSaveStatus(''), 2500);
  };

  let autoSaveTimeout: any = null;
  const updateConfigField = (updater: (prev: AppConfig) => AppConfig, immediate = true) => {
    const cur = config();
    if (!cur) return;
    const updated = updater(cur);
    setConfig(updated);

    if (immediate) {
      invoke('update_config', { newConfig: updated })
        .then(() => {
          setSaveStatus('Auto-saved & active!');
          if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
          autoSaveTimeout = setTimeout(() => setSaveStatus(''), 2000);
        })
        .catch((err) => {
          console.error('Failed to auto-save config:', err);
          setSaveStatus(`Save Error: ${err}`);
        });
    } else {
      if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
      autoSaveTimeout = setTimeout(() => {
        invoke('update_config', { newConfig: updated })
          .then(() => {
            setSaveStatus('Auto-saved & active!');
            autoSaveTimeout = setTimeout(() => setSaveStatus(''), 2000);
          })
          .catch((err) => {
            console.error('Failed to auto-save config:', err);
            setSaveStatus(`Save Error: ${err}`);
          });
      }, 350);
    }
  };

  const saveSettings = async () => {
    const current = config();
    if (!current) return;
    try {
      await invoke('update_config', { newConfig: current });
      setSaveStatus('Saved & Hot-Reloaded!');
      setTimeout(() => setSaveStatus(''), 2500);
    } catch (err) {
      setSaveStatus(`Error: ${err}`);
    }
  };

  const tabs = [
    { id: 'video', label: 'Video & Capture', icon: 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z' },
    { id: 'audio', label: 'Audio & Voice', icon: 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z' },
    { id: 'triggers', label: 'Smart Clipping', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
    { id: 'hotkeys', label: 'Hotkeys', icon: 'M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4' },
    { id: 'storage', label: 'Storage & RAM', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4' },
    { id: 'updates', label: 'Software Updates', icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15' },
  ] as const;

  return (
    <div className="flex-1 h-full bg-transparent text-[#FFFFFF] flex overflow-hidden">
      {/* Settings Navigation Sidebar */}
      <div className="w-64 bg-[#0A0B0E]/85 backdrop-blur-xl border-r border-[#2A2D34] flex flex-col p-4 shrink-0 select-none">
        <div className="mb-5 px-2">
          <span className="text-xs font-bold font-mono tracking-wider text-[#C084FC] uppercase">CONFIGURATION</span>
          <h2 className="text-sm font-bold text-[#FFFFFF] mt-0.5">Settings &amp; Preferences</h2>
        </div>

        <nav className="flex flex-col gap-1.5 flex-1">
          <For each={tabs}>
            {(tab) => (
              <button
                type="button"
                onClick={() => {
                  setActiveTab(tab.id as any);
                  isProgrammaticScroll = true;
                  document.getElementById(`settings-${tab.id}`)?.scrollIntoView({ behavior: 'smooth' });
                  if (scrollTimeout) clearTimeout(scrollTimeout);
                  scrollTimeout = setTimeout(() => {
                    isProgrammaticScroll = false;
                  }, 600);
                }}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium transition-all duration-150 text-left btn-tactile ${activeTab() === tab.id
                    ? 'bg-[#7C3AED] text-[#FFFFFF] border border-[#9333EA]/50 shadow-[0_2px_8px_rgba(0,0,0,0.5)] font-bold'
                    : 'text-[#CBD5E1] hover:text-[#FFFFFF] hover:bg-[#12141A]'
                  }`}
              >
                <svg class="size-4 shrink-0 text-[#FFFFFF]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round" d={tab.icon} />
                </svg>
                <span>{tab.label}</span>
              </button>
            )}
          </For>
        </nav>

        {/* Global Save Button at bottom of sidebar */}
        <div className="pt-4 border-t border-[#2A2D34]">
          <Show when={saveStatus()}>
            <div className="text-[11px] text-[#3F88C5] font-mono font-bold mb-2 text-center animate-fadeIn">{saveStatus()}</div>
          </Show>
          <button
            type="button"
            onClick={saveSettings}
            className="w-full py-2.5 bg-[#7C3AED] hover:bg-[#9333EA] active:scale-[0.98] text-[#FFFFFF] text-xs font-black rounded-lg shadow-md transition-all flex items-center justify-center gap-2 border border-[#9333EA]/50 font-mono tracking-wider btn-tactile"
          >
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            <span>SAVE ALL SETTINGS</span>
          </button>
        </div>
      </div>

      {/* Main Settings Content - All Settings Visible in Unified Flow */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-8 max-w-4xl scrollbar-thin"
      >
        <Show when={config()}>
          <div className="space-y-8">
            {/* SECTION 1: Video & Capture */}
            <div id="settings-video" className="space-y-6">
              <div>
                <h1 className="text-base font-bold text-white tracking-wide uppercase font-mono">Video &amp; Encoder Settings</h1>
                <p className="text-xs text-slate-400 mt-1">Configure zero-copy DXGI Desktop Duplication, hardware encoder silicon, and frame pacing.</p>
              </div>

              {/* Recording Mode */}
              <div className="bg-[#0A0A0A]/70 border border-[#262626] rounded-xl p-5 shadow-sm space-y-3">
                <label className="text-xs font-bold text-white uppercase tracking-wider font-mono">Recording Architecture</label>
                <div className="grid grid-cols-2 gap-3.5">
                  <button
                    type="button"
                    onClick={() => setConfig({ ...config()!, mode: 'instantreplay' })}
                    className={`p-3.5 rounded-lg border text-left transition-all duration-150 ${config()!.mode === 'instantreplay'
                        ? 'bg-[#0A0A0A] border-[#FFFFFF] text-white shadow-[0_0_12px_rgba(255,255,255,0.15)]'
                        : 'bg-[#000000] border-[#141414] text-slate-400 hover:text-white hover:bg-[#0A0A0A]'
                      }`}
                  >
                    <div className="font-bold text-xs">Instant Replay (Rolling Ring Buffer)</div>
                    <div className="text-[11px] text-slate-400 mt-1 leading-relaxed">Continuous hardware spooler. Saves the past 15s to 120s instantly upon elimination or hotkey.</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfig({ ...config()!, mode: 'fullmatchvod' })}
                    className={`p-3.5 rounded-lg border text-left transition-all duration-150 ${config()!.mode === 'fullmatchvod'
                        ? 'bg-[#0A0A0A] border-[#FFFFFF] text-white shadow-[0_0_12px_rgba(255,255,255,0.15)]'
                        : 'bg-[#000000] border-[#141414] text-slate-400 hover:text-white hover:bg-[#0A0A0A]'
                      }`}
                  >
                    <div className="font-bold text-xs">Full Match VOD</div>
                    <div className="text-[11px] text-slate-400 mt-1 leading-relaxed">Records entire match from round 1 to victory with synchronized timeline event markers.</div>
                  </button>
                </div>
              </div>

              {/* Resolution & FPS */}
              <div className="bg-[#0A0A0A]/70 border border-[#262626] rounded-xl p-5 space-y-4 shadow-sm">
                <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">Resolution & Frame Cadence</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs text-slate-400 block mb-1.5 font-medium">Capture Resolution</label>
                    <select
                      value={config()!.resolution}
                      onChange={(e) => setConfig({ ...config()!, resolution: e.currentTarget.value as any })}
                      className="w-full bg-[#000000] border border-[#262626] rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-[#FFFFFF]"
                    >
                      <option value="native">Native Display (Source Resolution)</option>
                      <option value="res4k">4K Ultra HD (3840x2160)</option>
                      <option value="res1440p">1440p QHD (2560x1440)</option>
                      <option value="res1080p">1080p Full HD (1920x1080 - Recommended)</option>
                      <option value="res720p">720p HD (1280x720)</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-xs text-slate-400 block mb-1.5 font-medium">Target Framerate</label>
                    <select
                      value={config()!.target_fps}
                      onChange={(e) => setConfig({ ...config()!, target_fps: Number(e.currentTarget.value) })}
                      className="w-full bg-[#000000] border border-[#262626] rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-[#FFFFFF]"
                    >
                      <option value="30">30 FPS (Low CPU/GPU overhead)</option>
                      <option value="60">60 FPS (Competitive Standard)</option>
                      <option value="120">120 FPS (High Refresh Rate)</option>
                      <option value="144">144 FPS (Esports Fluidity)</option>
                    </select>
                  </div>
                </div>

                {/* Bitrate Interactive Slider */}
                <div className="pt-2">
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-slate-400 font-medium">Encoding Bitrate (VBR)</span>
                    <span className="font-mono tabular-nums text-white font-bold">{(config()!.target_bitrate_kbps / 1000).toFixed(0)} Mbps</span>
                  </div>
                  <input
                    type="range"
                    min="5000"
                    max="100000"
                    step="2500"
                    value={config()!.target_bitrate_kbps}
                    onInput={(e) => setConfig({ ...config()!, target_bitrate_kbps: Number(e.currentTarget.value) })}
                    className="w-full accent-[#A3A3A3] cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-slate-500 mt-1 font-mono">
                    <span>5 Mbps (Compact)</span>
                    <span>25 Mbps (Crisp 1080p)</span>
                    <span>50 Mbps (1440p)</span>
                    <span>100 Mbps (Lossless 4K)</span>
                  </div>
                </div>

                {/* Buffer Length Slider */}
                <div className="pt-2">
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-slate-400 font-medium">Rolling Buffer Duration</span>
                    <span className="font-mono tabular-nums text-white font-bold">{config()!.buffer_length_seconds} Seconds</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="3"
                    step="1"
                    value={
                      (() => {
                        const s = config()!.buffer_length_seconds;
                        if (s <= 15) return 0;
                        if (s <= 30) return 1;
                        if (s <= 60) return 2;
                        return 3;
                      })()
                    }
                    onInput={(e) => {
                      const presets = [15, 30, 60, 120];
                      const val = presets[Number(e.currentTarget.value)] || 30;
                      setConfig({ ...config()!, buffer_length_seconds: val });
                    }}
                    className="w-full accent-[#A3A3A3] cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-slate-500 mt-1 font-mono select-none">
                    <button
                      type="button"
                      onClick={() => setConfig({ ...config()!, buffer_length_seconds: 15 })}
                      className={`cursor-pointer transition-colors hover:text-white ${config()!.buffer_length_seconds === 15 ? 'text-white font-bold' : ''}`}
                    >
                      15s (Short Kill)
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfig({ ...config()!, buffer_length_seconds: 30 })}
                      className={`cursor-pointer transition-colors hover:text-white ${config()!.buffer_length_seconds === 30 ? 'text-white font-bold' : ''}`}
                    >
                      30s (Default)
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfig({ ...config()!, buffer_length_seconds: 60 })}
                      className={`cursor-pointer transition-colors hover:text-white ${config()!.buffer_length_seconds === 60 ? 'text-white font-bold' : ''}`}
                    >
                      60s (Full Round)
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfig({ ...config()!, buffer_length_seconds: 120 })}
                      className={`cursor-pointer transition-colors hover:text-white ${config()!.buffer_length_seconds === 120 ? 'text-white font-bold' : ''}`}
                    >
                      120s (Extended Play)
                    </button>
                  </div>
                </div>
              </div>

              {/* Hardware Acceleration & Web Streaming Options */}
              <div className="bg-[#0A0A0A]/70 border border-[#262626] rounded-xl p-5 space-y-4 shadow-sm">
                <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">Hardware Silicon & Streaming Flags</h3>
                <div>
                  <label className="text-xs text-slate-400 block mb-1.5 font-medium">Hardware Video Encoder</label>
                  <select
                    value={config()!.encoder}
                    onChange={(e) => setConfig({ ...config()!, encoder: e.currentTarget.value as any })}
                    className="w-full bg-[#000000] border border-[#262626] rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-[#FFFFFF]"
                  >
                    <option value="auto">Auto-Detect Best Dedicated GPU (NVENC / AMF / QSV)</option>
                    <option value="nvenc">Force NVIDIA NVENC (GeForce RTX / GTX)</option>
                    <option value="amf">Force AMD AMF (Radeon RX)</option>
                    <option value="qsv">Force Intel QuickSync (Intel Arc / Iris)</option>
                    <option value="cpu">Software Encoder (CPU Fallback)</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-4 pt-2">
                  <label className="flex items-center gap-2.5 p-3 rounded-lg bg-[#000000] border border-[#262626] cursor-pointer hover:border-[#333333]">
                    <input
                      type="checkbox"
                      checked={config()!.faststart_movflags}
                      onChange={(e) => setConfig({ ...config()!, faststart_movflags: e.currentTarget.checked })}
                      className="accent-[#A3A3A3] size-4 rounded"
                    />
                    <div>
                      <div className="text-xs font-bold text-white">Faststart Web Optimization</div>
                      <div className="text-[10px] text-slate-400">Places MP4 moov atom at beginning for zero-lag instant web playback.</div>
                    </div>
                  </label>

                  <label className="flex items-center gap-2.5 p-3 rounded-lg bg-[#000000] border border-[#262626] cursor-pointer hover:border-[#333333]">
                    <input
                      type="checkbox"
                      checked={config()!.flip_vertical}
                      onChange={(e) => setConfig({ ...config()!, flip_vertical: e.currentTarget.checked })}
                      className="accent-[#A3A3A3] size-4 rounded"
                    />
                    <div>
                      <div className="text-xs font-bold text-white">Default Video Flip (Vertical Invert)</div>
                      <div className="text-[10px] text-slate-400">Inverts bottom-up DIB frames for progressive displays.</div>
                    </div>
                  </label>
                </div>
              </div>
            </div>

            <div className="border-t border-[#2A2D34] my-8" />

            {/* SECTION 2: Audio & Voice */}
            <div id="settings-audio" className="space-y-6">
              <div>
                <h1 className="text-base font-bold text-white tracking-wide uppercase font-mono">Audio &amp; Voice Capture</h1>
                <p className="text-xs text-slate-400 mt-1">Configure WASAPI loopback audio, microphone gain, track separation, and push-to-talk.</p>
              </div>

              {/* Game Audio */}
              <div className="bg-[#0A0A0A]/70 border border-[#262626] rounded-xl p-5 space-y-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={config()!.audio.capture_game_audio}
                      onChange={(e) => updateConfigField((prev) => ({
                        ...prev,
                        audio: { ...prev.audio, capture_game_audio: e.currentTarget.checked }
                      }))}
                      className="accent-[#A3A3A3] size-4 rounded"
                    />
                    <div>
                      <span className="text-xs font-bold text-white block">Capture Game Audio (WASAPI Loopback)</span>
                      <span className="text-[11px] text-slate-400">High-fidelity 48kHz stereo sound directly from the Windows audio render engine.</span>
                    </div>
                  </label>
                  <span className="font-mono tabular-nums text-xs text-white font-bold">{Math.round(config()!.audio.game_audio_volume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={config()!.audio.game_audio_volume}
                  onInput={(e) => updateConfigField((prev) => ({
                    ...prev,
                    audio: { ...prev.audio, game_audio_volume: Number(e.currentTarget.value) }
                  }), false)}
                  className="w-full accent-[#A3A3A3] cursor-pointer"
                />
              </div>

              {/* Entire System Audio (Discord, Spotify, Music, Browser) */}
              <div className="bg-[#0A0A0A]/70 border border-[#262626] rounded-xl p-5 space-y-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={config()!.audio.capture_system_audio ?? true}
                      onChange={(e) => updateConfigField((prev) => ({
                        ...prev,
                        audio: { ...prev.audio, capture_system_audio: e.currentTarget.checked }
                      }))}
                      className="accent-[#7C3AED] size-4 rounded"
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold text-white block">Record Entire System Audio (Discord, Spotify, Browser & Music)</span>
                        <span className="px-1.5 py-0.2 rounded text-[8.5px] font-mono font-bold bg-[#7C3AED]/20 text-[#C084FC] border border-[#9333EA]/30">MASTER MIX</span>
                      </div>
                      <span className="text-[11px] text-slate-400">Captures all background computer audio including Discord voice chat, Spotify music, browser audio, and system notifications in sync with your gameplay clips.</span>
                    </div>
                  </label>
                  <span className="font-mono tabular-nums text-xs text-white font-bold">{Math.round((config()!.audio.system_audio_volume ?? 1.0) * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={config()!.audio.system_audio_volume ?? 1.0}
                  onInput={(e) => updateConfigField((prev) => ({
                    ...prev,
                    audio: { ...prev.audio, system_audio_volume: Number(e.currentTarget.value) }
                  }), false)}
                  className="w-full accent-[#7C3AED] cursor-pointer"
                />
              </div>

              {/* Microphone Input */}
              <div className="bg-[#0A0A0A]/70 border border-[#262626] rounded-xl p-5 space-y-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={config()!.audio.capture_microphone}
                      onChange={(e) => updateConfigField((prev) => ({
                        ...prev,
                        audio: { ...prev.audio, capture_microphone: e.currentTarget.checked }
                      }))}
                      className="accent-[#A3A3A3] size-4 rounded"
                    />
                    <div>
                      <span className="text-xs font-bold text-white block">Capture Microphone Input</span>
                      <span className="text-[11px] text-slate-400">Records your voice commentary and callouts.</span>
                    </div>
                  </label>
                  <span className="font-mono tabular-nums text-xs text-white font-bold">{Math.round(config()!.audio.mic_volume * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={config()!.audio.mic_volume}
                  onInput={(e) => updateConfigField((prev) => ({
                    ...prev,
                    audio: { ...prev.audio, mic_volume: Number(e.currentTarget.value) }
                  }), false)}
                  className="w-full accent-[#A3A3A3] cursor-pointer"
                />
              </div>

              {/* Advanced Audio Options */}
              <div className="bg-[#0A0A0A]/70 border border-[#262626] rounded-xl p-5 space-y-4 shadow-sm">
                <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">Advanced Track Architecture</h3>
                <div className="space-y-3">
                  <label className="flex items-center gap-3 p-3 rounded-lg bg-[#000000] border border-[#262626] cursor-pointer hover:border-[#333333]">
                    <input
                      type="checkbox"
                      checked={config()!.audio.separate_audio_tracks}
                      onChange={(e) => updateConfigField((prev) => ({
                        ...prev,
                        audio: { ...prev.audio, separate_audio_tracks: e.currentTarget.checked }
                      }))}
                      className="accent-[#A3A3A3] size-4 rounded"
                    />
                    <div>
                      <div className="text-xs font-bold text-white">Separate Game & Mic Audio Tracks</div>
                      <div className="text-[11px] text-slate-400">Writes game audio to Track 1 and microphone to Track 2 for Premiere Pro / DaVinci Resolve editing.</div>
                    </div>
                  </label>

                  <label className="flex items-center gap-3 p-3 rounded-lg bg-[#000000] border border-[#262626] cursor-pointer hover:border-[#333333]">
                    <input
                      type="checkbox"
                      checked={config()!.audio.push_to_talk}
                      onChange={(e) => updateConfigField((prev) => ({
                        ...prev,
                        audio: { ...prev.audio, push_to_talk: e.currentTarget.checked }
                      }))}
                      className="accent-[#A3A3A3] size-4 rounded"
                    />
                    <div>
                      <div className="text-xs font-bold text-white">Push-To-Talk Voice Recording</div>
                      <div className="text-[11px] text-slate-400">Only records microphone audio while your in-game team voice key is held down.</div>
                    </div>
                  </label>
                </div>
              </div>
            </div>

            <div className="border-t border-[#2A2D34] my-8" />

            {/* SECTION 3: Smart Auto-Clipping Triggers */}
            <div id="settings-triggers" className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-base font-bold text-white tracking-wide uppercase font-mono">Smart Auto-Clipping Triggers</h1>
                  <p className="text-xs text-slate-400 mt-1">Select which in-game combat moments automatically trigger highlight preservation without touching a key.</p>
                </div>
                <span className="px-2.5 py-1 rounded text-[10px] font-mono font-bold bg-[#10B981]/15 text-[#34D399] border border-[#10B981]/30 uppercase flex items-center gap-1.5 shrink-0">
                  <span className="size-1.5 rounded-full bg-[#10B981] animate-pulse"></span>
                  Instant Live Sync
                </span>
              </div>

              <div className="bg-[#0A0A0A]/70 border border-[#262626] rounded-xl p-5 space-y-3 shadow-sm">
                <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">Combat Elimination Events</h3>

                <label className="flex items-center justify-between p-3 rounded-lg bg-[#000000] border border-[#262626] cursor-pointer hover:border-[#333333]">
                  <div>
                    <div className="text-xs font-bold text-white">All Eliminations (Kills)</div>
                    <div className="text-[11px] text-slate-400">Saves a highlight clip whenever you register an elimination.</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={config()!.auto_clip_kills}
                    onChange={(e) => updateConfigField((prev) => ({ ...prev, auto_clip_kills: e.currentTarget.checked }))}
                    className="accent-[#A3A3A3] size-4 rounded"
                  />
                </label>

                <label className="flex items-center justify-between p-3 rounded-lg bg-[#000000] border border-[#262626] cursor-pointer hover:border-[#333333]">
                  <div>
                    <div className="text-xs font-bold text-[#FFFFFF]">Headshot Eliminations</div>
                    <div className="text-[11px] text-slate-400">Prioritizes crisp one-taps and headshot kill confirmations.</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={config()!.auto_clip_headshots}
                    onChange={(e) => updateConfigField((prev) => ({ ...prev, auto_clip_headshots: e.currentTarget.checked }))}
                    className="accent-[#A3A3A3] size-4 rounded"
                  />
                </label>

                <label className="flex items-center justify-between p-3 rounded-lg bg-[#000000] border border-[#262626] cursor-pointer hover:border-[#333333]">
                  <div>
                    <div className="text-xs font-bold text-purple-400">Multi-Kills (2K, 3K, 4K, 5K ACE)</div>
                    <div className="text-[11px] text-slate-400">Captures entire consecutive multi-kill sequences in a single extended highlight.</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={config()!.auto_clip_multikills}
                    onChange={(e) => updateConfigField((prev) => ({ ...prev, auto_clip_multikills: e.currentTarget.checked }))}
                    className="accent-[#A3A3A3] size-4 rounded"
                  />
                </label>

                <label className="flex items-center justify-between p-3 rounded-lg bg-[#000000] border border-[#262626] cursor-pointer hover:border-[#333333]">
                  <div>
                    <div className="text-xs font-bold text-red-400">Death Replay Analysis</div>
                    <div className="text-[11px] text-slate-400">Captures deaths so you can review crosshair placement, utility usage, and positioning mistakes.</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={config()!.auto_clip_deaths}
                    onChange={(e) => updateConfigField((prev) => ({ ...prev, auto_clip_deaths: e.currentTarget.checked }))}
                    className="accent-[#A3A3A3] size-4 rounded"
                  />
                </label>

                <label className="flex items-center justify-between p-3 rounded-lg bg-[#000000] border border-[#262626] cursor-pointer hover:border-[#333333]">
                  <div>
                    <div className="text-xs font-bold text-emerald-400">Spike Plants & Defuses</div>
                    <div className="text-[11px] text-slate-400">Auto-clips clutch last-second defuses and strategic spike detonations.</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={config()!.auto_clip_spike_events}
                    onChange={(e) => updateConfigField((prev) => ({ ...prev, auto_clip_spike_events: e.currentTarget.checked }))}
                    className="accent-[#A3A3A3] size-4 rounded"
                  />
                </label>
              </div>

              {/* Post-Roll Buffer Timing */}
              <div className="bg-[#0A0A0A]/70 border border-[#262626] rounded-xl p-5 space-y-3 shadow-sm">
                <div className="flex justify-between text-xs mb-1.5">
                  <span className="text-slate-300 font-bold">Post-Roll Buffer (After Elimination)</span>
                  <span className="font-mono tabular-nums text-white font-bold">{config()!.post_roll_seconds} Seconds</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="10"
                  step="1"
                  value={config()!.post_roll_seconds}
                  onInput={(e) => updateConfigField((prev) => ({ ...prev, post_roll_seconds: Number(e.currentTarget.value) }), false)}
                  className="w-full accent-[#A3A3A3] cursor-pointer"
                />
                <p className="text-[11px] text-slate-500 leading-relaxed">Records this many seconds after the event occurs to capture the kill banner, celebration, and reaction.</p>
              </div>
            </div>

            <div className="border-t border-[#2A2D34] my-8" />

            {/* SECTION 4: Hotkeys */}
            <div id="settings-hotkeys" className="space-y-6">
              <div>
                <h1 className="text-base font-bold text-white tracking-wide uppercase font-mono">Global Hotkeys</h1>
                <p className="text-xs text-slate-400 mt-1">Non-intrusive Windows pass-through hooks that work seamlessly while in Valorant.</p>
              </div>

              <div className="bg-[#0A0A0A]/70 border border-[#262626] rounded-xl p-5 space-y-4 shadow-sm">

                {/* 1. Manual Clip Hotkey */}
                <div className="flex items-center justify-between p-3 rounded-lg bg-[#000000] border border-[#262626] gap-4">
                  <div>
                    <span className="text-xs font-bold text-white block">Manual Clip Hotkey</span>
                    <span className="text-[11px] text-slate-400">Instantly saves the rolling buffer with all active combat bookmarks.</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setRecordingHotkey(recordingHotkey() === 'manual_clip' ? null : 'manual_clip')}
                      className={`font-mono text-xs font-bold rounded-md px-3 py-1.5 transition-all flex items-center gap-1.5 ${recordingHotkey() === 'manual_clip'
                          ? 'bg-[#7C3AED]/30 border-2 border-[#C084FC] text-[#C084FC] animate-pulse shadow-[0_0_12px_rgba(147,51,234,0.5)]'
                          : 'bg-[#1C1C1C] border border-[#333333] hover:border-[#7C3AED] text-white'
                        }`}
                      title="Click to rebind to any key or combination"
                    >
                      <Show when={recordingHotkey() === 'manual_clip'} fallback={<span>{config()!.hotkey_label || 'F8'}</span>}>
                        <span>Press keys... (Esc to cancel)</span>
                      </Show>
                    </button>
                    <button
                      type="button"
                      onClick={() => resetHotkey('manual_clip')}
                      className="px-2 py-1 text-[10px] font-mono text-slate-400 hover:text-white bg-[#141414] hover:bg-[#222222] border border-[#2A2A2A] rounded transition-colors"
                      title="Reset to default (F8)"
                    >
                      Reset
                    </button>
                  </div>
                </div>

                {/* 2. Timeline Mark In (Trim Start) */}
                <div className="flex items-center justify-between p-3 rounded-lg bg-[#000000] border border-[#262626] gap-4">
                  <div>
                    <span className="text-xs font-bold text-white block">Timeline Mark In (Trim Start)</span>
                    <span className="text-[11px] text-slate-400">Sets beginning of trimmed clip at current playhead position.</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setRecordingHotkey(recordingHotkey() === 'mark_in' ? null : 'mark_in')}
                      className={`font-mono text-xs font-bold rounded-md px-3 py-1.5 transition-all flex items-center gap-1.5 ${recordingHotkey() === 'mark_in'
                          ? 'bg-[#7C3AED]/30 border-2 border-[#C084FC] text-[#C084FC] animate-pulse shadow-[0_0_12px_rgba(147,51,234,0.5)]'
                          : 'bg-[#1C1C1C] border border-[#333333] hover:border-[#7C3AED] text-white'
                        }`}
                      title="Click to rebind to any key or combination"
                    >
                      <Show when={recordingHotkey() === 'mark_in'} fallback={<span>{config()!.hotkey_mark_in || '['}</span>}>
                        <span>Press keys... (Esc to cancel)</span>
                      </Show>
                    </button>
                    <button
                      type="button"
                      onClick={() => resetHotkey('mark_in')}
                      className="px-2 py-1 text-[10px] font-mono text-slate-400 hover:text-white bg-[#141414] hover:bg-[#222222] border border-[#2A2A2A] rounded transition-colors"
                      title="Reset to default ([)"
                    >
                      Reset
                    </button>
                  </div>
                </div>

                {/* 3. Timeline Mark Out (Trim End) */}
                <div className="flex items-center justify-between p-3 rounded-lg bg-[#000000] border border-[#262626] gap-4">
                  <div>
                    <span className="text-xs font-bold text-white block">Timeline Mark Out (Trim End)</span>
                    <span className="text-[11px] text-slate-400">Sets end of trimmed clip at current playhead position.</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setRecordingHotkey(recordingHotkey() === 'mark_out' ? null : 'mark_out')}
                      className={`font-mono text-xs font-bold rounded-md px-3 py-1.5 transition-all flex items-center gap-1.5 ${recordingHotkey() === 'mark_out'
                          ? 'bg-[#7C3AED]/30 border-2 border-[#C084FC] text-[#C084FC] animate-pulse shadow-[0_0_12px_rgba(147,51,234,0.5)]'
                          : 'bg-[#1C1C1C] border border-[#333333] hover:border-[#7C3AED] text-white'
                        }`}
                      title="Click to rebind to any key or combination"
                    >
                      <Show when={recordingHotkey() === 'mark_out'} fallback={<span>{config()!.hotkey_mark_out || ']'}</span>}>
                        <span>Press keys... (Esc to cancel)</span>
                      </Show>
                    </button>
                    <button
                      type="button"
                      onClick={() => resetHotkey('mark_out')}
                      className="px-2 py-1 text-[10px] font-mono text-slate-400 hover:text-white bg-[#141414] hover:bg-[#222222] border border-[#2A2A2A] rounded transition-colors"
                      title="Reset to default (])"
                    >
                      Reset
                    </button>
                  </div>
                </div>

                {/* 4. Play / Pause Video */}
                <div className="flex items-center justify-between p-3 rounded-lg bg-[#000000] border border-[#262626] gap-4">
                  <div>
                    <span className="text-xs font-bold text-white block">Play / Pause Video</span>
                    <span className="text-[11px] text-slate-400">Toggle footage playback during review.</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setRecordingHotkey(recordingHotkey() === 'play_pause' ? null : 'play_pause')}
                      className={`font-mono text-xs font-bold rounded-md px-3 py-1.5 transition-all flex items-center gap-1.5 ${recordingHotkey() === 'play_pause'
                          ? 'bg-[#7C3AED]/30 border-2 border-[#C084FC] text-[#C084FC] animate-pulse shadow-[0_0_12px_rgba(147,51,234,0.5)]'
                          : 'bg-[#1C1C1C] border border-[#333333] hover:border-[#7C3AED] text-white'
                        }`}
                      title="Click to rebind to any key or combination"
                    >
                      <Show when={recordingHotkey() === 'play_pause'} fallback={<span>{config()!.hotkey_play_pause || 'Space'}</span>}>
                        <span>Press keys... (Esc to cancel)</span>
                      </Show>
                    </button>
                    <button
                      type="button"
                      onClick={() => resetHotkey('play_pause')}
                      className="px-2 py-1 text-[10px] font-mono text-slate-400 hover:text-white bg-[#141414] hover:bg-[#222222] border border-[#2A2A2A] rounded transition-colors"
                      title="Reset to default (Space)"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              </div>

              {/* Clip Notification Overlay & Sound Feedback */}
              <div className="bg-[#0A0B0E]/90 border border-[#9333EA]/40 rounded-xl p-5 space-y-4 shadow-[0_4px_20px_rgba(0,0,0,0.6)] mt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-xs font-black text-transparent bg-clip-text bg-gradient-to-r from-[#FFFFFF] to-[#C084FC] uppercase tracking-wider font-mono flex items-center gap-2">
                      <svg class="size-3.5 text-[#A855F7]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <circle cx="12" cy="12" r="9" />
                        <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-30 12 12)" />
                      </svg>
                      CLIP OVERLAY &amp; SOUND FEEDBACK
                    </h3>
                    <p className="text-[11px] text-[#CBD5E1]/70 mt-0.5">
                      Visual HUD popup on the left and acoustic chime confirmation when F8 is pressed or clips are captured.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      playSoftClipChime(0.24);
                      notifyClipTriggered(config()?.buffer_length_seconds || 30, 'Manual Test Preview');
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold font-mono btn-tactile flex items-center gap-1.5 border border-[#9333EA]/50 bg-gradient-to-r from-[#7C3AED] to-[#9333EA] hover:opacity-95 text-[#FFFFFF] shadow-sm"
                    title="Test Overlay & Audio Chime"
                  >
                    <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                    </svg>
                    <span>Test Overlay &amp; Note</span>
                  </button>
                </div>

                <label className="flex items-center justify-between p-3.5 rounded-lg bg-[#000000] border border-[#2A2D34] hover:border-[#9333EA]/60 cursor-pointer transition-colors">
                  <div>
                    <div className="text-xs font-bold text-white flex items-center gap-2">
                      <span>Left-Hand HUD Popup Overlay</span>
                      <span className="px-1.5 py-0.2 rounded text-[9px] font-black uppercase tracking-wider bg-[#7C3AED]/30 text-[#C084FC] border border-[#9333EA]/40">
                        NEW
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Shows the smooth animated Eclipse card from the left stating <span className="text-[#C084FC] font-semibold">"time sec clipped"</span> and <span className="text-[#C084FC] font-semibold">"clipped via Eclipse"</span> with the animated emblem.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={overlayEnabled()}
                    onChange={(e) => toggleOverlay(e.currentTarget.checked)}
                    className="accent-[#7C3AED] size-4.5 rounded cursor-pointer"
                  />
                </label>

                <label className="flex items-center justify-between p-3.5 rounded-lg bg-[#000000] border border-[#2A2D34] hover:border-[#9333EA]/60 cursor-pointer transition-colors">
                  <div>
                    <div className="text-xs font-bold text-white flex items-center gap-2">
                      <span>Soft Audio Chime Confirmation</span>
                      <span className="px-1.5 py-0.2 rounded text-[9px] font-black uppercase tracking-wider bg-[#00D48F]/20 text-[#00D48F] border border-[#00D48F]/40">
                        ACOUSTIC
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      Plays a pleasant, non-intrusive harmonic soft chime when a highlight is clipped to provide audible confirmation without looking away from crosshair.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={soundEnabled()}
                    onChange={(e) => toggleSound(e.currentTarget.checked)}
                    className="accent-[#7C3AED] size-4.5 rounded cursor-pointer"
                  />
                </label>
              </div>
            </div>

            <div className="border-t border-[#2A2D34] my-8" />

            {/* SECTION 5: Storage & Performance */}
            <div id="settings-storage" className="space-y-6">
              <div>
                <h1 className="text-base font-bold text-white tracking-wide uppercase font-mono">Storage &amp; Disk Quota</h1>
                <p className="text-xs text-slate-400 mt-1">Manage local disk storage allocations and automated clip retention policies.</p>
              </div>

              {/* Storage Quotas */}
              <div className="bg-[#0A0B0E]/85 border border-[#2A2D34] rounded-xl p-5 space-y-4 shadow-sm">
                <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">Disk Quota & Auto-Purge</h3>

                <div className="pt-1">
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-slate-400 font-medium">Maximum Storage Allocation</span>
                    <span className="font-mono tabular-nums text-white font-bold">{config()!.max_storage_gb} GB</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="500"
                    step="10"
                    value={config()!.max_storage_gb}
                    onInput={(e) => setConfig({ ...config()!, max_storage_gb: Number(e.currentTarget.value) })}
                    className="w-full accent-[#9333EA] cursor-pointer"
                  />
                </div>

                <div className="pt-2">
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-slate-400 font-medium">Auto-Delete Oldest Clips After</span>
                    <span className="font-mono tabular-nums text-white font-bold">{config()!.auto_delete_days} Days</span>
                  </div>
                  <input
                    type="range"
                    min="7"
                    max="180"
                    step="7"
                    value={config()!.auto_delete_days}
                    onInput={(e) => setConfig({ ...config()!, auto_delete_days: Number(e.currentTarget.value) })}
                    className="w-full accent-[#9333EA] cursor-pointer"
                  />
                </div>
              </div>

              {/* Clip Save Directory */}
              <div className="bg-[#0A0B0E]/85 border border-[#2A2D34] rounded-xl p-5 space-y-2 shadow-sm">
                <label className="text-xs font-bold text-white uppercase tracking-wider font-mono">Clips Save Location</label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={config()!.clip_save_directory}
                    readOnly
                    className="flex-1 bg-[#12141A] border border-[#2A2D34] rounded-lg px-3 py-2 text-xs font-mono text-slate-300 focus:outline-none"
                  />
                </div>
                <p className="text-[10px] text-slate-500">Clips and verified JSON event metadata are saved locally on disk.</p>
              </div>

              {/* Riot Games Policy & Legal Disclaimer */}
              <div className="rounded-xl bg-[#0A0B0E]/90 border border-[#2A2D34] p-5 space-y-3.5 shadow-sm">
                <div className="flex items-center justify-between border-b border-[#2A2D34] pb-3">
                  <div className="flex items-center gap-2">
                    <div className="size-6 rounded-lg bg-[#7C3AED]/20 border border-[#9333EA]/40 flex items-center justify-center text-[#C084FC]">
                      <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                        <path d="m9 12 2 2 4-4" />
                      </svg>
                    </div>
                    <div>
                      <h3 className="text-xs font-bold text-white uppercase tracking-wider font-mono">
                        Riot Games Compliance &amp; Legal
                      </h3>
                      <p className="text-[10px] text-slate-400 font-mono">
                        Third-Party Developer &amp; Vanguard Policy Adherence
                      </p>
                    </div>
                  </div>
                  <span className="px-2 py-0.5 rounded text-[9px] font-mono font-bold uppercase bg-[#10B981]/20 text-[#34D399] border border-[#10B981]/40">
                    Vanguard Safe
                  </span>
                </div>

                {/* Mandatory Riot Legal Jibber Jabber */}
                <div className="rounded-lg bg-[#12141A] p-3.5 border border-[#2A2D34] text-[11px] text-slate-300 leading-relaxed font-sans">
                  <span className="text-[#C084FC] font-semibold">Eclipse</span> isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.
                </div>

                {/* Technical Non-Invasive Architecture Note */}
                <div className="text-[10px] text-slate-400 leading-relaxed space-y-1 font-mono">
                  <p>
                    <strong className="text-slate-300">Architecture Integrity:</strong> Eclipse captures gameplay purely via Windows DXGI Desktop Duplication and WASAPI audio loopback. It does not inject DLLs, does not modify game files, and never accesses Valorant process memory.
                  </p>
                  <p className="text-slate-500 pt-1">
                    Eclipse v0.1.0 • Independent Community Replay Engine
                  </p>
                </div>
              </div>
            </div>

            <div className="border-t border-[#2A2D34] my-8" />

            {/* SECTION 6: Software Updates & Minisign Cryptography */}
            <div id="settings-updates" className="space-y-6">
              <div>
                <h1 className="text-base font-bold text-white tracking-wide uppercase font-mono">
                  Software Updates &amp; Cryptography
                </h1>
                <p className="text-xs text-slate-400 mt-1">
                  Automatic GitHub release synchronization with Ed25519 digital signature enforcement.
                </p>
              </div>

              {/* Update Status Card */}
              <div className="bg-[#0A0B0E]/85 border border-[#2A2D34] rounded-xl p-5 space-y-4 shadow-sm">
                <div className="flex items-center justify-between border-b border-[#2A2D34] pb-3">
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-white uppercase tracking-wider font-mono">
                      Eclipse Auto-Update Engine
                    </span>
                    <span className="text-[11px] text-slate-400 mt-0.5">
                      Direct background updates fetched from GitHub Releases
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={checkUpdatesManually}
                    disabled={updateCheckStatus() === 'checking'}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold flex items-center gap-1.5 transition-all btn-tactile ${updateCheckStatus() === 'checking'
                        ? 'bg-[#1E293B] text-slate-400 border border-[#334155]'
                        : 'bg-gradient-to-r from-[#7C3AED] to-[#9333EA] hover:brightness-110 text-white border border-[#C084FC]/40 shadow-sm'
                      }`}
                  >
                    <Show
                      when={updateCheckStatus() !== 'checking'}
                      fallback={
                        <>
                          <svg class="size-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                            <circle cx="12" cy="12" r="10" stroke-opacity="0.25" />
                            <path d="M12 2a10 10 0 0 1 10 10" />
                          </svg>
                          <span>Checking...</span>
                        </>
                      }
                    >
                      <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                        <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      <span>Check for Updates</span>
                    </Show>
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-3.5">
                  <div className="p-3.5 rounded-lg bg-[#000000] border border-[#262626] flex flex-col justify-between">
                    <span className="text-[10px] font-mono uppercase text-slate-500 font-bold">Current Release</span>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-sm font-mono font-bold text-white">v0.1.3</span>
                      <span className="px-1.5 py-0.2 rounded text-[8.5px] font-mono font-bold uppercase bg-[#10B981]/20 text-[#34D399] border border-[#10B981]/40">
                        Active
                      </span>
                    </div>
                  </div>

                  <div className="p-3.5 rounded-lg bg-[#000000] border border-[#262626] flex flex-col justify-between">
                    <span className="text-[10px] font-mono uppercase text-slate-500 font-bold">Status</span>
                    <div className="flex items-center gap-2 mt-1">
                      <Show when={updateCheckStatus() === 'idle'}>
                        <span className="text-xs font-mono text-slate-300">Ready to check</span>
                      </Show>
                      <Show when={updateCheckStatus() === 'checking'}>
                        <span className="text-xs font-mono text-[#C084FC] animate-pulse">Contacting GitHub...</span>
                      </Show>
                      <Show when={updateCheckStatus() === 'latest'}>
                        <span className="text-xs font-mono text-[#00D48F] flex items-center gap-1.5 font-bold">
                          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                          Software is Up to Date
                        </span>
                      </Show>
                      <Show when={updateCheckStatus() === 'available'}>
                        <span className="text-xs font-mono text-[#F59E0B] font-bold">
                          v{updatePayload()?.version} Available!
                        </span>
                      </Show>
                      <Show when={updateCheckStatus() === 'error'}>
                        <span className="text-xs font-mono text-[#EF4444] font-bold" title={updateError()}>
                          Check Error
                        </span>
                      </Show>
                    </div>
                  </div>
                </div>

                {/* Cryptographic Signing Guarantee */}
                <div className="rounded-lg bg-[#12141A] p-3.5 border border-[#2A2D34] space-y-2">
                  <div className="flex items-center gap-2 text-xs font-bold font-mono text-white">
                    <svg class="size-4 text-[#C084FC]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    <span>Developer Ed25519 Public Key Enforcement</span>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed font-sans">
                    Every update is digitally signed with Minisign Ed25519 cryptography. If an unauthorized third party alters an update file or attempts to spoof releases, Eclipse's native verifier immediately aborts the installation.
                  </p>
                  <div className="p-2 rounded bg-[#000000] border border-[#2A2D34] text-[9.5px] font-mono text-[#C084FC] break-all select-all">
                    dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDY2ODFFQ0M0MkQ0MTVBNjcKUldSbldrRXR4T3lCWnV2UFJDZG16VFR6Sk8yLytQMDJTRk1iVDUxbEo4UzBvcStvNUREQjg1TXAK
                  </div>
                </div>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
