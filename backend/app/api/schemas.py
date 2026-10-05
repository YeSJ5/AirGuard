from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class AircraftStateResponse(BaseModel):
    id: int | None = None
    icao24: str
    callsign: str | None = None
    squawk: str | None = None
    latitude: float
    longitude: float
    altitude_m: float
    velocity_ms: float
    heading_deg: float
    vertical_rate_ms: float
    on_ground: bool
    received_at: datetime
    source: str
    reported_nic: int | None = None
    data_quality: dict[str, Any] = Field(default_factory=dict)
    is_synthetic: bool | None = False
    last_seen_seconds_ago: float | None = None
    staleness_status: str | None = "LIVE"
    trust_score: float | None = None
    combined_risk_score: float | None = None
    evidence_confidence: float | None = None
    assessment_status: str | None = None

    model_config = {"from_attributes": True, "extra": "ignore"}


class ModelScores(BaseModel):
    ensemble_score: float | None = Field(
        default=None,
        description="Risk score, when an enabled and loaded ensemble has evaluated this observation.",
    )
    autoencoder_score: float | None = Field(
        default=None,
        description="Reconstruction score, when an enabled and loaded autoencoder has evaluated this observation.",
    )


class RuleEvidenceclimb(BaseModel):
    vertical_rate_ms: float | None = Field(
        default=None, description="The vertical rate in meters per second."
    )
    max_threshold: float | None = Field(
        default=None, description="The configuration threshold for vertical rate."
    )


class RuleEvidencealtvel(BaseModel):
    altitude_m: float | None = Field(
        default=None, description="The aircraft's reported altitude in meters."
    )
    velocity_ms: float | None = Field(
        default=None, description="The aircraft's reported horizontal velocity."
    )
    on_ground: bool | None = Field(
        default=None, description="The on_ground transponder status."
    )
    threshold_alt: float | None = Field(
        default=None, description="The configured maximum altitude on ground."
    )
    threshold_speed: float | None = Field(
        default=None, description="The configured maximum speed on ground."
    )


class RuleEvidencejump(BaseModel):
    prev_coords: list[float] | None = Field(
        default=None, description="The previous coordinates [latitude, longitude]."
    )
    current_coords: list[float] | None = Field(
        default=None, description="The current coordinates [latitude, longitude]."
    )
    distance_km: float | None = Field(
        default=None, description="The calculated distance delta in kilometers."
    )
    time_delta_sec: float | None = Field(
        default=None, description="The time interval between reports in seconds."
    )
    implied_speed_kmh: float | None = Field(
        default=None, description="The calculated implied horizontal speed in km/h."
    )


class RuleEvidencedup(BaseModel):
    coords_a: list[float] | None = Field(
        default=None, description="Coordinates of first report."
    )
    coords_b: list[float] | None = Field(
        default=None, description="Coordinates of second report."
    )
    distance_km: float | None = Field(
        default=None, description="The distance delta between identical ICAO reports."
    )
    time_delta_sec: float | None = Field(
        default=None, description="The time delta between identical ICAO reports."
    )


class RuleEvidenceLowSignal(BaseModel):
    reported_nic: int | None = Field(
        default=None, description="Reported Navigation Integrity Category (0-11)."
    )
    min_reliable_nic: int | None = Field(
        default=None, description="Configured minimum reliable NIC threshold."
    )
    distance_km: float | None = Field(
        default=None, description="The calculated distance delta in kilometers."
    )
    min_confidence_jump_km: float | None = Field(
        default=None, description="The configured minimum displacement threshold in km."
    )


class RuleFlagsEvidence(BaseModel):
    position_jump: RuleEvidencejump | None = Field(
        default=None, description="Evidence details for position jump rule."
    )
    duplicate_icao: RuleEvidencedup | None = Field(
        default=None, description="Evidence details for duplicate ICAO rule."
    )
    climb_rate: RuleEvidenceclimb | None = Field(
        default=None, description="Evidence details for climb rate rule."
    )
    alt_vel_mismatch: RuleEvidencealtvel | None = Field(
        default=None,
        description="Evidence details for altitude-velocity mismatch rule.",
    )
    low_signal_confidence: RuleEvidenceLowSignal | None = Field(
        default=None, description="Evidence details for low signal confidence rule."
    )


class TrilaterationEvidence(BaseModel):
    reason: str | None = Field(
        default=None, description="Trilateration status description."
    )
    num_receivers: int | None = Field(
        default=None, description="Number of ground station receivers."
    )


