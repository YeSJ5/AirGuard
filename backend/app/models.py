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
    ensemble_score: Mapped[float] = mapped_column(Float)
    autoencoder_score: Mapped[float] = mapped_column(Float)
    combined_risk_score: Mapped[float] = mapped_column(Float)
    reason_text: Mapped[str] = mapped_column(Text)
    shap_explanation: Mapped[Dict[str, Any]] = mapped_column(JSONB)
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    is_synthetic: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    acknowledged: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    # Relationships
    aircraft_state: Mapped["AircraftState"] = relationship(back_populates="alerts")


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
