import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { playSoftClipChime } from '../utils/audioChime';
import eclipseBanner from '../assets/eclipse-banner-transparent.png';

interface ClipTriggerEventPayload {
  seconds?: number;
  filePath?: string;
  source?: 'hotkey' | 'manual' | 'auto';
  reason?: string;
}

// Global emitter function that any component can call directly
export function notifyClipTriggered(seconds: number = 30, reason?: string) {
  const ev = new CustomEvent('eclipse:clip-triggered', {
    detail: { seconds, reason },
  });
  window.dispatchEvent(ev);
}

export function ClipOverlayNotification(props?: { isStandaloneWindow?: boolean }) {
  const [isVisible, setIsVisible] = createSignal(false);
  const [isSlidingOut, setIsSlidingOut] = createSignal(false);
  const [isSlidIn, setIsSlidIn] = createSignal(false);
  const [configuredBuffer, setConfiguredBuffer] = createSignal(30);
  const [clippedSeconds, setClippedSeconds] = createSignal(30);
  const [clipReason, setClipReason] = createSignal<string | null>(null);

  let hideTimer: any = null;
  let slideTimer: any = null;
  let slideInTimer: any = null;

  const triggerOverlay = (seconds?: number, reason?: string) => {
    // Check user preference toggles
    const overlayEnabled = localStorage.getItem('eclipse_overlay_enabled') !== 'false';
    if (!overlayEnabled) return;

    if (hideTimer) clearTimeout(hideTimer);
    if (slideTimer) clearTimeout(slideTimer);
    if (slideInTimer) clearTimeout(slideInTimer);

    const finalSecs = typeof seconds === 'number' && seconds > 0 ? seconds : (configuredBuffer() || 30);
    setClippedSeconds(finalSecs);
    setClipReason(reason || null);
    setIsSlidingOut(false);
    setIsSlidIn(false);
    setIsVisible(true);

    // Frame-delayed slide-in trigger for silky-smooth animation from the side
    slideInTimer = setTimeout(() => {
      setIsSlidIn(true);
    }, 25);

    // Slide out after 3.0 seconds
    slideTimer = setTimeout(() => {
      setIsSlidingOut(true);
    }, 3000);

    // Completely unmount after 3.4 seconds
    hideTimer = setTimeout(() => {
      setIsVisible(false);
      setIsSlidIn(false);
      setIsSlidingOut(false);
      if (props?.isStandaloneWindow) {
        invoke('hide_overlay_window').catch(() => {});
      }
    }, 3400);
  };

  onMount(() => {
    // Fetch live config buffer duration
    invoke<{ buffer_length_seconds: number }>('get_config')
      .then((cfg) => {
        if (cfg && cfg.buffer_length_seconds) {
          setConfiguredBuffer(cfg.buffer_length_seconds);
          setClippedSeconds(cfg.buffer_length_seconds);
        }
      })
      .catch(() => {});

    // Register globally on window for instant zero-latency eval from native Rust backend
    if (typeof window !== 'undefined') {
      (window as any).triggerOverlay = (secs?: number, r?: string) => {
        triggerOverlay(secs, r);
      };
    }

    // 1. Listen for backend events from Rust global hotkey (F8) or auto-triggers
    let unlisten: (() => void) | null = null;
    listen<ClipTriggerEventPayload>('clip-triggered', (event) => {
      const payload = event.payload || {};
      const secs = payload.seconds || configuredBuffer() || 30;
      triggerOverlay(secs, payload.reason);
    })
      .then((unsub) => {
        unlisten = unsub;
      })
      .catch((err) => {
        console.warn('[Overlay] Failed to register tauri event listener:', err);
      });

    // 2. Listen for internal UI dispatch events
    const onInternalTrigger = (e: Event) => {
      const custom = e as CustomEvent;
      const secs = custom.detail?.seconds || configuredBuffer() || 30;
      triggerOverlay(secs, custom.detail?.reason);
    };
    window.addEventListener('eclipse:clip-triggered', onInternalTrigger);

    onCleanup(() => {
      if (unlisten) unlisten();
      window.removeEventListener('eclipse:clip-triggered', onInternalTrigger);
      if (hideTimer) clearTimeout(hideTimer);
      if (slideTimer) clearTimeout(slideTimer);
      if (slideInTimer) clearTimeout(slideInTimer);
    });
  });

  return (
    <Show when={isVisible()}>
      <div
        role="status"
        aria-live="polite"
        className={
          props?.isStandaloneWindow
            ? `relative w-full z-[99999] pointer-events-none select-none transition-all duration-300 ease-out ${
                !isSlidIn() || isSlidingOut()
                  ? '-translate-x-[115%] opacity-0'
                  : 'translate-x-0 opacity-100'
              }`
            : `fixed left-4 sm:left-6 md:left-8 top-16 sm:top-20 md:top-24 z-[99999] pointer-events-none select-none transition-all duration-300 ease-out ${
                !isSlidIn() || isSlidingOut()
                  ? '-translate-x-[120%] opacity-0'
                  : 'translate-x-0 opacity-100'
              }`
        }
      >
        {/* Adaptive Fluid Container styled to matching Neon Purple cyber theme (No backdrop-blur to avoid WebView2 black box) */}
        <div className="relative w-full rounded-2xl bg-[#0A0B0E] border-2 border-[#9333EA] p-3.5 shadow-[0_12px_40px_rgba(0,0,0,0.95),0_0_24px_rgba(147,51,234,0.45)] flex flex-col gap-2 overflow-hidden">
          {/* Ambient Purple Ray in Background */}
          <div className="absolute -right-12 -top-12 size-36 rounded-full bg-[#7C3AED]/20 blur-2xl pointer-events-none" />
          <div className="absolute -left-12 -bottom-12 size-36 rounded-full bg-[#3B82F6]/15 blur-2xl pointer-events-none" />

          {/* Core Notification Content Row */}
          <div className="relative z-10 flex items-center gap-3 sm:gap-4">
            {/* Animated Transparent Eclipse Emblem */}
            <div className="shrink-0 relative flex items-center justify-center">
              <div className="absolute inset-0 rounded-full bg-[#9333EA]/30 blur-md animate-pulse pointer-events-none" />
              <img
                src={eclipseBanner}
                alt="Eclipse"
                className="w-14 sm:w-16 md:w-20 max-h-12 sm:max-h-14 object-contain drop-shadow-[0_0_12px_rgba(168,85,247,0.65)] animate-eclipse-pulse transition-transform duration-300"
              />
            </div>

            {/* Typography Stack */}
            <div className="flex flex-col min-w-0 flex-1 leading-tight">
              {/* Top Line: "{duration} sec clipped" with green recording dot */}
              <div className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-[#00D48F] shadow-[0_0_8px_#00D48F] animate-ping opacity-75 shrink-0" />
                <span className="text-xs sm:text-sm md:text-base font-black font-mono tracking-wide uppercase text-transparent bg-clip-text bg-gradient-to-r from-[#FFFFFF] via-[#F1F5F9] to-[#C084FC] truncate">
                  {clippedSeconds()} sec clipped
                </span>
              </div>

              {/* Bottom Line: "clipped via Eclipse" with orbital logo badge */}
              <div className="flex items-center gap-1.5 mt-0.5 text-[10px] sm:text-[11px] md:text-xs font-mono font-bold text-[#A855F7] tracking-wider">
                <svg class="size-3 text-[#C084FC] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                  <circle cx="12" cy="12" r="9" />
                  <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-30 12 12)" />
                </svg>
                <span className="truncate text-[#CBD5E1]">
                  clipped via <span className="text-[#C084FC] font-black">Eclipse</span>
                </span>
              </div>

              {/* Optional reason tag if triggered automatically by multi-kill/elimination */}
              <Show when={clipReason()}>
                <div className="mt-1">
                  <span className="px-1.5 py-0.2 rounded text-[9px] font-mono font-semibold bg-[#7C3AED]/25 text-[#E9D5FF] border border-[#9333EA]/40 truncate max-w-full inline-block">
                    {clipReason()}
                  </span>
                </div>
              </Show>
            </div>
          </div>

          {/* Smooth Draining Bottom Timer Bar */}
          <div className="relative w-full h-1 bg-[#1E222A] rounded-full overflow-hidden shrink-0 mt-0.5 border border-[#2A2D34]/60">
            <div className="h-full bg-gradient-to-r from-[#7C3AED] via-[#9333EA] to-[#3B82F6] rounded-full animate-drainBar" />
          </div>
        </div>
      </div>
    </Show>
  );
}

