import { dbToGain, midiVelToGain } from "./volume";
import { VoiceParams } from "./types";

export class Voice {
  readonly stopId: string | number;
  readonly group: number | undefined;

  #context: BaseAudioContext;
  #source: AudioBufferSourceNode;
  #envelope: GainNode;
  #startAt: number;
  #ampAttack: number;
  #ampRelease: number;
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
    this.#ampAttack = params.ampAttack;
    this.#ampRelease = params.ampRelease;

    const startAt = startTime ?? context.currentTime;
    this.#startAt = startAt;

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

    // LPF — only inserted when cutoff is meaningfully below Nyquist
    let lpf: BiquadFilterNode | undefined;
    if (params.lpfCutoffHz < 20000) {
      lpf = context.createBiquadFilter();
      lpf.type = "lowpass";
      lpf.frequency.value = params.lpfCutoffHz;
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
     * Attack/release envelope. Attack ramps 0 → 1 over ampAttack seconds (only scheduled when
     * non-zero, matching the SF2 default of "no attack stage").
     */
    const envelope = context.createGain();
    if (this.#ampAttack > 0) {
      envelope.gain.setValueAtTime(0, startAt);
      envelope.gain.linearRampToValueAtTime(1.0, startAt + this.#ampAttack);
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
      for (const cb of this.#endedCallbacks) cb();
      this.#endedCallbacks = [];
    };
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
    } else {
      /**
       * Apply release envelope then stop the source. If stopped mid-attack, start the release
       * from wherever the attack ramp actually was at time t (not 1.0) - otherwise the envelope
       * would jump up to full volume before fading out.
       */

      const attackValueAtT =
        this.#ampAttack > 0
          ? Math.min(1, (t - this.#startAt) / this.#ampAttack)
          : 1.0;
      const stopAt = t + this.#ampRelease;
      this.#envelope.gain.cancelScheduledValues(t);
      this.#envelope.gain.setValueAtTime(attackValueAtT, t);
      this.#envelope.gain.linearRampToValueAtTime(0, stopAt);
      this.#source.stop(stopAt);
    }
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
