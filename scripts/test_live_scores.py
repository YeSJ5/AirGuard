import sys
import os
sys.path.insert(0, os.path.abspath('f:/major_project/backend'))

import urllib.request
import json
from app.core.security import create_access_token
from datetime import timedelta

token = create_access_token({"sub": "admin@airguard.local", "role": "admin"}, expires_delta=timedelta(hours=1))

req = urllib.request.Request(
    'http://127.0.0.1:8001/api/v1/aircraft',
    headers={'Authorization': f'Bearer {token}'}
)

try:
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode())
        print(f"Total aircraft returned: {len(data)}")
        scores = []
        for ac in data[:18]:
            trust = ac.get('trust_score')
            risk = ac.get('combined_risk_score')
            scores.append(trust)
            print(f"ICAO: {ac.get('icao24')}, Callsign: {ac.get('callsign')}, Lat: {ac.get('latitude')}, Lon: {ac.get('longitude')}, Alt: {ac.get('altitude_m')}, Spd: {ac.get('velocity_ms')}, Trust: {trust}, Risk: {risk}")
        print("Unique trust scores:", set(scores))
except Exception as e:
    print('Error:', e)
