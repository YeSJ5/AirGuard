from datetime import datetime
from typing import List, Dict, Any, Optional
from sqlalchemy import String, Float, Boolean, DateTime, Text, BigInteger, Integer, ForeignKey, Index
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

class AircraftState(Base):
    __tablename__ = "aircraft_states"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    icao24: Mapped[str] = mapped_column(String(6), index=True)
    callsign: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    altitude_m: Mapped[float] = mapped_column(Float)
    velocity_ms: Mapped[float] = mapped_column(Float)
    heading_deg: Mapped[float] = mapped_column(Float)
    vertical_rate_ms: Mapped[float] = mapped_column(Float)
    on_ground: Mapped[bool] = mapped_column(Boolean)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    source: Mapped[str] = mapped_column(String(20), default="opensky", server_default="opensky")
    reported_nic: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    data_quality: Mapped[Dict[str, Any]] = mapped_column(JSONB, default=dict, server_default="{}")
    is_synthetic: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    # Relationships
    alerts: Mapped[List["Alert"]] = relationship(back_populates="aircraft_state")

    # Composite Index (icao24, received_at DESC)
    __table_args__ = (
        Index("idx_states_icao_received_desc", "icao24", received_at.desc()),
    )


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    icao24: Mapped[str] = mapped_column(String(6))
    aircraft_state_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("aircraft_states.id"), nullable=False)
    rule_flags: Mapped[List[str]] = mapped_column(ARRAY(Text))
    ensemble_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    autoencoder_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    combined_risk_score: Mapped[float] = mapped_column(Float)
    reason_text: Mapped[str] = mapped_column(Text)
    shap_explanation: Mapped[Dict[str, Any]] = mapped_column(JSONB)
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    is_synthetic: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    acknowledged: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    # Relationships
    aircraft_state: Mapped["AircraftState"] = relationship(back_populates="alerts")


class AircraftAssessment(Base):
    """Versioned detector output for every persisted telemetry observation."""
    __tablename__ = "aircraft_assessments"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    aircraft_state_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("aircraft_states.id", ondelete="CASCADE"), unique=True, nullable=False)
    icao24: Mapped[str] = mapped_column(String(6), index=True, nullable=False)
    combined_risk_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    evidence_confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    signals: Mapped[Dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    detector_version: Mapped[str] = mapped_column(String(32), nullable=False, default="rules-v2")
    assessed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)


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
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)  # viewer, analyst, admin
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    # Relationships
    audit_logs: Mapped[List["AuditLog"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[Optional[int]] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    action: Mapped[str] = mapped_column(String(50), nullable=False)
    target_type: Mapped[str] = mapped_column(String(50), nullable=False)
    target_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)
    ip_address: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)

    # Relationships
    user: Mapped[Optional["User"]] = relationship(back_populates="audit_logs")


class FlightRoute(Base):
    __tablename__ = "flight_routes"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    icao24: Mapped[str] = mapped_column(String(6), index=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    callsign: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    est_departure_airport: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    est_arrival_airport: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    first_seen: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_seen: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    route_text: Mapped[str] = mapped_column(String(100), default="Route unknown", server_default="Route unknown")
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=datetime.utcnow)

    __table_args__ = (
        Index("idx_flight_routes_icao_session", "icao24", "session_id", unique=True),
    )

