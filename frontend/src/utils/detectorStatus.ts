export type DetectorStatus = 'normal' | 'suspicious' | 'critical' | 'unassessed';

/** Classify only an available detector risk; missing evidence is not a clean result. */
export function displayableRisk(risk: number | null | undefined, assessmentStatus?: string | null): number | null {
  if (assessmentStatus === 'INSUFFICIENT_EVIDENCE') return null;
  return typeof risk === 'number' && Number.isFinite(risk) ? risk : null;
}

export function detectorStatusFromRisk(risk: number | null | undefined, assessmentStatus?: string | null): DetectorStatus {
  if (assessmentStatus === 'INSUFFICIENT_EVIDENCE') return 'unassessed';
  if (typeof risk === 'number' && Number.isFinite(risk)) {
    if (risk >= 0.8 || assessmentStatus === 'CRITICAL') return 'critical';
    if (risk >= 0.65 || assessmentStatus === 'REVIEW_REQUIRED') return 'suspicious';
    return 'normal';
  }
  if (assessmentStatus === 'CRITICAL') return 'critical';
  if (assessmentStatus === 'REVIEW_REQUIRED') return 'suspicious';
  return 'normal';
}


