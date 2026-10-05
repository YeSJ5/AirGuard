import urllib.request
import urllib.parse
import json

def main():
    try:
        # 1. Login to get JWT
        login_data = urllib.parse.urlencode({
            'username': 'viewer@airguard.sec',
            'password': 'AirGuard2026!'
        }).encode('utf-8')
        
        req_login = urllib.request.Request('http://127.0.0.1:8001/api/v1/auth/login', data=login_data, headers={
            'Content-Type': 'application/x-www-form-urlencoded'
        })
        with urllib.request.urlopen(req_login) as resp:
            token_json = json.loads(resp.read().decode('utf-8'))
            token = token_json['access_token']

        # 2. Fetch /api/v1/aircraft
        req_ac = urllib.request.Request('http://127.0.0.1:8001/api/v1/aircraft', headers={
            'Authorization': f'Bearer {token}'
        })
        with urllib.request.urlopen(req_ac) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            print(f"=== LIVE BACKEND AIRCRAFT API (/api/v1/aircraft) ===")
            print(f"Total Active Tracked Aircraft: {len(data)}\n")
            print(f"{'ICAO':<8} | {'Callsign':<8} | {'Alt (m)':<8} | {'Speed (m/s)':<12} | {'Risk Score':<12} | {'Trust Score':<12} | {'Status'}")
            print("-" * 85)
            for a in data[:18]:
                print(f"{a.get('icao24', ''):<8} | {str(a.get('callsign', '')):<8} | {str(a.get('altitude_m', '')):<8} | {str(a.get('velocity_ms', '')):<12} | {str(a.get('combined_risk_score', '')):<12} | {str(a.get('trust_score', '')):<12} | {a.get('status', '')}")
    except Exception as e:
        print(f"API Error: {e}")

if __name__ == '__main__':
    main()
