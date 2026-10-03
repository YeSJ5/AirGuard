from datetime import datetime
from typing import List, Dict, Any, Optional, Union
from pydantic import BaseModel, Field

class AircraftStateResponse(BaseModel):
    id: int
    icao24: str
    callsign: Optional[str] = None
    latitude: float
    longitude: float
    altitude_m: float
    velocity_ms: float
    heading_deg: float
    vertical_rate_ms: float
    on_ground: bool
    received_at: datetime
    source: str
    reported_nic: Optional[int] = None
    data_quality: Dict[str, Any] = Field(default_factory=dict)
    is_synthetic: Optional[bool] = False
    last_seen_seconds_ago: Optional[float] = None
    staleness_status: Optional[str] = "LIVE"
    trust_score: Optional[float] = None
    combined_risk_score: Optional[float] = None

    model_config = {
        "from_attributes": True,
        "extra": "ignore"
    }


class ModelScores(BaseModel):
    ensemble_score: Optional[float] = Field(default=None, description="Risk score, when an enabled and loaded ensemble has evaluated this observation.")
    autoencoder_score: Optional[float] = Field(default=None, description="Reconstruction score, when an enabled and loaded autoencoder has evaluated this observation.")

class RuleEvidenceclimb(BaseModel):
    vertical_rate_ms: Optional[float] = Field(default=None, description="The vertical rate in meters per second.")
    max_threshold: Optional[float] = Field(default=None, description="The configuration threshold for vertical rate.")

class RuleEvidencealtvel(BaseModel):
    altitude_m: Optional[float] = Field(default=None, description="The aircraft's reported altitude in meters.")
    velocity_ms: Optional[float] = Field(default=None, description="The aircraft's reported horizontal velocity.")
    on_ground: Optional[bool] = Field(default=None, description="The on_ground transponder status.")
    threshold_alt: Optional[float] = Field(default=None, description="The configured maximum altitude on ground.")
    threshold_speed: Optional[float] = Field(default=None, description="The configured maximum speed on ground.")

class RuleEvidencejump(BaseModel):
    prev_coords: Optional[List[float]] = Field(default=None, description="The previous coordinates [latitude, longitude].")
    current_coords: Optional[List[float]] = Field(default=None, description="The current coordinates [latitude, longitude].")
    distance_km: Optional[float] = Field(default=None, description="The calculated distance delta in kilometers.")
    time_delta_sec: Optional[float] = Field(default=None, description="The time interval between reports in seconds.")
    implied_speed_kmh: Optional[float] = Field(default=None, description="The calculated implied horizontal speed in km/h.")

class RuleEvidencedup(BaseModel):
    coords_a: Optional[List[float]] = Field(default=None, description="Coordinates of first report.")
    coords_b: Optional[List[float]] = Field(default=None, description="Coordinates of second report.")
    distance_km: Optional[float] = Field(default=None, description="The distance delta between identical ICAO reports.")
    time_delta_sec: Optional[float] = Field(default=None, description="The time delta between identical ICAO reports.")

class RuleEvidenceLowSignal(BaseModel):
    reported_nic: Optional[int] = Field(default=None, description="Reported Navigation Integrity Category (0-11).")
    min_reliable_nic: Optional[int] = Field(default=None, description="Configured minimum reliable NIC threshold.")
    distance_km: Optional[float] = Field(default=None, description="The calculated distance delta in kilometers.")
    min_confidence_jump_km: Optional[float] = Field(default=None, description="The configured minimum displacement threshold in km.")

class RuleFlagsEvidence(BaseModel):
    position_jump: Optional[RuleEvidencejump] = Field(default=None, description="Evidence details for position jump rule.")
    duplicate_icao: Optional[RuleEvidencedup] = Field(default=None, description="Evidence details for duplicate ICAO rule.")
    climb_rate: Optional[RuleEvidenceclimb] = Field(default=None, description="Evidence details for climb rate rule.")
    alt_vel_mismatch: Optional[RuleEvidencealtvel] = Field(default=None, description="Evidence details for altitude-velocity mismatch rule.")
    low_signal_confidence: Optional[RuleEvidenceLowSignal] = Field(default=None, description="Evidence details for low signal confidence rule.")

class TrilaterationEvidence(BaseModel):
    reason: Optional[str] = Field(default=None, description="Trilateration status description.")
    num_receivers: Optional[int] = Field(default=None, description="Number of ground station receivers.")

class ShapEvidence(BaseModel):
    rule_flags: RuleFlagsEvidence = Field(..., description="Evidence data for rule triggers.")
    trilateration: Optional[TrilaterationEvidence] = Field(default=None, description="Trilateration validation evidence.")
    model_scores: ModelScores = Field(..., description="Runtimes scores from detection models.")

class ShapExplanation(BaseModel):
    shap: Optional[Dict[str, Any]] = Field(default_factory=dict, description="Feature importances mapped from SHAP explainer.")
    evidence: Optional[ShapEvidence] = Field(default=None, description="Structured aerodynamic evidence logs.")

    model_config = {
        "extra": "allow"
    }

