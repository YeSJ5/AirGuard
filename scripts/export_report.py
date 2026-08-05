import argparse
import json
import os
import time

def export_report(output_path):
    print("Generating AirGuard Trust-Scoring Ground Station Report...")
    time.sleep(1)
    
    report_data = {
        "report_id": "REP-20260804-001",
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        "receiver_station": "AirGuard-SF-01",
        "station_metrics": {
            "total_signals_processed": 142095,
            "average_trust_score": 89.4,
            "anomalies_detected": 14,
            "active_threats_logged": 3
        },
        "anomalies": [
            {"callsign": "AAL102", "type": "Emergency Squawk (7700)", "severity": "high", "score_impact": -45},
            {"callsign": "GHOST01", "type": "ICAO Address Mismatch", "severity": "high", "score_impact": -80},
            {"callsign": "SWA931", "type": "Unusual Trajectory Deviation", "severity": "medium", "score_impact": -15}
        ]
    }
    
    # Ensure directory exists
    dir_name = os.path.dirname(output_path)
    if dir_name:
        os.makedirs(dir_name, exist_ok=True)
        
    with open(output_path, "w") as f:
        json.dump(report_data, f, indent=4)
        
    print(f"Report exported successfully to: {output_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AirGuard Trust Score Report Generator")
    parser.add_argument("--output", default="reports/trust_report.json", help="Path to write report file")
    args = parser.parse_args()
    export_report(args.output)
