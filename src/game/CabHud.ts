/**
 * Driver TCMS + traction-power panel. Fills a set of DOM nodes from cab state.
 * Visual language follows ION Flexity cab stills (dark desk, pale LCD, coloured
 * lamps) and the Edmonton sister-car green speed emphasis — no operator logos.
 */
import type { VoltageBand, NearbyTpss } from './TractionPower';
import { UMAX1_V, UMAX2_V, UMIN_V, UN_V } from './TractionPower';

export type CabHudEls = {
  /* existing + new; all optional so tests and diesel can omit some */
  [id: string]: HTMLElement | undefined;
};

export type CabHudState = {
  speedKmh: number;
  limitKmh: number;
  overspeed: boolean;
  atpMode: 'ATP' | 'LOS' | '—';
  signalAspect: 'red' | 'amber' | 'green' | null;
  signalDistM: number | null;
  nextStation: string;
  nextDistM: number | null;
  etaLabel: string;
  doorsOpen: boolean;
  doorSide: 'L' | 'R' | '';
  /** Door cycle phase (DoorCycle); 'closing' shows the chime-warning text. */
  doorPhase?: 'closed' | 'opening' | 'open' | 'closing';
  reverser: string;
  powerNotch: number;
  brakeNotch: number;
  holdBrake: boolean;
  emergencyBrake: boolean;
  slip: boolean;
  sand: boolean;
  horn: boolean;
  lights: string;
  pantoUp: boolean;
  electric: boolean;
  clock: string;
  vigilance: string;
  blocked: string | null;
  weather: string;
  row: string;
  voltageV: number;
  currentA: number;
  powerKw: number;
  auxKw: number;
  dumpedKw: number;
  band: VoltageBand;
  nearest: NearbyTpss | null;
  section: string;
  /** Next speed limit change (km/h and distance ahead) */
  nextLimitKmh?: number | null;
  nextLimitDistM?: number | null;
};

/** Posted limit for the HUD / TCMS. Non-finite (Haywire) shows as off. */
export function formatSpeedLimit(limitKmh: number): string {
  if (!Number.isFinite(limitKmh)) return '—';
  return String(Math.round(limitKmh));
}

