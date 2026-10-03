export interface TrailPosition {
  lat: number;
  lng: number;
}

export interface RuleFlags {
  positionJump?: boolean;
  duplicateIcao?: boolean;
  climbRate?: boolean;
  altVelMismatch?: boolean;
  lowSignalConfidence?: boolean;
  [key: string]: boolean | undefined;
}

export interface ShapValue {
  name: string;
  value: number;
}

export interface Flight {
  id: string; // ICAO24
  callsign: string;
  squawk?: string;
  altitude: number; // ft or meters
  speed: number; // knots or m/s
  heading: number; // degrees
  verticalRate?: number; // m/s
  trustScore: number; // 0-100
  signalStrength?: number; // dBm
  status: 'normal' | 'suspicious' | 'critical';
  lat: number;
  lng: number;
  is_synthetic?: boolean;
  source?: string;
  history?: TrailPosition[];
  trilateration?: string;
  route?: string;
  estDepartureAirport?: string | null;
  estArrivalAirport?: string | null;
  firstSeen?: string | null;
  ruleFlags?: RuleFlags;
  shapValues?: ShapValue[];
  last_seen_seconds_ago?: number;
  staleness_status?: string;
  registration?: string | null;
  aircraftType?: string | null;
  operator?: string | null;
  country?: string | null;
  combined_risk_score?: number;
}

export interface AlertLog {
  id: string;
  timestamp: string;
  callsign: string;
  icao24: string;
  type: string;
  severity: 'low' | 'medium' | 'high';
  scoreImpact: number;
  acknowledged: boolean;
  is_synthetic?: boolean;
  reason_text?: string;
  combined_risk_score?: number;
}

export interface HealthStats {
  poll_latency_ms: number;
  queue_depth: number;
  circuit_breaker_state: string;
  last_successful_poll: string | null;
  last_poll_records?: number;
  last_processed_records?: number;
  last_poll_http_status?: number | null;
  rate_limit_remaining?: string | null;
  total_real_states?: number;
  total_synthetic_states?: number;
  live_continuity_status?: string;
  continuity_gap_detected?: boolean;
  continuity_message?: string;
}

export interface ModelRunStats {
  id: number;
  run_at: string;
  model_version: string;
  true_positives: number;
  false_positives: number;
  true_negatives: number;
  false_negatives: number;
  precision: number;
  recall: number;
  f1: number;
  notes: string;
}

export interface AblationMetric {
  name: string;
  configKey: string;
  f1: number;
  fpr: number;
  precision: number;
  recall: number;
  desc: string;
}

export interface User {
  id: number;
  email: string;
  role: 'admin' | 'analyst' | 'viewer';
  created_at?: string;
}

export interface AuditLog {
  id: number;
  user_id: number | null;
  action: string;
  target_type: string;
  target_id: string | null;
  timestamp: string;
  ip_address: string | null;
}

export interface IngestionPayload {
  icao24: string;
  latitude: number;
  longitude: number;
  altitude_m: number;
  velocity_ms: number;
  heading_deg: number;
  vertical_rate_ms?: number;
  callsign?: string;
  is_synthetic?: boolean;
  source?: string;
  route?: string;
  combined_risk_score?: number;
  trust_score?: number;
  is_alert_triggered?: boolean;
}

export interface TrustHistoryPoint {
  timestamp: string;
  instantaneous_risk: number;
  trust_score: number;
  is_alert: boolean;
  reported_nic?: number | null;
}

export interface AircraftTrustHistory {
  icao24: string;
  current_trust_score: number;
  window_size: number;
  pattern: 'STABLE' | 'GRADUAL_DECLINE' | 'SUDDEN_DROP';
  caption: string;
  history: TrustHistoryPoint[];
}

export interface RuleConfigState {
  max_implied_speed_kmh: number;
  duplicate_icao_dist_km: number;
  max_vertical_rate_ms: number;
  max_ground_altitude_m: number;
  max_ground_speed_ms: number;
  min_flight_speed_ms: number;
  min_reliable_nic?: number;
  min_confidence_jump_km?: number;
}
