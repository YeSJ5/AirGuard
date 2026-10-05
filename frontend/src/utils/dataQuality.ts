export interface TelemetryDataQuality {
  observed_fields?: string[];
  missing_fields?: string[];
}

export function isObservedField(quality: TelemetryDataQuality | undefined, field: string): boolean {
  return Array.isArray(quality?.observed_fields) && quality.observed_fields.includes(field);
}

export function formatObservedNumber(
  quality: TelemetryDataQuality | undefined,
  field: string,
  value: number,
  digits = 0
): string {
  if (!isObservedField(quality, field) || !Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
