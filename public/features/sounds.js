/* Sr. Popo — sounds. No build step: native ES module. */
import { state } from '../core/state.js';


// ---------- sounds ----------
// Short synthesized cues for two moments: a tool needs approval, and a task
// finishes. Built with the Web Audio API so there are no audio assets to ship
// and it works identically in the browser and the Electron shell. Gated behind
// the "sounds" setting.
const soundsOn = () => state.settings.sounds !== false;

let audioCtx = null;
function audio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) { try { audioCtx = new Ctx(); } catch { return null; } }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

// Play a small sequence of tones — each [freq(Hz), start(s), dur(s)] — as a
// soft chime, with a short attack/decay so notes don't click.
function playTones(tones, { gain = 0.08, type = 'sine' } = {}) {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  for (const [freq, start, dur] of tones) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, now + start);
    g.gain.linearRampToValueAtTime(gain, now + start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(now + start);
    osc.stop(now + start + dur + 0.02);
  }
}

const SOUNDS = {
  // Two-note rise that reads as a friendly nudge for attention.
  permission: () => playTones([[660, 0, 0.18], [880, 0.14, 0.26]], { type: 'triangle' }),
  // Bright ascending three-note chime for a successful finish.
  finish: () => playTones([[523.25, 0, 0.16], [659.25, 0.12, 0.16], [783.99, 0.24, 0.3]]),
  // Gentle two-note fall to signal a failed run without being harsh.
  failed: () => playTones([[392, 0, 0.2], [294, 0.18, 0.32]], { type: 'triangle' }),
};

// Play a named cue if it exists. `force` bypasses the setting (used by the test
// button so the click always gives feedback).
function playSound(name, force = false) {
  if (!force && !soundsOn()) return;
  const fn = SOUNDS[name];
  if (fn) { try { fn(); } catch { /* audio unavailable */ } }
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {
  // Browsers block audio until the first user gesture — resume the context then.
  ['pointerdown', 'keydown'].forEach((ev) =>
    window.addEventListener(ev, () => audio(), { once: true }));
}


export { playSound, soundsOn };
