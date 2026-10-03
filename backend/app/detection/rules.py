import math
from datetime import datetime
from typing import Dict, Any, Tuple, Optional
from pydantic import BaseModel, Field

# --- Aviation Reference Threshold Config ---

class RuleConfig(BaseModel):
    # 1. Implied Speed Check
    # Citation: Cruising speeds of commercial jetliners (e.g. Boeing 777, Airbus A350) typically range 
    # between 850 km/h and 950 km/h. Supersonic flight is restricted over civil land.
    # 1200 km/h (~Mach 0.98) serves as a conservative upper bound for non-military flight dynamics.
    max_implied_speed_kmh: float = Field(
        default=1200.0,
        description="Maximum physical ground speed allowed between successive updates in km/h"
    )

    # 2. Duplicate ICAO Check
    # Citation: Signal range of ADS-B ground stations is typically ~150-250 nautical miles (~270-460 km).
    # Since an aircraft cannot teleport, receiving identical ICAO codes in different locations 
    # >50 km apart within the same second indicates address cloning or transmitter spoofing.
    duplicate_icao_dist_km: float = Field(
        default=50.0,
        description="Minimum distance separation in km to classify reports in the same second as duplicate"
    )

    # 3. Impossible Climb Rate Check
    # Citation: Maximum climb rates for civil aircraft (e.g. Boeing 737) are usually 15-20 m/s (~3000-4000 ft/min).
    # Fighter jets can climb at up to 250 m/s. An absolute boundary limit of ±50 m/s (~9840 ft/min)
    # is set to flag anomalous jumps in altitude telemetry for normal civilian trackers.
    max_vertical_rate_ms: float = Field(
        default=50.0,
        description="Maximum absolute vertical climb or descent speed in m/s"
    )

    # 4. Altitude/Velocity Mismatch
    # Citation: Ground roll take-off decision speed (V1) rarely exceeds 150 knots (~77 m/s) on runway.
    # Safe taxi speed is under 30 knots. Any target on the ground at >100 meters altitude 
    # or traveling at aircraft cruise speeds is physically inconsistent.
    # Conversely, airborne state with 0 altitude and 0 velocity indicates data inconsistency/spoofing.
    max_ground_altitude_m: float = Field(
        default=100.0,
        description="Maximum altitude threshold allowed when on_ground is True"
    )
    max_ground_speed_ms: float = Field(
        default=77.0,
        description="Maximum velocity allowed when on_ground is True"
    )
    min_flight_speed_ms: float = Field(
        default=20.0,
        description="Minimum flight speed threshold required when airborne (on_ground is False)"
    )

    # 5. Low Signal Confidence Check (Reported NIC + Spatial Displacement)
    # Citation: RTCA DO-260B / FAA TSO-C166b standardizes the Navigation Integrity Category (NIC 0-11).
    # Controlled civil airspace mandates NIC >= 7 (Containment Radius Rc < 0.2 NM / ~370 m).
    # NIC < 7 indicates degraded satellite geometry, RF interference, or GPS receiver unlock.
    # GPSJam.org uses this exact ADS-B self-reported integrity degradation to detect real-world GNSS jamming/spoofing zones.
    # While degraded NIC alone can occur transiently (e.g., steep banking), low confidence coupled with
    # a significant position jump indicates anomalous flight telemetry or deliberate spoofing.
    min_reliable_nic: int = Field(
        default=7,
        description="Minimum acceptable Navigation Integrity Category (0-11). Below this indicates degraded GPS."
    )
    min_confidence_jump_km: float = Field(
        default=10.0,
        description="Minimum position displacement in km required alongside low NIC to trigger low_signal_confidence."
    )


# --- Helper Math Functions ---