class ShapEvidence(BaseModel):
    rule_flags: RuleFlagsEvidence = Field(
        ..., description="Evidence data for rule triggers."
    )
    trilateration: TrilaterationEvidence | None = Field(
        default=None, description="Trilateration validation evidence."
    )
    model_scores: ModelScores = Field(
        ..., description="Runtimes scores from detection models."
    )


class ShapExplanation(BaseModel):
    shap: dict[str, Any] | None = Field(
        default_factory=dict,
        description="Feature importances mapped from SHAP explainer.",
    )
    evidence: ShapEvidence | None = Field(
        default=None, description="Structured aerodynamic evidence logs."
    )

    model_config = {"extra": "allow"}


class AlertResponse(BaseModel):
    id: int = Field(..., description="Unique integer ID of the alert.")
    icao24: str = Field(
        ..., description="The unique 24-bit ICAO hex identifier of the aircraft."
    )
    aircraft_state_id: int = Field(
        ..., description="ID of the raw aircraft state that triggered this alert."
    )
    rule_flags: list[str] = Field(
        ..., description="List of rule feature names triggered by this state."
    )
    ensemble_score: float | None = Field(
        default=None,
        description="Ensemble output, unavailable when the model is not enabled or loaded.",
    )
    autoencoder_score: float | None = Field(
        default=None,
        description="Autoencoder output, unavailable when the model is not enabled or loaded.",
    )
    combined_risk_score: float = Field(
        ..., description="Combined risk score from all classifiers (0.0 to 1.0)."
    )
    reason_text: str = Field(..., description="Narrated summary of anomaly triggers.")
    shap_explanation: ShapExplanation | dict[str, Any] = Field(
        default_factory=dict, description="Explainable AI details and metric logs."
    )
    detected_at: datetime = Field(
        ..., description="Timestamp when the detector generated this alert."
    )
    is_synthetic: bool = Field(
        ..., description="Whether this anomaly was programmatically injected."
    )
    acknowledged: bool = Field(
        ...,
        description="Whether this alert has been reviewed and acknowledged by an operator.",
    )

    model_config = {"from_attributes": True, "extra": "ignore"}


class AirspaceEventCandidate(BaseModel):
    """A reproducible space-time grouping of persisted real alerts, not a causal event verdict."""

    candidate_id: str
    status: str = "REVIEW_REQUIRED"
    start_time: datetime
    end_time: datetime
    center_latitude: float
    center_longitude: float
    aircraft_icao24: list[str]
    alert_ids: list[int]
    anomaly_types: list[str]
    linked_alert_pairs: int
    max_link_distance_km: float
    time_window_minutes: int
    radius_km: float
    evidence: list[dict[str, Any]] = Field(default_factory=list)

    model_config = {"extra": "forbid"}


class AirspaceEventCaseCreate(BaseModel):
    candidate_id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=3, max_length=200)
    alert_ids: list[int] = Field(min_length=2, max_length=1000)
    time_window_minutes: int = Field(ge=1, le=240)
    radius_km: float = Field(ge=1, le=500)

    model_config = {"extra": "forbid"}


class AirspaceEventCaseUpdate(BaseModel):
    status: Literal["OPEN", "IN_REVIEW", "CLOSED"] | None = None
    disposition: (
        Literal["CORRELATED", "NOT_CORRELATED", "INSUFFICIENT_EVIDENCE"] | None
    ) = None
    notes: str | None = Field(default=None, max_length=4000)

    model_config = {"extra": "forbid"}


class AirspaceEventCaseReviewResponse(BaseModel):
    id: int
    reviewer_id: int | None = None
    action: str
    previous_status: str | None = None
    new_status: str
    previous_disposition: str | None = None
    new_disposition: str | None = None
    notes: str | None = None
    ip_address: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True, "extra": "ignore"}


class AirspaceEventCaseResponse(BaseModel):
    id: int
    candidate_id: str
    title: str
    status: str
    disposition: str | None = None
    evidence_snapshot: dict[str, Any]
    created_by: int | None = None
    created_at: datetime
    updated_at: datetime
    closed_at: datetime | None = None
    reviews: list[AirspaceEventCaseReviewResponse] = Field(default_factory=list)

    model_config = {"from_attributes": True, "extra": "ignore"}


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

    model_config = {"from_attributes": True, "strict": True, "extra": "forbid"}


