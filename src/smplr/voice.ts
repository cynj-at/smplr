import { dbToGain, midiVelToGain } from "./volume";
import { VoiceParams } from "./types";

export class Voice {
  readonly stopId: string | number;
  readonly group: number | undefined;

  #context: BaseAudioContext;
  #source: AudioBufferSourceNode;
  #envelope: GainNode;
  #startAt: number;
  #delayEnd: number;
  #attackEnd: number;
  #holdEnd: number;
  #decayEnd: number;
  #sustainLevel: number;
  #ampRelease: number;
  #lfoOscillators: OscillatorNode[] = [];
  #lfoDepths: GainNode[] = [];
  #state: "playing" | "stopping" | "stopped" = "playing";
  #endedCallbacks: (() => void)[] = [];

  constructor(
    context: BaseAudioContext,
    buffer: AudioBuffer,
    params: VoiceParams,
    destination: AudioNode,
    stopId: string | number,
    group?: number,
    startTime?: number,
  ) {
    this.#context = context;
    this.stopId = stopId;
    this.group = group;
    this.#ampRelease = params.ampRelease;

    const startAt = startTime ?? context.currentTime;
    this.#startAt = startAt;

    /**
     * Volume envelope phase boundaries, as absolute AudioContext times: delay (silent) -> attack
     * (0 -> 1 ramp) -> hold (flat at 1) -> decay (1 -> ampSustain ramp) -> sustain (flat at
     * ampSustain, held until stop()). SF2's DecayVolEnv is the time for a *full* (100%) decay;
     * the decay phase actually ends early, once the envelope reaches ampSustain.
     */
    const delayEnd = startAt + params.ampDelay;
    const attackEnd = delayEnd + params.ampAttack;
    const holdEnd = attackEnd + params.ampHold;
    const decayToSustainSeconds = params.ampDecay * (1 - params.ampSustain);
    const decayEnd = holdEnd + decayToSustainSeconds;
    this.#delayEnd = delayEnd;
    this.#attackEnd = attackEnd;
    this.#holdEnd = holdEnd;
    this.#decayEnd = decayEnd;
    this.#sustainLevel = params.ampSustain;

    // --- Build audio graph ---

    const source = context.createBufferSource();
    source.buffer = buffer;

    // Detune — Safari workaround: source.detune may not exist
    const cents = params.detune;
    if (source.detune) {
      source.detune.value = cents;
    } else {
      source.playbackRate.value = Math.pow(2, cents / 1200);
    }

    // Looping
    if (params.loopAuto) {
      source.loop = true;
      source.loopStart = buffer.duration * params.loopAuto.startRatio;
      source.loopEnd = buffer.duration * params.loopAuto.endRatio;
    } else if (params.loop) {
      source.loop = true;
      source.loopStart = params.loopStart;
      source.loopEnd = params.loopEnd || buffer.duration;
    }

    // LPF — only inserted when cutoff is meaningfully below Nyquist. Q shapes the resonant
    // peak at the cutoff frequency; irrelevant (and left at BiquadFilterNode's own default)
    // when there's no filter to shape.
    let lpf: BiquadFilterNode | undefined;
    if (params.lpfCutoffHz < 20000) {
      lpf = context.createBiquadFilter();
      lpf.type = "lowpass";
      lpf.frequency.value = params.lpfCutoffHz;
      lpf.Q.value = params.lpfQ;
    }

    // Velocity gain × dB volume
    const gain = context.createGain();
    gain.gain.value = midiVelToGain(params.velocity) * dbToGain(params.volume);

    // Stereo pan — only inserted when off-center
    let panner: StereoPannerNode | undefined;
    if (params.pan !== 0) {
      panner = context.createStereoPanner();
      panner.pan.value = params.pan;
    }

    /**
     * Modulation LFOs. Mod LFO can drive pitch, filter cutoff, and volume (tremolo)
     * simultaneously - one shared oscillator, one depth-gain branch per destination actually in
     * use. Vib LFO is a second, independent oscillator dedicated to pitch only (SF2 models these
     * as genuinely separate LFOs, not one LFO with a vibrato flag).
     *
     * Pitch is exact: detune is natively in cents, so an LFO's signal sums onto it with no
     * conversion. Filter/volume are linear approximations of SF2's exponential units (cents,
     * centibels) - Web Audio only sums LFO signals linearly onto frequency/gain AudioParams, so
     * depths are converted via the derivative of the exponential curve at the base value
     * (accurate for modest modulation depths, increasingly approximate for extreme sweeps).
     */
    if (
      (source.detune && params.modLfoToPitch !== 0) ||
      (lpf && params.modLfoToFilterFc !== 0) ||
      params.modLfoToVolume !== 0
    ) {
      const modLfo = this.#createLfo(
        context,
        startAt,
        params.modLfoRateHz,
        params.modLfoDelay,
      );
      if (source.detune) {
        this.#connectLfoDepth(
          context,
          modLfo,
          source.detune,
          params.modLfoToPitch,
        );
      }
      if (lpf) {
        const filterDepthHz =
          params.lpfCutoffHz * (Math.LN2 / 1200) * params.modLfoToFilterFc;
        this.#connectLfoDepth(context, modLfo, lpf.frequency, filterDepthHz);
      }
      const volumeDepthLinear =
        gain.gain.value * (Math.LN10 / 200) * params.modLfoToVolume;
      this.#connectLfoDepth(context, modLfo, gain.gain, volumeDepthLinear);
    }
    if (source.detune && params.vibLfoToPitch !== 0) {
      const vibLfo = this.#createLfo(
        context,
        startAt,
        params.vibLfoRateHz,
        params.vibLfoDelay,
      );
      this.#connectLfoDepth(
        context,
        vibLfo,
        source.detune,
        params.vibLfoToPitch,
      );
    }

    /**
     * Volume envelope: delay (silent) -> attack (0 -> 1) -> hold (flat at 1) -> decay
     * (1 -> ampSustain) -> sustain (held at ampSustain until stop()). Only scheduled when any
     * phase actually shapes the sound - the common case (every phase at its SF2 default) skips
     * AudioParam automation entirely and stays flat at 1, matching plain sample playback.
     */
    const envelope = context.createGain();
    const hasEnvelopeShape =
      delayEnd > startAt ||
      attackEnd > delayEnd ||
      holdEnd > attackEnd ||
      this.#sustainLevel !== 1;
    if (hasEnvelopeShape) {
      envelope.gain.setValueAtTime(0, startAt);
      envelope.gain.setValueAtTime(0, delayEnd);
      envelope.gain.linearRampToValueAtTime(1.0, attackEnd);
      envelope.gain.setValueAtTime(1.0, holdEnd);
      envelope.gain.linearRampToValueAtTime(this.#sustainLevel, decayEnd);
    } else {
      envelope.gain.value = 1.0;
    }

    // Wire: source → [lpf] → gain → [pan] → envelope → destination
    if (lpf) {
      source.connect(lpf);
      lpf.connect(gain);
    } else {
      source.connect(gain);
    }
    if (panner) {
      gain.connect(panner);
      panner.connect(envelope);
    } else {
      gain.connect(envelope);
    }
    envelope.connect(destination);
    /**
     * Offset: VoiceParams.offset is in seconds (matches loopStart/loopEnd).
     * When playing in reverse (buffer is already reversed), mirror the offset so
     * offset=T from the start of the original buffer maps to (duration-T) in the reversed one.
     */
    let offsetSec = 0;
    if (params.offset > 0) {
      offsetSec = params.reverse
        ? buffer.duration - params.offset
        : params.offset;
    }
    source.start(startAt, offsetSec);

    this.#source = source;
    this.#envelope = envelope;

    // Cleanup when the source naturally ends or is stopped
    source.onended = () => {
      this.#state = "stopped";
      envelope.disconnect();
      panner?.disconnect();
      gain.disconnect();
      lpf?.disconnect();
      source.disconnect();
      this.#lfoOscillators.forEach((osc) => osc.disconnect());
      this.#lfoDepths.forEach((depth) => depth.disconnect());
      for (const cb of this.#endedCallbacks) cb();
      this.#endedCallbacks = [];
    };
  }

  /** Creates and starts a sine-wave LFO oscillator (delayed start, fixed rate). Not yet connected to anything. */
  #createLfo(
    context: BaseAudioContext,
    startAt: number,
    rateHz: number,
    delaySec: number,
  ): OscillatorNode {
    const osc = context.createOscillator();
    osc.type = "sine";
    osc.frequency.value = rateHz;
    osc.start(startAt + delaySec);
    this.#lfoOscillators.push(osc);
    return osc;
  }

  /** Sums `osc`'s output, scaled by `depth`, onto `target`. No-op when `depth` is 0. */
  #connectLfoDepth(
    context: BaseAudioContext,
    osc: OscillatorNode,
    target: AudioParam,
    depth: number,
  ): void {
    if (depth === 0) return;
    const depthGain = context.createGain();
    depthGain.gain.value = depth;
    osc.connect(depthGain);
    depthGain.connect(target);
    this.#lfoDepths.push(depthGain);
  }

  /**
   * Stop the voice, applying a release envelope if time is after the start time.
   * Idempotent — subsequent calls after the first are ignored.
   */
  stop(time?: number): void {
    if (this.#state !== "playing") return;
    this.#state = "stopping";

    const t = time ?? this.#context.currentTime;

    if (t <= this.#startAt) {
      // Stop at or before start: cancel the note entirely
      this.#source.stop(t);
      this.#lfoOscillators.forEach((osc) => osc.stop(t));
    } else {
      /**
       * Apply release envelope then stop the source, starting the release from wherever the
       * envelope actually was at time t (whichever phase - delay/attack/hold/decay/sustain -
       * that falls in), not from 1.0 - otherwise a note stopped mid-attack or mid-decay would
       * jump to a different volume before fading out.
       */
      const valueAtT = this.#envelopeValueAt(t);
      const stopAt = t + this.#ampRelease;
      this.#envelope.gain.cancelScheduledValues(t);
      this.#envelope.gain.setValueAtTime(valueAtT, t);
      this.#envelope.gain.linearRampToValueAtTime(0, stopAt);
      this.#source.stop(stopAt);
      this.#lfoOscillators.forEach((osc) => osc.stop(stopAt));
    }
  }

  /** The volume envelope's value at AudioContext time `t` (t must be > #startAt). */
  #envelopeValueAt(t: number): number {
    if (t <= this.#delayEnd) return 0;
    if (t <= this.#attackEnd) {
      return this.#attackEnd > this.#delayEnd
        ? (t - this.#delayEnd) / (this.#attackEnd - this.#delayEnd)
        : 1;
    }
    if (t <= this.#holdEnd) return 1;
    if (t <= this.#decayEnd) {
      return this.#decayEnd > this.#holdEnd
        ? 1 +
            (this.#sustainLevel - 1) *
              ((t - this.#holdEnd) / (this.#decayEnd - this.#holdEnd))
        : this.#sustainLevel;
    }
    return this.#sustainLevel;
  }

  /**
   * Register a callback to be called when the source node fires its onended event.
   * If the voice has already stopped, the callback is invoked immediately.
   */
  onEnded(cb: () => void): void {
    if (this.#state === "stopped") {
      cb();
    } else {
      this.#endedCallbacks.push(cb);
    }
  }

  get isActive(): boolean {
    return this.#state !== "stopped";
  }
}