class AlertResponse(BaseModel):
    id: int = Field(..., description="Unique integer ID of the alert.")
    icao24: str = Field(..., description="The unique 24-bit ICAO hex identifier of the aircraft.")
    aircraft_state_id: int = Field(..., description="ID of the raw aircraft state that triggered this alert.")
    rule_flags: List[str] = Field(..., description="List of rule feature names triggered by this state.")
    ensemble_score: Optional[float] = Field(default=None, description="Ensemble output, unavailable when the model is not enabled or loaded.")
    autoencoder_score: Optional[float] = Field(default=None, description="Autoencoder output, unavailable when the model is not enabled or loaded.")
    combined_risk_score: float = Field(..., description="Combined risk score from all classifiers (0.0 to 1.0).")
    reason_text: str = Field(..., description="Narrated summary of anomaly triggers.")
    shap_explanation: Union[ShapExplanation, Dict[str, Any]] = Field(default_factory=dict, description="Explainable AI details and metric logs.")
    detected_at: datetime = Field(..., description="Timestamp when the detector generated this alert.")
    is_synthetic: bool = Field(..., description="Whether this anomaly was programmatically injected.")
    acknowledged: bool = Field(..., description="Whether this alert has been reviewed and acknowledged by an operator.")

    model_config = {
        "from_attributes": True,
        "extra": "ignore"
    }


class ModelRunResponse(BaseModel):
    id: int
    run_at: datetime
    model_version: str
    true_positives: int
    false_positives: int
    true_negatives: int
    false_negatives: int
    precision: float
    recall: float
    f1: float
    notes: str

    model_config = {
        "from_attributes": True,
        "strict": True,
        "extra": "forbid"
    }


class SystemHealthResponse(BaseModel):
    poll_latency_ms: float
    queue_depth: int
    circuit_breaker_state: str
    last_successful_poll: Optional[datetime] = None
    last_poll_attempt: Optional[datetime] = None
    last_poll_records: int = 0
    last_processed_records: int = 0
    upstream_status: str = "UNKNOWN"
    feed_mode: str = "UNKNOWN"
    feed_source: str = "none"
    fallback_reason: Optional[str] = None
    upstream_message: str = "Waiting for the first response from the configured aircraft feed."
    last_poll_http_status: Optional[int] = None
    rate_limit_remaining: Optional[Union[str, int]] = None
    total_real_states: int = 0
    total_synthetic_states: int = 0
    live_continuity_status: str = "UNKNOWN"
    seconds_since_last_poll: Optional[float] = None
    max_allowed_poll_gap_seconds: float = 20.0
    continuity_gap_detected: bool = False
    continuity_message: str = "Live data polling is continuous and healthy."

    model_config = {
        "strict": False,
        "extra": "ignore"
    }


class UserRegister(BaseModel):
    email: str
    password: str
    role: str = "viewer"  # viewer, analyst, admin

    model_config = {
        "strict": True,
        "extra": "forbid"
    }


class UserLogin(BaseModel):
    email: str
    password: str

    model_config = {
        "strict": True,
        "extra": "forbid"
    }


class UserResponse(BaseModel):
    id: int
    email: str
    role: str
    created_at: datetime

    model_config = {
        "from_attributes": True,
        "strict": True,
        "extra": "forbid"
    }


class TokenResponse(BaseModel):
    access_token: str
    token_type: str

    model_config = {
        "strict": True,
        "extra": "forbid"
    }


class AuditLogResponse(BaseModel):
    id: int
    user_id: Optional[int] = None
    action: str
    target_type: str
    target_id: Optional[str] = None
    timestamp: datetime
    ip_address: Optional[str] = None

    model_config = {
        "from_attributes": True,
        "strict": True,
        "extra": "forbid"
    }


class TrustHistoryPoint(BaseModel):
    timestamp: datetime = Field(..., description="Timestamp of the telemetry reading.")
    trust_score: float = Field(..., description="Derived index for the recorded scored observation; not an aircraft safety rating.")
    instantaneous_risk: float = Field(..., description="Detector risk score for the recorded observation.")
    is_alert: bool = Field(default=False, description="Whether this state triggered a security alert.")
    reported_nic: Optional[int] = Field(default=None, description="Navigation Integrity Category at this point.")

    model_config = {
        "from_attributes": True,
        "strict": True,
        "extra": "forbid"
    }


class AircraftTrustHistoryResponse(BaseModel):
    icao24: str = Field(..., description="Unique 24-bit ICAO aircraft address.")
    current_trust_score: Optional[float] = Field(default=None, description="Latest derived index when scored observations exist.")
    window_size: int = Field(..., description="Configured smoothing window size in readings.")
    pattern: str = Field(..., description="Observed score pattern, or UNASSESSED when evidence is insufficient.")
    caption: str = Field(..., description="Plain-English explanation of the observed trust pattern.")
    history: List[TrustHistoryPoint] = Field(..., description="Chronological trust score trajectory.")

    model_config = {
        "from_attributes": True,
        "strict": True,
        "extra": "forbid"
    }