class SystemHealthResponse(BaseModel):
    database_status: str = "UNKNOWN"
    redis_status: str = "UNKNOWN"
    poll_latency_ms: float
    queue_depth: int
    circuit_breaker_state: str
    last_successful_poll: datetime | None = None
    last_poll_attempt: datetime | None = None
    last_poll_records: int = 0
    last_normalized_records: int = 0
    upstream_status: str = "UNKNOWN"
    feed_mode: str = "UNKNOWN"
    feed_source: str = "none"
    fallback_reason: str | None = None
    upstream_message: str = (
        "Waiting for the first response from the configured aircraft feed."
    )
    last_poll_http_status: int | None = None
    rate_limit_remaining: str | int | None = None
    total_real_states: int = 0
    total_synthetic_states: int = 0
    live_continuity_status: str = "UNKNOWN"
    seconds_since_last_poll: float | None = None
    max_allowed_poll_gap_seconds: float = 20.0
    continuity_gap_detected: bool = False
    continuity_message: str = "Live data polling is continuous and healthy."
    source_status: str = "AWAITING_TELEMETRY"
    source_name: str | None = None
    last_successful_update: datetime | None = None
    next_attempt_at: datetime | None = None
    retry_after: datetime | None = None
    snapshot_age_seconds: float | None = None
    snapshot_count: int | None = None
    consecutive_failures: int = 0
    last_error: str | None = None
    refresh_in_progress: bool = False
    manual_refresh_pending: bool = False
    refresh_interval_seconds: float | None = None

    model_config = {"strict": False, "extra": "ignore"}


class UserRegister(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=1024)
    role: str = "viewer"  # viewer, analyst, admin

    model_config = {"strict": True, "extra": "forbid"}


class UserLogin(BaseModel):
    email: str
    password: str

    model_config = {"strict": True, "extra": "forbid"}


class UserResponse(BaseModel):
    id: int
    email: str
    role: str
    created_at: datetime

    model_config = {"from_attributes": True, "strict": True, "extra": "forbid"}


class TokenResponse(BaseModel):
    access_token: str
    token_type: str

    model_config = {"strict": True, "extra": "forbid"}


class AuditLogResponse(BaseModel):
    id: int
    user_id: int | None = None
    action: str
    target_type: str
    target_id: str | None = None
    timestamp: datetime
    ip_address: str | None = None

    model_config = {"from_attributes": True, "strict": True, "extra": "forbid"}


class TrustHistoryPoint(BaseModel):
    timestamp: datetime = Field(..., description="Timestamp of the telemetry reading.")
    risk_score: float = Field(
        ...,
        description="Heuristic detector risk score for the recorded observation; not a probability.",
    )
    smoothed_risk_score: float = Field(
        ...,
        description="Weighted mean of available detector risk scores in the selected window.",
    )
    is_alert: bool = Field(
        default=False, description="Whether this state triggered a security alert."
    )
    reported_nic: int | None = Field(
        default=None, description="Navigation Integrity Category at this point."
    )

    model_config = {"from_attributes": True, "strict": True, "extra": "forbid"}


class AircraftTrustHistoryResponse(BaseModel):
    icao24: str = Field(..., description="Unique 24-bit ICAO aircraft address.")
    current_risk_score: float | None = Field(
        default=None,
        description="Latest heuristic detector risk score when scored observations exist.",
    )
    window_size: int = Field(
        ..., description="Configured smoothing window size in readings."
    )
    pattern: str = Field(
        ...,
        description="Observed score pattern, or UNASSESSED when evidence is insufficient.",
    )
    caption: str = Field(
        ...,
        description="Plain-English explanation of the observed detector-risk pattern.",
    )
    history: list[TrustHistoryPoint] = Field(
        ..., description="Chronological detector risk scores and their weighted mean."
    )

    model_config = {"from_attributes": True, "strict": True, "extra": "forbid"}


class FlightRouteResponse(BaseModel):
    icao24: str = Field(..., description="Unique 24-bit ICAO aircraft address.")
    session_id: str = Field(..., description="Active session identifier.")
    callsign: str | None = Field(default=None, description="Aircraft callsign.")
    est_departure_airport: str | None = Field(
        default=None, description="ICAO code of estimated departure airport."
    )
    est_arrival_airport: str | None = Field(
        default=None, description="ICAO code of estimated arrival airport."
    )
    first_seen: datetime | None = Field(
        default=None, description="Estimated departure / first seen timestamp."
    )
    last_seen: datetime | None = Field(
        default=None, description="Estimated arrival / last seen timestamp."
    )
    route_text: str = Field(
        default="Route unknown",
        description="Formatted flight route or 'Route unknown'.",
    )
    fetched_at: datetime | None = Field(
        default=None, description="When route info was sourced and cached."
    )
    dep_lat: float | None = Field(
        default=None, description="Latitude of departure airport."
    )
    dep_lng: float | None = Field(
        default=None, description="Longitude of departure airport."
    )
    arr_lat: float | None = Field(
        default=None, description="Latitude of arrival airport."
    )
    arr_lng: float | None = Field(
        default=None, description="Longitude of arrival airport."
    )

    model_config = {"from_attributes": True, "strict": True, "extra": "ignore"}


