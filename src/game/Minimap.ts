import type { Track } from './Track';
import type { StationDef } from './Stations';

/** 2D route minimap: alignment, stations, player. */
export class Minimap {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  draw(opts: {
    track: Track;
    stations: StationDef[];
    s: number;
    heading: number;
    nextStops?: { name: string; distance_m: number }[];
  }) {
    const { track, stations, s, heading, nextStops = [] } = opts;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(8,14,28,0.82)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(80,110,160,0.7)';
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    const pts = track.points;
    if (!pts.length) return;

    // Calculate bounds with a buffer around the train position
    const here = track.sample(s);
    const buffer = 200; // meters buffer around train
    let minX = here.x - buffer, maxX = here.x + buffer;
    let minZ = here.z - buffer, maxZ = here.z + buffer;

    // Expand bounds to include all points
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }

    const pad = 12;
    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanZ);
    const toSx = (x: number) => pad + (x - minX) * scale;
    const toSy = (z: number) => pad + (z - minZ) * scale;

    // Draw track line
    ctx.beginPath();
    ctx.strokeStyle = '#6aa8ff';
    ctx.lineWidth = 2;
    for (let i = 0; i < pts.length; i += Math.max(1, Math.floor(pts.length / 200))) {
      const p = pts[i]!;
      const sx = toSx(p.x);
      const sy = toSy(p.z);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();

    // Draw all stations
    for (const st of stations) {
      const p = track.sample(Math.min(track.length, st.distance_m));
      ctx.fillStyle = '#f0c040';
      ctx.beginPath();
      ctx.arc(toSx(p.x), toSy(p.z), 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw train position and heading marker
    const px = toSx(here.x);
    const py = toSy(here.z);
    ctx.fillStyle = '#ff5533';
    ctx.beginPath();
    ctx.moveTo(px + Math.sin(heading) * 7, py + Math.cos(heading) * 7);
    ctx.lineTo(px - Math.sin(heading) * 4 - Math.cos(heading) * 4, py - Math.cos(heading) * 4 + Math.sin(heading) * 4);
    ctx.lineTo(px - Math.sin(heading) * 4 + Math.cos(heading) * 4, py - Math.cos(heading) * 4 - Math.sin(heading) * 4);
    ctx.closePath();
    ctx.fill();

    // Draw next stops with labels
    ctx.fillStyle = '#ffffff';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';

    for (let i = 0; i < Math.min(3, nextStops.length); i++) {
      const stop = nextStops[i];
      const p = track.sample(Math.min(track.length, stop.distance_m));
      const sx = toSx(p.x);
      const sy = toSy(p.z);
      const dist = Math.round((stop.distance_m - s) / 10) / 100; // km with 2 decimals

      // Draw label background
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      const label = `${stop.name} (${dist} km)`;
      const textWidth = ctx.measureText(label).width;
      ctx.fillRect(sx + 6, sy - 18, textWidth + 4, 16);

      // Draw label text
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, sx + 8, sy - 16);
    }
  }
}

/** ETA helper from remaining distance and current speed (floor on creep). */
export function etaSeconds(distanceM: number, speedMs: number): number | null {
  if (distanceM <= 0) return 0;
  const v = Math.max(Math.abs(speedMs), 2.5); // assume ~9 km/h creep if stopped for ETA feel
  return distanceM / v;
}

export function formatEta(sec: number | null): string {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