class FlightRouteResponse(BaseModel):
    icao24: str = Field(..., description="Unique 24-bit ICAO aircraft address.")
    session_id: str = Field(..., description="Active session identifier.")
    callsign: Optional[str] = Field(default=None, description="Aircraft callsign.")
    est_departure_airport: Optional[str] = Field(default=None, description="ICAO code of estimated departure airport.")
    est_arrival_airport: Optional[str] = Field(default=None, description="ICAO code of estimated arrival airport.")
    first_seen: Optional[datetime] = Field(default=None, description="Estimated departure / first seen timestamp.")
    last_seen: Optional[datetime] = Field(default=None, description="Estimated arrival / last seen timestamp.")
    route_text: str = Field(default="Route unknown", description="Formatted flight route or 'Route unknown'.")
    fetched_at: Optional[datetime] = Field(default=None, description="When route info was sourced and cached.")
    dep_lat: Optional[float] = Field(default=None, description="Latitude of departure airport.")
    dep_lng: Optional[float] = Field(default=None, description="Longitude of departure airport.")
    arr_lat: Optional[float] = Field(default=None, description="Latitude of arrival airport.")
    arr_lng: Optional[float] = Field(default=None, description="Longitude of arrival airport.")

    model_config = {
        "from_attributes": True,
        "strict": True,
        "extra": "ignore"
    }


class AircraftIdentityResponse(BaseModel):
    registration: Optional[str] = Field(default=None, description="Aircraft physical tail registration (e.g. VT-EXO or N12345).")
    typecode: Optional[str] = Field(default=None, description="ICAO aircraft type code or category.")
    model: Optional[str] = Field(default=None, description="Airframe model description when known.")
    operator: Optional[str] = Field(default=None, description="Operating airline or entity when known.")
    country: Optional[str] = Field(default=None, description="Country of registration when known.")
    source: str = Field(default="unknown", description="Metadata provenance.")

    model_config = {
        "from_attributes": True,
        "strict": True,
        "extra": "ignore"
    }


class AircraftTrustDetailResponse(BaseModel):
    status_text: str = Field(..., description="Assessment state; absence of a flag is not verification.")
    is_flagged: bool = Field(..., description="Whether aircraft currently has active security alerts or inconsistencies.")
    combined_risk_score: Optional[float] = Field(default=None, description="Instantaneous combined risk score when the detector produced one.")
    rolling_trust_score: Optional[float] = Field(default=None, description="Smoothed session trust score when available.")
    explanation: str = Field(..., description="Story Mode plain-English narrative explanation.")
    reasons: List[str] = Field(default_factory=list, description="List of detected anomaly triggers.")
    rule_flags: Dict[str, bool] = Field(default_factory=dict, description="Active physical rule violation flags.")
    technical_details: Dict[str, Any] = Field(default_factory=dict, description="Technical diagnostics (SHAP, ensemble, autoencoder).")
    trilateration_stations: Optional[int] = Field(default=None, description="Number of measured receiver observations, when supplied by the source.")
    last_evaluated_at: Optional[datetime] = Field(default=None, description="Timestamp of the most recent security evaluation.")

    model_config = {
        "from_attributes": True,
        "strict": True,
        "extra": "ignore"
    }


class AircraftStalenessResponse(BaseModel):
    status: str = Field(default="LIVE", description="'LIVE' or 'STALE'")
    is_stale: bool = Field(default=False, description="Whether aircraft has missed consecutive poll updates.")
    last_seen_seconds_ago: float = Field(default=0.0, description="Elapsed seconds since most recent received telemetry.")
    last_received_at: datetime = Field(..., description="Timestamp of last received telemetry state.")
    staleness_threshold_seconds: float = Field(default=20.0, description="Threshold after which aircraft is marked STALE.")
    removal_threshold_seconds: float = Field(default=120.0, description="Threshold after which aircraft fades from live feed.")

    model_config = {
        "from_attributes": True,
        "strict": True,
        "extra": "ignore"
    }


class AircraftDetailResponse(BaseModel):
    icao24: str = Field(..., description="Unique 24-bit ICAO aircraft address.")
    callsign: Optional[str] = Field(default=None, description="Aircraft callsign.")
    live_state: AircraftStateResponse = Field(..., description="Most recent physical telemetry state vector.")
    route: FlightRouteResponse = Field(..., description="Resolved departure, arrival, and route progression.")
    identity: AircraftIdentityResponse = Field(..., description="Airframe identity, registration, model, and operator.")
    trust_status: AircraftTrustDetailResponse = Field(..., description="Trust evaluation, risk scores, and Story Mode narrative.")
    staleness: AircraftStalenessResponse = Field(..., description="Tracking freshness and signal continuity status.")
    first_seen_session: Optional[datetime] = Field(default=None, description="Timestamp when aircraft was first tracked in the current session.")

    model_config = {
        "from_attributes": True,
        "strict": True,
        "extra": "ignore"
    }



