/**
 * Synthesizes a soft, high-fidelity acoustic notification chime using Web Audio API.
 * Warm, gentle, and non-intrusive: smooth attack, harmonic chords, and soft exponential decay.
 */
let lastChimeTimestamp = 0;

export function playSoftClipChime(volume: number = 0.22) {
  const nowMs = Date.now();
  if (nowMs - lastChimeTimestamp < 1800) {
    return; // Strict 1.8s debounce to prevent double-chime trigger
  }
  lastChimeTimestamp = nowMs;

  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();

    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;

    // Master bus with gentle lowpass filter to remove any harsh digital highs
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(volume, now);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2600, now);

    masterGain.connect(filter);
    filter.connect(ctx.destination);

    // Warm, soothing chord progression:
    // C5 (523.25 Hz) -> E5 (659.25 Hz) -> G5 (783.99 Hz) with a subtle overtone at C6 (1046.5 Hz)
    const tones = [
      { freq: 523.25, offset: 0.00, dur: 0.65, gain: 0.30 },
      { freq: 659.25, offset: 0.06, dur: 0.70, gain: 0.32 },
      { freq: 783.99, offset: 0.12, dur: 0.85, gain: 0.35 },
      { freq: 1046.50, offset: 0.14, dur: 0.50, gain: 0.12 },
    ];

    tones.forEach(({ freq, offset, dur, gain: toneGain }) => {
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + offset);

      // Soft envelope: 18ms gentle attack, natural exponential release
      gainNode.gain.setValueAtTime(0.0001, now + offset);
      gainNode.gain.exponentialRampToValueAtTime(toneGain, now + offset + 0.018);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + offset + dur);

      osc.connect(gainNode);
      gainNode.connect(masterGain);

      osc.start(now + offset);
      osc.stop(now + offset + dur + 0.05);
    });

    // Clean up AudioContext after sound finishes
    setTimeout(() => {
      try {
        ctx.close().catch(() => {});
      } catch {
        // Ignore
      }
    }, 1200);
  } catch (err) {
    console.warn('[AudioChime] Failed to play notification sound:', err);
  }
}

