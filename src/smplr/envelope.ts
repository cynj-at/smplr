/**
 * Generic delay -> attack -> hold -> decay -> sustain envelope math, shared by the amplitude
 * envelope (voice's own gain) and the modulation envelope (a second, independent instance of the
 * same shape used to modulate pitch/filter cutoff over time - see SF2's "mod envelope").
 */

export type AdsrParams = {
  delay: number; // seconds of silence/0 before attack starts
  attack: number; // seconds to ramp 0 -> 1
  hold: number; // seconds held flat at 1 after attack, before decay starts
  decay: number; // seconds for a *full* (100%) decay from 1 to 0 - see computeAdsrTimes
  sustain: number; // level held after decay, until release (0-1)
};

/** absolute AudioContext times for each phase boundary, plus the resolved sustain level */
export type AdsrTimes = {
  delayEnd: number;
  attackEnd: number;
  holdEnd: number;
  decayEnd: number;
  sustainLevel: number;
};

/**
 * resolves phase boundaries as absolute AudioContext times
 */
export function computeAdsrTimes(
  startAt: number,
  params: AdsrParams,
): AdsrTimes {
  const delayEnd = startAt + params.delay;
  const attackEnd = delayEnd + params.attack;
  const holdEnd = attackEnd + params.hold;
  const decayToSustainSeconds = params.decay * (1 - params.sustain);
  const decayEnd = holdEnd + decayToSustainSeconds;
  return {
    delayEnd,
    attackEnd,
    holdEnd,
    decayEnd,
    sustainLevel: params.sustain,
  };
}

/**
 * whether this envelope actually shapes anything
 */
export function hasAdsrShape(startAt: number, times: AdsrTimes): boolean {
  return (
    times.delayEnd > startAt ||
    times.attackEnd > times.delayEnd ||
    times.holdEnd > times.attackEnd ||
    times.sustainLevel !== 1
  );
}

/** schedules delay/attack/hold/decay/sustain shape onto `gain`, starting at `startAt` */
export function scheduleAdsr(
  gain: AudioParam,
  startAt: number,
  times: AdsrTimes,
): void {
  gain.setValueAtTime(0, startAt);
  gain.setValueAtTime(0, times.delayEnd);
  gain.linearRampToValueAtTime(1.0, times.attackEnd);
  gain.setValueAtTime(1.0, times.holdEnd);
  gain.linearRampToValueAtTime(times.sustainLevel, times.decayEnd);
}

/** the envelope's value at AudioContext time `t`, whichever phase it falls in */
export function adsrValueAt(times: AdsrTimes, t: number): number {
  if (t <= times.delayEnd) return 0;
  if (t <= times.attackEnd) {
    return times.attackEnd > times.delayEnd
      ? (t - times.delayEnd) / (times.attackEnd - times.delayEnd)
      : 1;
  }
  if (t <= times.holdEnd) return 1;
  if (t <= times.decayEnd) {
    return times.decayEnd > times.holdEnd
      ? 1 +
          (times.sustainLevel - 1) *
            ((t - times.holdEnd) / (times.decayEnd - times.holdEnd))
      : times.sustainLevel;
  }
  return times.sustainLevel;
}

/**
 * schedules release ramp on `gain`, starting from wherever the envelope actually was at time
 * `t` - so a note stopped mid-attack/mid-decay fades smoothly
 */
export function scheduleAdsrRelease(
  gain: AudioParam,
  times: AdsrTimes,
  t: number,
  releaseSeconds: number,
): number {
  const valueAtT = adsrValueAt(times, t);
  const stopAt = t + releaseSeconds;
  gain.cancelScheduledValues(t);
  gain.setValueAtTime(valueAtT, t);
  gain.linearRampToValueAtTime(0, stopAt);
  return stopAt;
}
