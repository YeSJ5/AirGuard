import argparse
import time
import json

def inject_anomaly(anomaly_type, callsign):
    print(f"Initializing AirGuard injection sequence...")
    print(f"Target: {callsign}")
    print(f"Anomaly Type: {anomaly_type}")
    
    payload = {
        "target": callsign,
        "anomaly_type": anomaly_type,
        "timestamp": time.time(),
        "details": {
            "spoofed_coordinates": [37.7749, -122.4194] if anomaly_type == "gps_spoof" else None,
            "false_icao": "A00001" if anomaly_type == "ghost_aircraft" else None
        }
    }
    
    print(f"Payload successfully formatted:")
    print(json.dumps(payload, indent=2))
    print("Sequence injected successfully.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AirGuard Anomaly Injector Tool")
    parser.add_argument("--type", choices=["gps_spoof", "ghost_aircraft"], required=True, help="Type of anomaly to inject")
    parser.add_argument("--target", default="GHOST_AC", help="Target aircraft callsign")
    
    args = parser.parse_args()
    inject_anomaly(args.type, args.target)
