from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class AircraftState(Base):
    __tablename__ = "aircraft_states"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    ingestion_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    icao24: Mapped[str] = mapped_column(String(6), index=True)
    callsign: Mapped[str | None] = mapped_column(String(10), nullable=True)
    squawk: Mapped[str | None] = mapped_column(String(8), nullable=True)
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    altitude_m: Mapped[float] = mapped_column(Float)
    velocity_ms: Mapped[float] = mapped_column(Float)
    heading_deg: Mapped[float] = mapped_column(Float)
    vertical_rate_ms: Mapped[float] = mapped_column(Float)
    on_ground: Mapped[bool] = mapped_column(Boolean)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    source: Mapped[str] = mapped_column(
        String(20), default="opensky", server_default="opensky"
    )
    reported_nic: Mapped[int | None] = mapped_column(Integer, nullable=True)
    data_quality: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default="{}"
    )
    is_synthetic: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )

    # Relationships
    alerts: Mapped[list["Alert"]] = relationship(back_populates="aircraft_state")

    # Composite Index (icao24, received_at DESC)
    __table_args__ = (
        Index("idx_states_icao_received_desc", "icao24", received_at.desc()),
        Index("uq_aircraft_states_ingestion_id", "ingestion_id", unique=True),
    )


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    icao24: Mapped[str] = mapped_column(String(6))
    aircraft_state_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("aircraft_states.id"), nullable=False
    )
    rule_flags: Mapped[list[str]] = mapped_column(ARRAY(Text))
    ensemble_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    autoencoder_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    combined_risk_score: Mapped[float] = mapped_column(Float)
    reason_text: Mapped[str] = mapped_column(Text)
    shap_explanation: Mapped[dict[str, Any]] = mapped_column(JSONB)
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    is_synthetic: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    acknowledged: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )

    # Relationships
    aircraft_state: Mapped["AircraftState"] = relationship(back_populates="alerts")


class AircraftAssessment(Base):
    """Versioned detector output for every persisted telemetry observation."""

    __tablename__ = "aircraft_assessments"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    aircraft_state_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("aircraft_states.id", ondelete="CASCADE"),
        unique=True,
        nullable=False,
    )
    icao24: Mapped[str] = mapped_column(String(6), index=True, nullable=False)
    combined_risk_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    rule_assessment_coverage: Mapped[float] = mapped_column(
        Float, nullable=False, default=0.0
    )
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    signals: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    detector_version: Mapped[str] = mapped_column(
        String(32), nullable=False, default="rules-v2"
    )
    assessed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )


class ModelRun(Base):
    __tablename__ = "model_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    model_version: Mapped[str] = mapped_column(String(20))
    true_positives: Mapped[int] = mapped_column(Integer)
    false_positives: Mapped[int] = mapped_column(Integer)
    true_negatives: Mapped[int] = mapped_column(Integer)
    false_negatives: Mapped[int] = mapped_column(Integer)
    precision: Mapped[float] = mapped_column(Float)
    recall: Mapped[float] = mapped_column(Float)
    f1: Mapped[float] = mapped_column(Float)
    notes: Mapped[str] = mapped_column(Text)


class KnownEntity(Base):
    __tablename__ = "known_entities"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    icao24: Mapped[str] = mapped_column(String(6), unique=True)
    label: Mapped[str] = mapped_column(String(50))
    source: Mapped[str] = mapped_column(String(50))
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(
        String(255), unique=True, index=True, nullable=False
    )
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(
        String(20), nullable=False
    )  # viewer, analyst, admin
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow
    )

    # Relationships
    audit_logs: Mapped[list["AuditLog"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(50), nullable=False)
    target_type: Mapped[str] = mapped_column(String(50), nullable=False)
    target_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    timestamp: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow
    )
    ip_address: Mapped[str | None] = mapped_column(String(50), nullable=True)

    # Relationships
    user: Mapped[Optional["User"]] = relationship(back_populates="audit_logs")


class AirspaceEventCase(Base):
    """Analyst-owned case built from an immutable snapshot of real alert evidence."""

    __tablename__ = "airspace_event_cases"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    candidate_id: Mapped[str] = mapped_column(String(100), index=True, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="OPEN", server_default="OPEN", index=True
    )
    disposition: Mapped[str | None] = mapped_column(String(40), nullable=True)
    evidence_snapshot: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    closed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    reviews: Mapped[list["AirspaceEventCaseReview"]] = relationship(
        back_populates="event_case",
        cascade="all, delete-orphan",
        order_by="AirspaceEventCaseReview.created_at",
    )

    __table_args__ = (
        Index(
            "uq_airspace_event_cases_open_candidate",
            "candidate_id",
            unique=True,
            postgresql_where=text("status <> 'CLOSED'"),
        ),
    )


class AirspaceEventCaseReview(Base):
    """Append-only case state transition and analyst rationale."""

    __tablename__ = "airspace_event_case_reviews"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    case_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("airspace_event_cases.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    reviewer_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(30), nullable=False)
    previous_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    new_status: Mapped[str] = mapped_column(String(20), nullable=False)
    previous_disposition: Mapped[str | None] = mapped_column(String(40), nullable=True)
    new_disposition: Mapped[str | None] = mapped_column(String(40), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )

    event_case: Mapped[AirspaceEventCase] = relationship(back_populates="reviews")


class FlightRoute(Base):
    __tablename__ = "flight_routes"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    icao24: Mapped[str] = mapped_column(String(6), index=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    callsign: Mapped[str | None] = mapped_column(String(10), nullable=True)
    est_departure_airport: Mapped[str | None] = mapped_column(String(10), nullable=True)
    est_arrival_airport: Mapped[str | None] = mapped_column(String(10), nullable=True)
    first_seen: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_seen: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    route_text: Mapped[str] = mapped_column(
        String(100), default="Route unknown", server_default="Route unknown"
    )
    fetched_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=datetime.utcnow
    )

    __table_args__ = (
        Index("idx_flight_routes_icao_session", "icao24", "session_id", unique=True),
    )
