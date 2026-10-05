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

export interface ShapFeatureValue {
  feature?: string;
  name?: string;
  value: number;
}

export interface AircraftApiState {
  icao24: string;
  callsign?: string | null;
  squawk?: string | null;
  latitude: number;
  longitude: number;
  altitude_m: number;
  velocity_ms: number;
  heading_deg: number;
  vertical_rate_ms: number;
  on_ground: boolean;
  received_at: string;
  source: string;
  reported_nic?: number | null;
  data_quality?: Flight['data_quality'];
  is_synthetic?: boolean;
  last_seen_seconds_ago?: number;
  staleness_status?: string;
  trust_score?: number | null;
  combined_risk_score?: number | null;
  evidence_confidence?: number | null;
  assessment_status?: string | null;
  route?: string;
}

export interface AlertApiResponse {
  id: number;
  icao24: string;
  callsign?: string | null;
  detected_at: string;
  reason_text: string;
  combined_risk_score: number;
  acknowledged?: boolean;
  is_synthetic?: boolean;
}

export interface AircraftDetailResponse {
  icao24: string;
  callsign?: string | null;
  live_state: AircraftApiState & { id: number };
  route: {
    icao24: string;
    session_id?: string;
    callsign?: string | null;
    est_departure_airport?: string | null;
    est_arrival_airport?: string | null;
    first_seen?: string | null;
    last_seen?: string | null;
    route_text: string;
    fetched_at?: string | null;
    dep_lat?: number | null;
    dep_lng?: number | null;
    arr_lat?: number | null;
    arr_lng?: number | null;
  };
  identity?: {
    registration?: string | null;
    typecode?: string | null;
    model?: string | null;
    operator?: string | null;
    country?: string | null;
    source: string;
  };
  trust_status?: {
    status_text: string;
    is_flagged: boolean;
    combined_risk_score: number | null;
    trust_score?: number | null;
    evidence_confidence?: number | null;
    assessment_status?: string | null;
    smoothed_risk_score: number | null;
    explanation: string;
    reasons: string[];
    rule_flags: Record<string, boolean>;
    technical_details: {
      rule_risk?: number | null;
      ensemble_score?: number | null;
      autoencoder_score?: number | null;
      receiver_consistency_score?: number | null;
      evidence_confidence?: number | null;
      assessment_status?: string | null;
      shap?: { top_features?: ShapFeatureValue[] };
      [key: string]: unknown;
    };
    unavailable_reasons?: string[];
    trilateration_stations: number | null;
    last_evaluated_at?: string | null;
  };
  staleness?: {
    status: string;
    is_stale: boolean;
    last_seen_seconds_ago: number;
    last_received_at: string;
    staleness_threshold_seconds: number;
    removal_threshold_seconds: number;
  };
  first_seen_session?: string | null;
}

export interface Flight {
  id: string; // ICAO24
  received_at?: string;
  callsign: string;
  squawk?: string | null;
  altitude: number; // ft or meters
  speed: number; // knots or m/s
  heading: number; // degrees
  verticalRate?: number; // m/s
  trustScore: number; // 0-100
  trust_score?: number | null;
  signalStrength?: number; // dBm
  status: 'normal' | 'suspicious' | 'critical' | 'unassessed';
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
  combined_risk_score?: number | null;
  evidence_confidence?: number | null;
  assessment_status?: string | null;
  unavailable_reasons?: string[];
  data_quality?: { observed_fields?: string[]; missing_fields?: string[] };
}


export interface AlertLog {
  id: string;
  timestamp: string;
  detected_at?: string;
  callsign: string;
  icao24: string;
  airline?: string;
  operator?: string;
  type: string;
  severity: 'low' | 'medium' | 'high';
  scoreImpact: number;
  acknowledged: boolean;
  is_synthetic?: boolean;
  reason_text?: string;
  combined_risk_score?: number | null;
}

export interface HealthStats {
  database_status?: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
  redis_status?: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN';
  poll_latency_ms: number | null;
  queue_depth: number | null;
  circuit_breaker_state: string;
  last_successful_poll: string | null;
  last_poll_records?: number;
  last_normalized_records?: number;
  last_poll_http_status?: number | null;
  rate_limit_remaining?: string | null;
  total_real_states?: number;
  total_synthetic_states?: number;
  upstream_status?: 'LIVE' | 'RATE_LIMITED' | 'UNAVAILABLE' | 'UNKNOWN' | 'STALE';
  feed_mode?: 'LIVE' | 'UNAVAILABLE' | 'UNKNOWN';
  max_allowed_poll_gap_seconds?: number;
  feed_source?: string;
  fallback_reason?: string | null;
  upstream_message?: string;
  live_continuity_status?: string;
  continuity_gap_detected?: boolean;
  continuity_message?: string;
    source_status?: string;
    source_name?: string;
    last_successful_update?: string | null;
    next_attempt_at?: string | null;
    retry_after?: string | null;
    snapshot_age_seconds?: number | null;
    snapshot_count?: number | null;
    consecutive_failures?: number;
    last_error?: string | null;
    refresh_in_progress?: boolean;
    manual_refresh_pending?: boolean;
    refresh_interval_seconds?: number;
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
  combined_risk_score?: number | null;
  assessment_status?: string | null;
  trust_score?: number | null;
  evidence_confidence?: number | null;
  is_alert_triggered?: boolean;
  squawk?: string | null;
  received_at?: string;
  last_seen_seconds_ago?: number;
  staleness_status?: 'LIVE' | 'STALE';
  data_quality?: { observed_fields?: string[]; missing_fields?: string[]; timestamp_source?: string };
}

export interface TrustHistoryPoint {
  timestamp: string;
  risk_score: number;
  smoothed_risk_score: number;
  is_alert: boolean;
  reported_nic?: number | null;
}

export interface AircraftTrustHistory {
  icao24: string;
  current_risk_score: number | null;
  window_size: number;
  pattern: 'STABLE' | 'RISK_RISING' | 'RISK_SPIKE' | 'UNASSESSED';
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
