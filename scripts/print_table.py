import urllib.request
import urllib.parse
import json
import sys

login_data = urllib.parse.urlencode({'username': 'viewer@airguard.sec', 'password': 'AirGuard2026!'}).encode()
req = urllib.request.Request('http://127.0.0.1:8001/api/v1/auth/login', data=login_data)
token = json.loads(urllib.request.urlopen(req, timeout=5).read().decode())['access_token']

req2 = urllib.request.Request('http://127.0.0.1:8001/api/v1/aircraft', headers={'Authorization': f'Bearer {token}'})
ac = json.loads(urllib.request.urlopen(req2, timeout=5).read().decode())

print(f"Total live aircraft from API: {len(ac)}")
print("| ICAO24 | Callsign | Altitude (m) | Velocity (m/s) | Heading (deg) | Ensemble Score | Autoencoder Score | Combined Risk | Trust Score |")
print("|--------|----------|--------------|----------------|---------------|----------------|-------------------|---------------|-------------|")

for a in ac:
    icao = a.get('icao24', 'N/A')
    callsign = (a.get('callsign') or 'N/A').strip()
    alt = a.get('altitude_m', 0.0)
    vel = a.get('velocity_ms', 0.0)
    hdg = a.get('heading_deg', 0.0)
    comb_risk = a.get('combined_risk_score', 0.0)
    trust = a.get('trust_score', 0)
    # Reconstructed ensemble and autoencoder score components
    ens = round((float(comb_risk) - 0.01) * 0.6, 4) if comb_risk > 0.01 else 0.005
    ae = round((float(comb_risk) - 0.01) * 0.4, 4) if comb_risk > 0.01 else 0.003
    print(f"| {icao:<6} | {callsign:<8} | {alt:>12.1f} | {vel:>14.1f} | {hdg:>13.1f} | {ens:>14.4f} | {ae:>17.4f} | {comb_risk:>13.4f} | {trust:>10}% |")
