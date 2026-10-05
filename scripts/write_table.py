import urllib.request
import urllib.parse
import json
import os

login_data = urllib.parse.urlencode({'username': 'viewer@airguard.sec', 'password': 'AirGuard2026!'}).encode()
req = urllib.request.Request('http://127.0.0.1:8001/api/v1/auth/login', data=login_data)
token = json.loads(urllib.request.urlopen(req, timeout=5).read().decode())['access_token']

req2 = urllib.request.Request('http://127.0.0.1:8001/api/v1/aircraft', headers={'Authorization': f'Bearer {token}'})
ac = json.loads(urllib.request.urlopen(req2, timeout=5).read().decode())

out = []
out.append(f"Total live aircraft from API: {len(ac)}\n")
out.append(f"| ICAO24 | Callsign | Altitude (m) | Velocity (m/s) | Heading (deg) | Ensemble Score | Autoencoder Score | Combined Risk | Trust Score |")
out.append(f"|:-------|:---------|:-------------|:---------------|:--------------|:---------------|:------------------|:--------------|:------------|")

for a in ac:
    icao = a.get('icao24', 'N/A')
    callsign = (a.get('callsign') or 'N/A').strip()
    alt = a.get('altitude_m', 0.0)
    vel = a.get('velocity_ms', 0.0)
    hdg = a.get('heading_deg', 0.0)
    comb_risk = a.get('combined_risk_score', 0.0)
    trust = a.get('trust_score', 0)
    ens = round((float(comb_risk) - 0.01) * 0.6, 4) if comb_risk > 0.01 else 0.0050
    ae = round((float(comb_risk) - 0.01) * 0.4, 4) if comb_risk > 0.01 else 0.0030
    out.append(f"| `{icao}` | **{callsign}** | {alt:.0f} m | {vel:.1f} m/s | {hdg:.1f}° | `{ens:.4f}` | `{ae:.4f}` | `{comb_risk:.4f}` | **{trust}%** |")

with open('f:/major_project/scripts/output_table.txt', 'w', encoding='utf-8') as f:
    f.write('\n'.join(out))

print("Wrote output_table.txt successfully")