class AircraftIdentityResponse(BaseModel):
    registration: str | None = Field(
        default=None,
        description="Aircraft physical tail registration (e.g. VT-EXO or N12345).",
    )
    typecode: str | None = Field(
        default=None, description="ICAO aircraft type code or category."
    )
    model: str | None = Field(
        default=None, description="Airframe model description when known."
    )
    operator: str | None = Field(
        default=None, description="Operating airline or entity when known."
    )
    country: str | None = Field(
        default=None, description="Country of registration when known."
    )
    source: str = Field(default="unknown", description="Metadata provenance.")

    model_config = {"from_attributes": True, "strict": True, "extra": "ignore"}


class AircraftTrustDetailResponse(BaseModel):
    status_text: str = Field(
        ..., description="Assessment state; absence of a flag is not verification."
    )
    is_flagged: bool = Field(
        ...,
        description="Whether aircraft currently has active security alerts or inconsistencies.",
    )
    combined_risk_score: float | None = Field(
        default=None,
        description="Instantaneous combined risk score when the detector produced one.",
    )
    trust_score: float | None = Field(
        default=None,
        description="Derived Telemetry Trust Index (0-100 scale); inverse of combined risk.",
    )
    evidence_confidence: float | None = Field(
        default=None,
        description="Proportion of the intended detector evidence stack available.",
    )
    assessment_status: str | None = Field(
        default=None,
        description="Canonical assessment status: ASSESSED, PARTIALLY_ASSESSED, REVIEW_REQUIRED, INSUFFICIENT_EVIDENCE, SUPPRESSED.",
    )
    smoothed_risk_score: float | None = Field(
        default=None,
        description="Weighted detector risk score when available; not a trust rating.",
    )
    explanation: str = Field(
        ..., description="Story Mode plain-English narrative explanation."
    )
    reasons: list[str] = Field(
        default_factory=list, description="List of detected anomaly triggers."
    )
    rule_flags: dict[str, bool] = Field(
        default_factory=dict, description="Active physical rule violation flags."
    )
    technical_details: dict[str, Any] = Field(
        default_factory=dict,
        description="Technical diagnostics (SHAP, ensemble, autoencoder).",
    )
    unavailable_reasons: list[str] = Field(
        default_factory=list,
        description="List of reasons why optional evidence layers are unavailable.",
    )
    trilateration_stations: int | None = Field(
        default=None,
        description="Number of measured receiver observations, when supplied by the source.",
    )
    last_evaluated_at: datetime | None = Field(
        default=None, description="Timestamp of the most recent security evaluation."
    )

    model_config = {"from_attributes": True, "strict": True, "extra": "ignore"}


class AircraftStalenessResponse(BaseModel):
    status: str = Field(default="LIVE", description="'LIVE' or 'STALE'")
    is_stale: bool = Field(
        default=False,
        description="Whether aircraft has missed consecutive poll updates.",
    )
    last_seen_seconds_ago: float = Field(
        default=0.0, description="Elapsed seconds since most recent received telemetry."
    )
    last_received_at: datetime = Field(
        ..., description="Timestamp of last received telemetry state."
    )
    staleness_threshold_seconds: float = Field(
        default=20.0, description="Threshold after which aircraft is marked STALE."
    )
    removal_threshold_seconds: float = Field(
        default=120.0,
        description="Threshold after which aircraft fades from live feed.",
    )

    model_config = {"from_attributes": True, "strict": True, "extra": "ignore"}


class AircraftDetailResponse(BaseModel):
    icao24: str = Field(..., description="Unique 24-bit ICAO aircraft address.")
    callsign: str | None = Field(default=None, description="Aircraft callsign.")
    live_state: AircraftStateResponse = Field(
        ..., description="Most recent physical telemetry state vector."
    )
    route: FlightRouteResponse = Field(
        ..., description="Resolved departure, arrival, and route progression."
    )
    identity: AircraftIdentityResponse = Field(
        ..., description="Airframe identity, registration, model, and operator."
    )
    trust_status: AircraftTrustDetailResponse = Field(
        ..., description="Trust evaluation, risk scores, and Story Mode narrative."
    )
    staleness: AircraftStalenessResponse = Field(
        ..., description="Tracking freshness and signal continuity status."
    )
    first_seen_session: datetime | None = Field(
        default=None,
        description="Timestamp when aircraft was first tracked in the current session.",
    )

    model_config = {"from_attributes": True, "strict": True, "extra": "ignore"}
