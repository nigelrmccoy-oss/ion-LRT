/** Local tangent-plane metres; origin matches scenery bake (Central-ish). x=east, z=south(+). */
export const ORIGIN_LAT = 43.45;
export const ORIGIN_LON = -80.50;
const R = 6378137;

export function lonLatToLocal(lon: number, lat: number): [number, number] {
  const x = ((lon - ORIGIN_LON) * Math.PI) / 180 * R * Math.cos((ORIGIN_LAT * Math.PI) / 180);
  const z = -((lat - ORIGIN_LAT) * Math.PI) / 180 * R;
  return [x, z];
}

export function localToLonLat(x: number, z: number): [number, number] {
  const lat = ORIGIN_LAT - (z / R) * (180 / Math.PI);
  const lon = ORIGIN_LON + (x / (R * Math.cos((ORIGIN_LAT * Math.PI) / 180))) * (180 / Math.PI);
  return [lon, lat];
}

export function haversineM(a: [number, number], b: [number, number]): number {
  const toR = (d: number) => (d * Math.PI) / 180;
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const φ1 = toR(lat1), φ2 = toR(lat2);
  const Δφ = toR(lat2 - lat1), Δλ = toR(lon2 - lon1);
  const s = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * 6371000 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
