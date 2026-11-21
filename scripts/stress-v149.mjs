/**
 * v1.4.9 checks: resistive 750 V DC traction-power model (voltage sag, regen
 * cap, substation lookup) and EN 50163 bands. Does not change 400 kW / 62 kN.
 */
import * as esbuild from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
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

export async function v149Tests(assert) {
  const { mod: P, cleanup: cP } = await bundleEntry(path.join(root, 'src/game/Physics.ts'), 'Physics149');
  const { mod: T, cleanup: cT } = await bundleEntry(path.join(root, 'src/game/TractionPower.ts'), 'TP149');
  const { mod: H, cleanup: cH } = await bundleEntry(path.join(root, 'src/game/CabHud.ts'), 'Hud149');

  const {
    TPSS_SITES, UN_V, UMIN_V, UMAX1_V, UMAX2_V, AUX_LOAD_KW,
    voltageBand, nearestSubstations, equivalentResistanceOhm, samplePower,
    tractionPowerFromForces, TRACTION_POWER_W,
  } = T;
  const { TrainPhysics, MASS_FLEXITY_KG, AXLE_FRAC_FLEXITY } = P;

  try {
    const osm = TPSS_SITES.filter((s) => !s.estimated);
    const guessed = TPSS_SITES.filter((s) => s.estimated);
    assert('v149. at least 12 OSM (or OSM+OMSF) traction sites plus at most one estimated downtown placeholder',
      osm.length >= 12 && guessed.length === 1 && TPSS_SITES.length === osm.length + guessed.length,
      `${osm.length} OSM/mapped + ${guessed.length} estimated`);
    assert('v149. OMSF site is at 518 Dutton / Northfield and tagged omsf',
      TPSS_SITES.some((s) => s.omsf && s.id === 'omsf-northfield' && s.nearestStation.includes('518 Dutton')));
    assert('v149. every site has finite lat/lon in the KW box',
      TPSS_SITES.every((s) => s.lat > 43.4 && s.lat < 43.52 && s.lon > -80.56 && s.lon < -80.43));

    assert('v149. EN 50163 constants 500 / 750 / 900 / 1000 V',
      UMIN_V === 500 && UN_V === 750 && UMAX1_V === 900 && UMAX2_V === 1000);
    assert('v149. voltageBand: 499 undervoltage, 600 low, 750 nominal, 850 high, 950 regen, 1001 overvoltage',
      voltageBand(499) === 'undervoltage' && voltageBand(600) === 'low' && voltageBand(750) === 'nominal'
      && voltageBand(850) === 'high' && voltageBand(950) === 'regen' && voltageBand(1001) === 'overvoltage');

    const con = nearestSubstations(43.49834, -80.52954, 1)[0];
    assert('v149. lookup: Conestoga station snaps to the Conestoga TPSS',
      con.site.id === 'conestoga' && con.distanceM < 150, `${con.site.id} ${con.distanceM.toFixed(0)} m`);
    const fay = nearestSubstations(43.42231, -80.44186, 1)[0];
    assert('v149. lookup: Fairway station snaps to the Fairway TPSS',
      fay.site.id === 'fairway' && fay.distanceM < 250, `${fay.site.id} ${fay.distanceM.toFixed(0)} m`);
    const omsf = nearestSubstations(43.4972, -80.5432, 1)[0];
    assert('v149. lookup: Northfield / Dutton snaps to an OMSF-area TPSS',
      omsf.site.omsf === true && omsf.distanceM < 200, `${omsf.site.id} ${omsf.distanceM.toFixed(0)} m`);

    const atBox = samplePower({
      lat: 43.4988108, lon: -80.5296633,
      tractionPowerW: 0, pantographUp: true, auxKw: 0,
    });
    assert('v149. zero current at a TPSS site is 750 V (no sag)',
      Math.abs(atBox.voltageV - 750) < 1, `${atBox.voltageV.toFixed(2)} V`);

    const mid = samplePower({
      lat: 43.462, lon: -80.522, // Uptown Waterloo, between Park and GRH
      tractionPowerW: 400000, pantographUp: true, auxKw: 0,
    });
    const midIdle = samplePower({
      lat: 43.462, lon: -80.522,
      tractionPowerW: 0, pantographUp: true, auxKw: 0,
    });
    const midLow = samplePower({
      lat: 43.462, lon: -80.522,
      tractionPowerW: 100000, pantographUp: true, auxKw: 0,
    });
    assert('v149. voltage sags under motoring load away from a substation',
      mid.voltageV < midIdle.voltageV - 5 && mid.voltageV >= UMIN_V - 80,
      `idle ${midIdle.voltageV.toFixed(1)} V, 400 kW ${mid.voltageV.toFixed(1)} V, I=${mid.currentA.toFixed(0)} A`);
    assert('v149. heavier current sags more than a light draw at the same place',
      mid.voltageV < midLow.voltageV - 2,
      `100 kW ${midLow.voltageV.toFixed(1)} vs 400 kW ${mid.voltageV.toFixed(1)}`);

    const far = samplePower({
      lat: 43.452, lon: -80.50, // further from Conestoga than mid is from Park? use a point far from all
      tractionPowerW: 400000, pantographUp: true, auxKw: 0,
    });
    const nearP = samplePower({
      lat: 43.4985, lon: -80.5297,
      tractionPowerW: 400000, pantographUp: true, auxKw: 0,
    });
    assert('v149. same current: farther from substations → lower voltage',
      far.voltageV < nearP.voltageV - 5,
      `near ${nearP.voltageV.toFixed(1)} V vs far ${far.voltageV.toFixed(1)} V`);
    assert('v149. equivalent resistance is higher far from every TPSS',
      equivalentResistanceOhm(43.452, -80.50) > equivalentResistanceOhm(43.4988108, -80.5296633));

    const regenMild = samplePower({
      lat: 43.4988108, lon: -80.5296633,
      tractionPowerW: -80000, pantographUp: true, auxKw: 0,
    });
    assert('v149. regen near a TPSS raises voltage above 750 V but stays ≤ 1000 V',
      regenMild.voltageV > 750 && regenMild.voltageV <= UMAX2_V && regenMild.powerKw < 0,
      `${regenMild.voltageV.toFixed(1)} V, ${regenMild.powerKw.toFixed(0)} kW`);

    // The ION layout is stiff: even 2 MW near a TPSS only lifts a few tens of
    // volts (0.15 Ω/km estimate, many parallel feeds). Exercise the Umax2 cap
    // on a synthetic weak feed (one box 10 km away) so dumped kW is observable.
    const weakFeed = [{
      id: 'weak', name: 'Synthetic weak feed', lat: 43.4988108, lon: -80.5296633,
      nearestStation: 'test', osmWay: null, source: 'synthetic test feed', confidence: 'low', estimated: true, omsf: false,
    }];
    const regenHard = samplePower({
      lat: 43.4988108, lon: -80.4096633, // ~10 km east of the lone box
      tractionPowerW: -2_000_000, pantographUp: true, auxKw: 0,
      sites: weakFeed,
    });
    assert('v149. heavy regen is capped at 1000 V (Umax2) and reports dumped kW',
      Math.abs(regenHard.voltageV - UMAX2_V) < 1 && regenHard.dumpedKw > 100,
      `${regenHard.voltageV.toFixed(1)} V, dumped ${regenHard.dumpedKw.toFixed(0)} kW`);

    const down = samplePower({
      lat: 43.4988108, lon: -80.5296633,
      tractionPowerW: 400000, pantographUp: false,
    });
    assert('v149. pantograph down → 0 V and 0 A',
      down.voltageV === 0 && down.currentA === 0 && down.band === 'undervoltage');

    assert('v149. default aux load is a published estimate (40 kW), labelled as such in the constant',
      AUX_LOAD_KW === 40);

    const motoring = tractionPowerFromForces({ electric: true, pantographUp: true, speedMs: 20, teN: 20000, serviceBrakeN: 0 });
    const regen = tractionPowerFromForces({ electric: true, pantographUp: true, speedMs: 20, teN: 0, serviceBrakeN: 30000 });
    assert('v149. tractionPowerFromForces: motoring is +TE·v, regen is negative and capped at 400 kW',
      Math.abs(motoring - 400000) < 1 && regen < 0 && regen >= -TRACTION_POWER_W,
      `mot ${motoring} regen ${regen}`);

    const phys = new TrainPhysics({ massKg: MASS_FLEXITY_KG, weather: 'dry', electric: true, axleFrac: AXLE_FRAC_FLEXITY });
    phys.pantographUp = true;
    phys.lineVoltage = 750;
    const te0 = phys.maxTE(0);
    const v40 = 40 / 3.6;
    const p40 = phys.maxTE(v40) * v40;
    assert('v149. vehicle ratings unchanged: 62 kN start, 400 kW at 40 km/h @ 750 V',
      Math.abs(te0 - 62000) < 1 && Math.abs(p40 - 400000) < 1,
      `TE0=${te0} P40=${p40.toFixed(0)} W`);

    const { formatKm, voltageBarFrac, bandLabel } = H;
    assert('v149. formatKm: metres under 1 km, km above',
      formatKm(350) === '350 m' && formatKm(2400) === '2.4 km');
    assert('v149. voltageBarFrac is 0 at 400 V, 1 at 1050 V, and increases with voltage',
      voltageBarFrac(400) === 0 && voltageBarFrac(1050) === 1 && voltageBarFrac(750) > voltageBarFrac(500));
    assert('v149. bandLabel mentions the EN limits',
      bandLabel('undervoltage').includes('500') && bandLabel('regen').includes('1000'));

    const downtown = TPSS_SITES.find((s) => s.id === 'downtown-kitchener');
    assert('v149. downtown Kitchener placeholder is clearly marked estimated (not an OSM way)',
      !!downtown && downtown.estimated === true && downtown.osmWay === null && /ESTIMATE/i.test(downtown.source));
  } finally {
    await cP(); await cT(); await cH();
  }
}