def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate the great-circle distance between two points in kilometers."""
    R = 6371.0 # Earth's radius in km

    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (math.sin(delta_phi / 2.0) ** 2) + \
        (math.cos(phi1) * math.cos(phi2) * (math.sin(delta_lambda / 2.0) ** 2))
    
    # Safely bound 'a' value due to float precision limits
    a = min(1.0, max(0.0, a))
    
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return R * c


# --- Ingestion Rule Checks ---

def check_position_jump(
    current_lat: float,
    current_lon: float,
    current_time: datetime,
    prev_lat: float,
    prev_lon: float,
    prev_time: datetime,
    config: RuleConfig = RuleConfig()
) -> Tuple[bool, Optional[str], Dict[str, Any]]:
    """Compute haversine distance and implied speed. Flags values exceeding limits."""
    dt = (current_time - prev_time).total_seconds()
    
    # Ignore out-of-order, simultaneous updates, or stale contacts (>120s gap)
    if dt <= 0.0 or dt > 120.0:
        return False, None, {}

    dist = haversine_distance(prev_lat, prev_lon, current_lat, current_lon)
    implied_speed_kmh = (dist / (dt / 3600.0))

    evidence = {
        "prev_coords": (prev_lat, prev_lon),
        "current_coords": (current_lat, current_lon),
        "distance_km": dist,
        "time_delta_sec": dt,
        "implied_speed_kmh": implied_speed_kmh
    }

    if implied_speed_kmh > config.max_implied_speed_kmh:
        reason = (
            f"Implied speed of {implied_speed_kmh:.1f} km/h between reports "
            f"(dt={dt:.1f}s) exceeds realistic civil aviation threshold of {config.max_implied_speed_kmh:.1f} km/h."
        )
        return True, reason, evidence

    return False, None, evidence


def check_duplicate_icao(
    lat_a: float,
    lon_a: float,
    time_a: datetime,
    lat_b: float,
    lon_b: float,
    time_b: datetime,
    config: RuleConfig = RuleConfig()
) -> Tuple[bool, Optional[str], Dict[str, Any]]:
    """Flags if the same address reports locations >50 km apart in the same second."""
    dt = abs((time_a - time_b).total_seconds())
    
    # We restrict this check to telemetry reported within the same second
    if dt > 1.0:
        return False, None, {}

    dist = haversine_distance(lat_a, lon_a, lat_b, lon_b)

    evidence = {
        "coords_a": (lat_a, lon_a),
        "coords_b": (lat_b, lon_b),
        "distance_km": dist,
        "time_delta_sec": dt
    }

    if dist > config.duplicate_icao_dist_km:
        reason = (
            f"Duplicate ICAO address reported at positions {dist:.1f} km apart "
            f"within same second (dt={dt:.2f}s). Indicates clone transmitter."
        )
        return True, reason, evidence

    return False, None, evidence


def check_impossible_climb_rate(
    vertical_rate_ms: float,
    config: RuleConfig = RuleConfig()
) -> Tuple[bool, Optional[str], Dict[str, Any]]:
    """Flags telemetry where vertical rate climbs/descends faster than envelope limits."""
    abs_rate = abs(vertical_rate_ms)
    
    evidence = {
        "vertical_rate_ms": vertical_rate_ms,
        "abs_vertical_rate_ms": abs_rate
    }

    if abs_rate > config.max_vertical_rate_ms:
        reason = (
            f"Vertical rate of {vertical_rate_ms:.1f} m/s exceeds performance envelope "
            f"limit of ±{config.max_vertical_rate_ms:.1f} m/s (~9840 ft/min)."
        )
        return True, reason, evidence

    return False, None, evidence


def check_altitude_velocity_mismatch(
    altitude_m: float,
    velocity_ms: float,
    on_ground: bool,
    config: RuleConfig = RuleConfig()
) -> Tuple[bool, Optional[str], Dict[str, Any]]:
    """Validates physical consistency of speed, height, and land/airborne status flags."""
    evidence = {
        "altitude_m": altitude_m,
        "velocity_ms": velocity_ms,
        "on_ground": on_ground
    }

    if on_ground:
        # Check if ground vehicle is at high altitude
        if altitude_m > config.max_ground_altitude_m:
            reason = (
                f"Physical inconsistency: Target reports on_ground=True but has altitude "
                f"of {altitude_m:.1f}m (exceeds ground boundary limit of {config.max_ground_altitude_m:.1f}m)."
            )
            return True, reason, evidence
        
        # Check if taxiing vehicle speed exceeds take-off boundary
        if velocity_ms > config.max_ground_speed_ms:
            reason = (
                f"Physical inconsistency: Target reports on_ground=True but has speed "
                f"of {velocity_ms:.1f} m/s (exceeds runway velocity limit of {config.max_ground_speed_ms:.1f} m/s)."
            )
            return True, reason, evidence
            
    else: # Airborne (on_ground is False)
        # Check if airborne target has zero altitude and speed below stall limits
        if altitude_m <= 0.0 and velocity_ms < config.min_flight_speed_ms:
            reason = (
                f"Physical inconsistency: Target reports on_ground=False (airborne) but has zero altitude "
                f"and speed below flight stall threshold ({velocity_ms:.1f} m/s < {config.min_flight_speed_ms:.1f} m/s)."
            )
            return True, reason, evidence

    return False, None, evidence


def check_low_signal_confidence(
    reported_nic: Optional[int],
    current_lat: float,
    current_lon: float,
    prev_lat: Optional[float] = None,
    prev_lon: Optional[float] = None,
    config: RuleConfig = RuleConfig()
) -> Tuple[bool, Optional[str], Dict[str, Any]]:
    """Flags when self-reported navigation accuracy is below threshold combined with significant position jump.

    A low confidence signal alone is not sufficient to flag spoofing (satellite banking or poor GDOP
    can transiently lower NIC). However, degraded confidence paired with significant spatial displacement
    is a strong indicator of spoofing/jamming telemetry (as demonstrated by GPSJam.org).
    """
    evidence = {
        "reported_nic": reported_nic,
        "min_reliable_nic": config.min_reliable_nic,
        "distance_km": None,
        "min_confidence_jump_km": config.min_confidence_jump_km
    }

    if reported_nic is None:
        return False, None, evidence

    if reported_nic >= config.min_reliable_nic:
        return False, None, evidence

    # reported_nic < config.min_reliable_nic
    if prev_lat is not None and prev_lon is not None:
        dist = haversine_distance(prev_lat, prev_lon, current_lat, current_lon)
        evidence["distance_km"] = dist

        if dist > config.min_confidence_jump_km:
            reason = (
                f"Low signal confidence anomaly: self-reported NIC {reported_nic} is below reliable "
                f"threshold ({config.min_reliable_nic}) combined with significant position displacement "
                f"of {dist:.1f} km (threshold: {config.min_confidence_jump_km:.1f} km)."
            )
            return True, reason, evidence

    return False, None, evidence


