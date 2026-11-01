/** A non-negative integer from the environment; a missing or invalid value falls back (never NaN, which would disable limits silently). */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`${name}=${JSON.stringify(raw)} is not a non-negative integer; using ${fallback}`);
    return fallback;
  }
  return n;
}
