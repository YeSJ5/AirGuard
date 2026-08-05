import argparse
import time
import httpx

API_URL = "http://localhost:8001/api/v1/inject"

ANOMALY_INFO = {
    "position_jump": {
        "desc": "Position jump of 5.0 degrees (~550 km) from last recorded coordinates.",
        "layer": "Aerodynamic Rules (position_jump)",
        "expected_reason": "Implied speed of XXX km/h between reports (dt=10.0s) exceeds realistic civil aviation threshold of 1200.0 km/h."
    },
    "duplicate_icao": {
        "desc": "Cloned ICAO target coordinates offset by 1.0 degree (~110 km) in the same second.",
        "layer": "Aerodynamic Rules (duplicate_icao)",
        "expected_reason": "Duplicate ICAO address reported at positions XXX km apart within same second."
    },
    "impossible_climb": {
        "desc": "Vertical rate set to 80.0 m/s (~15,700 ft/min) climbing.",
        "layer": "Aerodynamic Rules (impossible_climb_rate)",
        "expected_reason": "Vertical rate of 80.0 m/s exceeds performance envelope limit of ±50.0 m/s."
    },
    "altitude_velocity_mismatch": {
        "desc": "Target reported on ground (on_ground=True) at 5000m altitude and traveling at 250 m/s (485 kts).",
        "layer": "Aerodynamic Rules (altitude_velocity_mismatch)",
        "expected_reason": "Physical inconsistency: Target reports on_ground=True but has altitude of 5000.0m."
    }
}

def inject(icao24, anomaly_type):
    info = ANOMALY_INFO[anomaly_type]
    print(f"\n======================================================================")
    print(f"📡 NARRATION: Initializing anomaly injection sequencing...")
    print(f"👉 Target Aircraft (ICAO24) : {icao24.upper()}")
    print(f"👉 Anomaly Type Triggered   : {anomaly_type.upper()}")
    print(f"👉 Physical Details Injected: {info['desc']}")
    print(f"👉 Expected Detection Layer  : {info['layer']}")
    print(f"👉 Expected Reason Text     : {info['expected_reason']}")
    print(f"======================================================================")
    
    payload = {
        "icao24": icao24,
        "type": anomaly_type,
        "callsign": f"SYN-{anomaly_type[:3].upper()}"
    }
    
    try:
        res = httpx.post(API_URL, json=payload, timeout=5.0)
        if res.status_code == 200:
            print(f"✅ Ingestion Queue Injection Succeeded.")
            print(f"Response: {res.json()['status']}")
        else:
            print(f"❌ Ingestion Queue Injection Failed. HTTP {res.status_code}: {res.text}")
    except Exception as e:
        print(f"❌ Connection to backend failed: {e}")
        print("Please check that the AirGuard FastAPI server is running on http://localhost:8000")

def run_batch(icao24):
    print("\n🚀 Starting scripted multi-minute batch demo sequence...")
    print("----------------------------------------------------------------------")
    types = ["impossible_climb", "altitude_velocity_mismatch", "position_jump", "duplicate_icao"]
    for idx, t in enumerate(types):
        inject(icao24, t)
        if idx < len(types) - 1:
            print(f"\n⏳ Waiting 5 seconds before next injection...")
            time.sleep(5)
    print("\n🏁 Scripted multi-minute batch demo sequence completed.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AirGuard Live Anomaly Injector Tool")
    parser.add_argument("--type", choices=list(ANOMALY_INFO.keys()), help="Anomaly type to inject")
    parser.add_argument("--icao24", default="a1b2c3", help="ICAO 24-bit hex address of the target aircraft")
    parser.add_argument("--batch", action="store_true", help="Run batch sequence of all anomaly types")
    
    args = parser.parse_args()
    
    if args.batch:
        run_batch(args.icao24)
    elif args.type:
        inject(args.icao24, args.type)
    else:
        parser.print_help()
