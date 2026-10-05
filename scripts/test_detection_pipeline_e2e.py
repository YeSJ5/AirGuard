import os
import sys
import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

sys.path.insert(0, os.path.abspath('f:/major_project/backend'))

from app.detection.service import DetectionService
from app.detection.autoencoder import UnsupervisedAutoencoder

async def run_pipeline_test():
    print("==========================================================================================")
    print("END-TO-END DETECTION SERVICE PIPELINE VALIDATION ON REAL TELEMETRY VECTORS")
    print("==========================================================================================")
    
    # Initialize real autoencoder model
    ae_model = UnsupervisedAutoencoder()
    
    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=MagicMock(scalar_one_or_none=lambda: None))
    mock_session.commit = AsyncMock()
    mock_session.flush = AsyncMock()
    mock_session.add = MagicMock()
    
    class MockSessionContext:
        async def __aenter__(self):
            return mock_session
        async def __aexit__(self, exc_type, exc_val, exc_tb):
            return None
            
    mock_db = MagicMock(return_value=MockSessionContext())
    
    det = DetectionService(db_session_maker=mock_db, autoencoder_model=ae_model)
    
    t0 = datetime(2026, 10, 5, 1, 0, 0, tzinfo=timezone.utc)
    t1 = datetime(2026, 10, 5, 1, 0, 10, tzinfo=timezone.utc)
    
    test_stream = [
        # Aircraft 1: AIC101 (Steady level flight)
        {
            "icao24": "8002a1", "callsign": "AIC101", "received_at": t0,
            "latitude": 28.556, "longitude": 77.100, "altitude_m": 10000.0,
            "velocity_ms": 230.0, "heading_deg": 90.0, "vertical_rate_ms": 0.0,
            "on_ground": False, "data_quality": {"observed_fields": ["vertical_rate", "altitude", "velocity", "on_ground"]}
        },
        {
            "icao24": "8002a1", "callsign": "AIC101", "received_at": t1,
            "latitude": 28.557, "longitude": 77.123, "altitude_m": 10000.0,
            "velocity_ms": 230.2, "heading_deg": 90.1, "vertical_rate_ms": 0.0,
            "on_ground": False, "data_quality": {"observed_fields": ["vertical_rate", "altitude", "velocity", "on_ground"]}
        },
        
        # Aircraft 2: IGO452 (Climbing turn)
        {
            "icao24": "8003b2", "callsign": "IGO452", "received_at": t0,
            "latitude": 19.088, "longitude": 72.868, "altitude_m": 1500.0,
            "velocity_ms": 150.0, "heading_deg": 270.0, "vertical_rate_ms": 12.0,
            "on_ground": False, "data_quality": {"observed_fields": ["vertical_rate", "altitude", "velocity", "on_ground"]}
        },
        {
            "icao24": "8003b2", "callsign": "IGO452", "received_at": t1,
            "latitude": 19.090, "longitude": 72.850, "altitude_m": 1620.0,
            "velocity_ms": 155.0, "heading_deg": 275.0, "vertical_rate_ms": 11.8,
            "on_ground": False, "data_quality": {"observed_fields": ["vertical_rate", "altitude", "velocity", "on_ground"]}
        },
        
        # Aircraft 3: SPOOF9 (Impossible Kinematic Telemetry Jump)
        {
            "icao24": "8009f9", "callsign": "SPOOF9", "received_at": t0,
            "latitude": 13.198, "longitude": 77.706, "altitude_m": 3000.0,
            "velocity_ms": 200.0, "heading_deg": 0.0, "vertical_rate_ms": 0.0,
            "on_ground": False, "data_quality": {"observed_fields": ["vertical_rate", "altitude", "velocity", "on_ground"]}
        },
        {
            "icao24": "8009f9", "callsign": "SPOOF9", "received_at": t1,
            "latitude": 14.500, "longitude": 79.000, "altitude_m": 12000.0,
            "velocity_ms": 950.0, "heading_deg": 180.0, "vertical_rate_ms": 150.0,
            "on_ground": False, "data_quality": {"observed_fields": ["vertical_rate", "altitude", "velocity", "on_ground"]}
        },
    ]
    
    print("\n1. Processing Real Telemetry Vectors through DetectionService...")
    results = {}
    for rec in test_stream:
        res = await det.process_record(rec)
        if res:
            results[rec["icao24"]] = res
            
    print("\n2. Evaluated Pipeline Outputs:")
    print("-" * 125)
    print(f"{'ICAO24':<8} | {'Combined Risk':<15} | {'Trust Score':<14} | {'Confidence':<12} | {'Assessment Status':<20}")
    print("-" * 125)
    
    for icao, res in results.items():
        risk = res["combined_risk_score"]
        trust = res["trust_score"]
        conf = res["evidence_confidence"]
        status = res["assessment_status"]
        
        cached = det.get_latest_score(icao)
        print(f"{icao:<8} | {risk:<15.4f} | {trust:<14}% | {int(conf*100):<12}% | {status:<20}")
        print(f"   -> Breakdown: AE Score={cached.get('autoencoder_score')}, Ens Score={cached.get('ensemble_score')}, Rule Coverage={int(cached.get('rule_assessment_coverage',0)*100)}%")
        if cached.get("unavailable_reasons"):
            print(f"   -> Honest Missing Layer Disclosures: {cached.get('unavailable_reasons')}")
        print()

if __name__ == '__main__':
    asyncio.run(run_pipeline_test())
