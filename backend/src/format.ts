const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** ISO 8601 duration ("PT1H2M3S", "P1DT2H") to seconds; 0 when unknown or zero-length (live/upcoming). */
export function isoSeconds(iso: string | undefined): number {
  const m = iso ? ISO_DURATION.exec(iso) : null;
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}