export function formatKm(m: number | null): string {
  if (m == null || !Number.isFinite(m)) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

export function aspectLabel(a: CabHudState['signalAspect']): string {
  return a ? a.toUpperCase() : '—';
}

/** Format next speed limit change: "50 km/h in 320 m" */
export function formatNextLimit(kmh: number | null | undefined, distanceM: number | null | undefined): string {
  if (kmh == null || distanceM == null || !Number.isFinite(kmh) || !Number.isFinite(distanceM)) {
    return '—';
  }
  return `${Math.round(kmh)} km/h in ${formatKm(distanceM)}`;
}

function setText(el: HTMLElement | undefined, value: string) {
  if (el && el.textContent !== value) el.textContent = value;
}

function setClass(el: HTMLElement | undefined, cls: string) {
  if (el && el.className !== cls) el.className = cls;
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

/** Map voltage onto the 400–1050 V bar used by the panel. */
export function voltageBarFrac(volts: number): number {
  const lo = 400;
  const hi = 1050;
  return clamp01((volts - lo) / (hi - lo));
}

export function renderCabHud(els: CabHudEls, s: CabHudState) {
  setText(els.speedVal, String(Math.round(s.speedKmh)));
  const limitTxt = formatSpeedLimit(s.limitKmh);
  setText(els.limitVal, limitTxt);
  setText(els.tcmsLimit, limitTxt);
  if (els.speedVal) {
    const wrap = els.speedo ?? els.speedVal.parentElement;
    wrap?.classList.toggle('overspeed', s.overspeed);
  }

  // Next limit display
  const nextLimitText = formatNextLimit(s.nextLimitKmh, s.nextLimitDistM);
  setText(els.nextLimit, nextLimitText);
  setText(els.tcmsNextLimit, nextLimitText);

  setText(els.atpMode, s.atpMode);
  setClass(els.atpMode, 'atp-mode mode-' + s.atpMode.toLowerCase());

  setText(els.signalVal, aspectLabel(s.signalAspect));
  setClass(els.signalLamp, 'signal-lamp aspect-' + (s.signalAspect ?? 'none'));
  setText(els.signalDist, s.signalAspect ? formatKm(s.signalDistM) : '—');

  const next = s.nextDistM != null
    ? `${s.nextStation}  ${formatKm(s.nextDistM)}${s.etaLabel ? '  ' + s.etaLabel : ''}`
    : s.nextStation;
  setText(els.nextStation, next);
  setText(els.tcmsNext, next);

  const side = s.doorSide === 'L' ? 'LEFT' : s.doorSide === 'R' ? 'RIGHT' : '';
  const phase = s.doorPhase ?? (s.doorsOpen ? 'open' : 'closed');
  const doorTxt = phase === 'closing' ? `Doors closing ${side}`.trim()
    : phase === 'opening' ? `Doors opening ${side}`.trim()
      : phase === 'open' || s.doorsOpen ? `Doors OPEN ${side}`.trim()
        : 'Doors closed';
  setText(els.doors, doorTxt);
  setClass(els.doors, 'doors ' + (phase === 'closing' ? 'closing' : phase === 'closed' && !s.doorsOpen ? 'closed' : 'open'));

  setText(els.reverser, s.reverser);
  setText(els.powerVal, String(s.powerNotch));
  const brakeBits = [String(s.brakeNotch)];
  if (s.holdBrake) brakeBits.push('HOLD');
  if (s.emergencyBrake) brakeBits.push('EMER');
  setText(els.brakeVal, brakeBits.join(' '));

  setClass(els.slip, 'lamp ' + (s.slip ? 'on' : 'off'));
  setClass(els.sand, 'lamp ' + (s.sand ? 'on' : 'off'));
  setClass(els.hornLamp, 'lamp ' + (s.horn ? 'on' : 'off'));
  setText(els.lights, s.lights);

  if (s.electric) {
    setText(els.panto, s.pantoUp ? 'Panto up' : 'Panto down');
    setClass(els.panto, 'panto ' + (s.pantoUp ? 'up' : 'down'));
  } else {
    setText(els.panto, 'Diesel');
    setClass(els.panto, 'panto diesel');
  }

  setText(els.clock, s.clock);
  setText(els.vigVal, s.vigilance);
  setClass(els.vigVal, 'vig ' + (s.vigilance.includes('FAIL') ? 'fail' : 'ok'));

  if (els.blockVal) {
    setText(els.blockVal, s.blocked || '');
    els.blockVal.parentElement?.classList.toggle('hidden', !s.blocked);
  }
  setText(els.weather, s.weather);
  setText(els.rowVal, s.row);

  // Electrical panel
  const vTxt = s.electric && s.pantoUp ? `${Math.round(s.voltageV)} V` : (s.electric ? '0 V' : '—');
  setText(els.voltage, vTxt);
  setText(els.elecVoltage, vTxt);
  setClass(els.elecVoltage, 'elec-voltage band-' + s.band);
  setText(els.elecBand, bandLabel(s.band));

  if (els.elecBarFill) {
    const frac = s.electric && s.pantoUp ? voltageBarFrac(s.voltageV) : 0;
    (els.elecBarFill as HTMLElement).style.width = `${Math.round(frac * 1000) / 10}%`;
    els.elecBarFill.className = 'elec-bar-fill band-' + s.band;
  }

  const iTxt = s.electric && s.pantoUp ? `${s.currentA >= 0 ? '+' : ''}${s.currentA.toFixed(0)} A` : '0 A';
  setText(els.elecCurrent, iTxt);
  const pTxt = s.electric && s.pantoUp
    ? `${s.powerKw >= 0 ? '+' : ''}${s.powerKw.toFixed(0)} kW`
    : '0 kW';
  setText(els.elecPower, pTxt);
  setClass(els.elecPower, 'elec-power ' + (s.powerKw < -1 ? 'regen' : s.powerKw > 1 ? 'motor' : 'idle'));
  setText(els.elecAux, s.electric && s.pantoUp ? `${s.auxKw.toFixed(0)} kW est.` : '—');
  setText(els.elecDump, s.dumpedKw > 1 ? `Dump ${s.dumpedKw.toFixed(0)} kW` : '');

  if (s.nearest) {
    setText(els.elecTpss, `${s.nearest.site.name}  ${formatKm(s.nearest.distanceM)}`);
    const src = s.nearest.site.estimated ? ' (estimated site)' : '';
    setText(els.elecTpssNote, src);
  } else {
    setText(els.elecTpss, '—');
    setText(els.elecTpssNote, '');
  }
  setText(els.elecSection, s.section || '—');
}

export function bandLabel(band: VoltageBand): string {
  switch (band) {
    case 'undervoltage': return `Below ${UMIN_V} V`;
    case 'low': return 'Low';
    case 'nominal': return `${UN_V} V nominal`;
    case 'high': return `High (≤ ${UMAX1_V} V)`;
    case 'regen': return `Regen (≤ ${UMAX2_V} V)`;
    case 'overvoltage': return `Over ${UMAX2_V} V`;
  }
}
