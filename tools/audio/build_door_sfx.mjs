#!/usr/bin/env node
/**
 * Render the ION / TTC-style door chime + plug-door mechanism to WAV / OGG.
 *
 * All audio is original synthesis (see src/game/DoorCycle.ts). No copyrighted
 * recordings are used. Licence: CC0-1.0 for the rendered files; the generator
 * is part of this repository.
 *
 *   node tools/audio/build_door_sfx.mjs [--out dir]
 */
import * as esbuild from 'esbuild';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function parseOut() {
  const i = process.argv.indexOf('--out');
  if (i >= 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  return path.join(__dirname, 'out');
}

function writeWav(file, samples, sampleRate) {
  const n = samples.length;
  const header = Buffer.alloc(44);
  const dataBytes = n * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  const pcm = Buffer.alloc(dataBytes);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    pcm.writeInt16LE((x * 32767) | 0, i * 2);
  }
  return writeFile(file, Buffer.concat([header, pcm]));
}

async function bundleDoorCycle() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ion-lrt-doorsfx-'));
  const outfile = path.join(dir, 'DoorCycle.mjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/game/DoorCycle.ts')],
    outfile,
    format: 'esm',
    platform: 'neutral',
    bundle: true,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function encodeOgg(wavPath, oggPath) {
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', wavPath,
    '-c:a', 'libvorbis', '-q:a', '5',
    oggPath,
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`ffmpeg ogg failed: ${r.stderr || r.stdout || r.status}`);
  }
}

const ATTRIBUTION = `# Door SFX attribution

The files in this folder are original, deterministic syntheses produced by
\`tools/audio/build_door_sfx.mjs\` from \`src/game/DoorCycle.ts\`.

- Licence: CC0 1.0 Universal (public domain dedication).
- No third-party samples or copyrighted recordings were used or copied.
- The three-note close chime is a tribute reconstruction of the publicly
  documented TTC / ION pitches (G5–E5–C5 descending, notes overlapping) and
  the single G5 open chime. See docs/DOOR-SFX.md for sources.
- Mechanical layers (unlatch, electric plug-door slide, seating thud, lock
  click) are invented impressions of a Flexity plug/sliding door, not a
  recording of a real car.
`;

async function main() {
  const outDir = parseOut();
  await mkdir(outDir, { recursive: true });
  const { mod, cleanup } = await bundleDoorCycle();
  const { renderDoorSfx, DOOR_SFX } = mod;
  const sr = DOOR_SFX.sampleRate;

  const jobs = [
    ['door-close', 'close', 'mix'],
    ['door-close-chime', 'close', 'chime'],
    ['door-close-mech', 'close', 'mech'],
    ['door-open', 'open', 'mix'],
    ['door-open-chime', 'open', 'chime'],
    ['door-open-mech', 'open', 'mech'],
  ];

  const written = [];
  for (const [name, kind, stem] of jobs) {
    const stems = renderDoorSfx(kind, sr);
    const wav = path.join(outDir, `${name}.wav`);
    await writeWav(wav, stems[stem], sr);
    const ogg = path.join(outDir, `${name}.ogg`);
    encodeOgg(wav, ogg);
    written.push(path.basename(wav), path.basename(ogg));
  }
  await writeFile(path.join(outDir, 'ATTRIBUTION.md'), ATTRIBUTION);
  await cleanup();
  console.log(`Wrote ${written.length} audio files to ${outDir}`);
  for (const f of written) console.log(`  ${f}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
