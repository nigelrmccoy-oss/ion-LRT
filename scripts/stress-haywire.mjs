/**
 * Haywire scenario: no route speed limits or vMax ATP penalty.
 * Normal mode must keep current overspeed / vMax enforcement.
 */
import * as esbuild from 'esbuild';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function bundleEntry(entry, name) {
  const dir = await mkdtemp(path.join(tmpdir(), `ion-lrt-${name}-`));
  const outfile = path.join(dir, `${name}.mjs`);
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    format: 'esm',
    platform: 'neutral',
    bundle: true,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function el(text = '') {
  return { textContent: text, className: '', classList: { toggle() {}, contains() { return false; } } };
}

export async function haywireTests(assert) {
  const { mod: P, cleanup: cP } = await bundleEntry(path.join(root, 'src/game/Physics.ts'), 'PhysicsHaywire');
  const { mod: H, cleanup: cH } = await bundleEntry(path.join(root, 'src/game/CabHud.ts'), 'HudHaywire');
  const gameSrc = await readFile(path.join(root, 'src/game/Game.ts'), 'utf8');
  const mainSrc = await readFile(path.join(root, 'src/main.ts'), 'utf8');
  const html = await readFile(path.join(root, 'index.html'), 'utf8');

  const { TrainPhysics, MASS_FLEXITY_KG, OVERSPEED_PENALTY_MARGIN_KMH, VMAX_BACKSTOP_FACTOR } = P;
  const { formatSpeedLimit, renderCabHud } = H;

  const mk = () => {
    const p = new TrainPhysics({ massKg: MASS_FLEXITY_KG, weather: 'dry', electric: true });
    p.reverser = 1;
    p.pantographUp = true;
    p.lineVoltage = 750;
    p.resetVigilance();
    p.doorsOpen = false;
    return p;
  };

  try {
    assert(
      'Haywire. start menu has #scenario with Normal (default) and Haywire',
      /id="scenario"/.test(html)
        && /<option value="normal">Normal<\/option>/.test(html)
        && /<option value="haywire">Haywire<\/option>/.test(html)
        && html.indexOf('value="normal"') < html.indexOf('value="haywire"'),
    );
    assert(
      'Haywire. main.ts threads #scenario into game.start and deep-link ?scenario=',
      /scenarioSel/.test(mainSrc)
        && /scenario: scenarioSel\.value as Scenario/.test(mainSrc)
        && /scenario=normal\|haywire/.test(mainSrc)
        && /dl\.scenario/.test(mainSrc),
    );
    assert(
      "Haywire. Game.start accepts scenario?: 'normal' | 'haywire' and defaults to 'normal'",
      /scenario\?: Scenario/.test(gameSrc)
        && /this\.scenario = opts\.scenario \?\? 'normal'/.test(gameSrc)
        && /export type Scenario = 'normal' \| 'haywire'/.test(gameSrc)
        && /scenario: Scenario = 'normal'/.test(gameSrc),
    );
    assert(
      'Haywire. Game.loop still calls enforceSpeedLimit(limit) in Normal, and skips it in Haywire (clears the penalty instead)',
      /enforceSpeedLimit\(limit\)/.test(gameSrc)
        && /if \(this\.scenario === 'haywire'\) this\.physics\.overspeedPenalty = false/.test(gameSrc)
        && /else this\.physics\.enforceSpeedLimit\(limit\)/.test(gameSrc),
    );
    assert(
      'Haywire. 1.1× VMAX_BACKSTOP_FACTOR remains the last-resort runaway cap (not removed)',
      VMAX_BACKSTOP_FACTOR === 1.1
        && /VMAX_BACKSTOP_FACTOR/.test(await readFile(path.join(root, 'src/game/Physics.ts'), 'utf8')),
    );

    // ---- Normal: 50 km/h street limit still penalises ---------------------------------
    {
      const p = mk();
      p.speed = 54 / 3.6;
      const a1 = p.enforceSpeedLimit(50);
      p.speed = 56 / 3.6;
      const a2 = p.enforceSpeedLimit(50);
      p.speed = 52 / 3.6;
      const a3 = p.enforceSpeedLimit(50);
      p.speed = 50 / 3.6;
      const a4 = p.enforceSpeedLimit(50);
      assert(
        `Haywire. Normal still penalises a 50 km/h limit (engage above +${OVERSPEED_PENALTY_MARGIN_KMH} km/h, release at the limit)`,
        !a1 && a2 && a3 && !a4,
        `${a1} ${a2} ${a3} ${a4}`,
      );
    }
    {
      const v = mk();
      v.speed = 86 / 3.6;
      const vm = v.enforceSpeedLimit(Infinity);
      assert(
        'Haywire. Normal still applies the 80 km/h vMax penalty even when the route limit is Infinity',
        vm === true,
        `${vm}`,
      );
    }

    // ---- Haywire: no route / vMax penalty ---------------------------------------------
    {
      const p = mk();
      p.speed = 70 / 3.6;
      p.powerNotch = 8;
      p.overspeedPenalty = true;
      // Game.loop Haywire branch: do not call enforceSpeedLimit; clear the penalty.
      p.overspeedPenalty = false;
      const r = p.step(0.05, 0, 0);
      assert(
        'Haywire. at 70 km/h (over a 50 km/h street limit) the Haywire branch applies no penalty and does not cut traction',
        p.overspeedPenalty === false
          && (p.powerBlockedReason() == null || !/overspeed/i.test(p.powerBlockedReason()))
          && r.te > 0,
        `pen=${p.overspeedPenalty} blocked=${p.powerBlockedReason()} te=${r.te.toFixed(0)}`,
      );
    }
    {
      const p = mk();
      p.speed = 100 / 3.6;
      p.overspeedPenalty = true;
      p.overspeedPenalty = false; // Haywire branch
      assert(
        'Haywire. even at 100 km/h, skipping enforceSpeedLimit leaves the overspeed penalty off (vMax ATP does not apply)',
        p.overspeedPenalty === false && (p.powerBlockedReason() == null || !/overspeed/i.test(p.powerBlockedReason())),
      );
    }
    {
      const p = mk();
      p.speed = 90 / 3.6;
      // Calling enforceSpeedLimit with the posted 50 (or Infinity) would still trip vMax / route penalty —
      // Haywire must skip that call entirely.
      const wouldTripRoute = (() => { const q = mk(); q.speed = 90 / 3.6; return q.enforceSpeedLimit(50); })();
      const wouldTripVmax = (() => { const q = mk(); q.speed = 90 / 3.6; return q.enforceSpeedLimit(Infinity); })();
      p.overspeedPenalty = false;
      assert(
        'Haywire. skipping enforceSpeedLimit is required: the same 90 km/h would trip route and vMax penalties in Normal',
        wouldTripRoute && wouldTripVmax && p.overspeedPenalty === false,
        `route=${wouldTripRoute} vmax=${wouldTripVmax}`,
      );
    }

    // ---- HUD ---------------------------------------------------------------------------
    assert(
      'Haywire. formatSpeedLimit shows — for non-finite (unlimited) and the numeric posted limit otherwise',
      formatSpeedLimit(Infinity) === '—'
        && formatSpeedLimit(Number.NaN) === '—'
        && formatSpeedLimit(50) === '50'
        && formatSpeedLimit(70.4) === '70',
    );

    const limitVal = el();
    const tcmsLimit = el();
    const speedVal = el();
    const wrap = { classList: { on: false, toggle(_n, v) { this.on = !!v; } } };
    speedVal.parentElement = wrap;
    const baseHud = {
      speedKmh: 90,
      limitKmh: Infinity,
      overspeed: false,
      atpMode: '—',
      signalAspect: null,
      signalDistM: null,
      nextStation: '—',
      nextDistM: null,
      etaLabel: '',
      doorsOpen: false,
      doorSide: '',
      reverser: 'F',
      powerNotch: 8,
      brakeNotch: 0,
      holdBrake: false,
      emergencyBrake: false,
      slip: false,
      sand: false,
      horn: false,
      lights: 'auto',
      pantoUp: true,
      electric: true,
      clock: '08:00:00',
      vigilance: 'Vig 45s',
      blocked: null,
      weather: 'Dry',
      row: 'Reserved',
      voltageV: 750,
      currentA: 0,
      powerKw: 0,
      auxKw: 0,
      dumpedKw: 0,
      band: 'nominal',
      nearest: null,
      section: '',
    };
    renderCabHud({ limitVal, tcmsLimit, speedVal, speedo: wrap }, baseHud);
    assert(
      'Haywire. CabHud limitVal and tcmsLimit show — in Haywire, with no overspeed alarm',
      limitVal.textContent === '—' && tcmsLimit.textContent === '—' && wrap.classList.on === false,
      `limit=${limitVal.textContent} tcms=${tcmsLimit.textContent} overspeed=${wrap.classList.on}`,
    );

    const nLimit = el();
    const nTcms = el();
    const nSpeed = el();
    const nWrap = { classList: { on: false, toggle(_n, v) { this.on = !!v; } } };
    nSpeed.parentElement = nWrap;
    renderCabHud({ limitVal: nLimit, tcmsLimit: nTcms, speedVal: nSpeed, speedo: nWrap }, {
      ...baseHud,
      speedKmh: 56,
      limitKmh: 50,
      overspeed: true,
      atpMode: 'LOS',
    });
    assert(
      'Haywire. Normal HUD still shows the numeric 50 km/h limit and the overspeed warning',
      nLimit.textContent === '50' && nTcms.textContent === '50' && nWrap.classList.on === true,
      `limit=${nLimit.textContent} tcms=${nTcms.textContent} overspeed=${nWrap.classList.on}`,
    );

    assert(
      'Haywire. Game.updateHud passes Infinity limit, overspeed false, and ATP — in Haywire',
      /limitKmh: haywire \? Infinity : limit/.test(gameSrc)
        && /overspeed: haywire \? false :/.test(gameSrc)
        && /haywire \|\| !p\.electric/.test(gameSrc),
    );
  } finally {
    await cP();
    await cH();
  }
}
