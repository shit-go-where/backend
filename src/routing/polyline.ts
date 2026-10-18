/**
 * Google encoded polyline algorithm (precision 5 by default), as returned by OneMap routing.
 * https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 * Returns [lat, lng] pairs. Throws on truncated input.
 */
export function decodePolyline(encoded: string, precision = 5): [number, number][] {
  const factor = 10 ** precision;
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  const next = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) throw new Error('Truncated polyline');
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    lat += next();
    lng += next();
    out.push([lat / factor, lng / factor]);
  }
  return out;
}

/** Inverse of decodePolyline; used in tests and for estimate routes. */
export function encodePolyline(points: [number, number][], precision = 5): string {
  const factor = 10 ** precision;
  let prevLat = 0;
  let prevLng = 0;
  let out = '';
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const [la, ln] of points) {
    const iLat = Math.round(la * factor);
    const iLng = Math.round(ln * factor);
    enc(iLat - prevLat);
    enc(iLng - prevLng);
    prevLat = iLat;
    prevLng = iLng;
  }
  return out;
}
