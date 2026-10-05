import os
import sys
import json
import urllib.request
from jose import jwt
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.abspath('f:/major_project/backend'))
from app.core.config import settings

def test_live_aircraft_and_scores():
    # 1. Create a valid test admin/analyst JWT token
    payload = {
        "sub": "admin@airguard.local",
        "role": "admin",
        "exp": datetime.now(timezone.utc) + timedelta(hours=1)
    }
    token = jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

    print("==========================================================================================")
    print("LIVE RUNTIME AIRGUARD PIPELINE & SCORES VALIDATION")
    print("==========================================================================================")
    
    # 2. Query /api/v1/aircraft
    req = urllib.request.Request("http://127.0.0.1:8001/api/v1/aircraft", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            ac_list = data.get("aircraft", [])
            print(f"1. /api/v1/aircraft [HTTP {resp.getcode()}]: Total active in stream = {len(ac_list)}")
            
            # Print breakdown of first 10
            print(f"\n2. Real-Time Aircraft Telemetry Trust Index & Risk Breakdown (Sample 10):")
            print("-" * 125)
            print(f"{'ICAO24':<8} | {'Callsign':<10} | {'Lat, Lon':<20} | {'Risk':<10} | {'Trust Index':<14} | {'Confidence':<12} | {'Assessment Status'}")
            print("-" * 125)
            
            scored_count = 0
            for ac in ac_list[:10]:
                icao = ac.get("icao24")
                cs = (ac.get("callsign") or "").strip() or "N/A"
                pos = f"{ac.get('latitude', 0):.2f}, {ac.get('longitude', 0):.2f}"
                risk = ac.get("combined_risk_score")
                trust = ac.get("trust_score")
                conf = ac.get("evidence_confidence")
                status = ac.get("assessment_status")
                
                risk_str = f"{risk:.4f}" if risk is not None else "None"
                trust_str = f"{trust}%" if trust is not None else "None"
                conf_str = f"{int(conf*100)}%" if conf is not None else "None"
                
                if trust is not None:
                    scored_count += 1
                
                print(f"{icao:<8} | {cs:<10} | {pos:<20} | {risk_str:<10} | {trust_str:<14} | {conf_str:<12} | {status}")

            # Inspect single detail
            if ac_list:
                sample_icao = ac_list[0].get("icao24")
                d_req = urllib.request.Request(f"http://127.0.0.1:8001/api/v1/aircraft/{sample_icao}/detail", headers=headers)
                with urllib.request.urlopen(d_req, timeout=5) as d_resp:
                    d_data = json.loads(d_resp.read().decode('utf-8'))
                    print(f"\n3. Target Inspection Detail for {sample_icao}:")
                    print(f"   - Assessment Status: {d_data.get('assessment_status')}")
                    print(f"   - Combined Risk Score: {d_data.get('combined_risk_score')}")
                    print(f"   - Telemetry Trust Index: {d_data.get('trust_score')}%")
                    print(f"   - Evidence Confidence: {d_data.get('evidence_confidence')}")
                    print(f"   - Detector Status: {d_data.get('detector_status')}")
                    print(f"   - Unassessed Layers: {d_data.get('unavailable_reasons')}")
    except Exception as e:
        print(f"API Request Failed: {e}")

if __name__ == '__main__':
    test_live_aircraft_and_scores()
