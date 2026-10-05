import requests
import json

try:
    login_res = requests.post(
        'http://127.0.0.1:8001/api/v1/auth/login',
        data={'username': 'admin@airguard.sec', 'password': 'AirGuard2026!'},
        timeout=5
    )
    token = login_res.json().get('access_token')
    headers = {'Authorization': f'Bearer {token}'}

    r_ac = requests.get('http://127.0.0.1:8001/api/v1/aircraft', headers=headers, timeout=5)
    data = r_ac.json()
    print(f"Authenticated Aircraft Count: {len(data)}")
    for f in data[:5]:
        print(f"  ICAO: {f.get('icao24')} | Callsign: {f.get('callsign')} | Alt: {f.get('altitude_m'):.1f}m | Trust: {f.get('trust_score')}% | Risk: {f.get('combined_risk_score')}")
except Exception as e:
    print(f"Error: {e}")
