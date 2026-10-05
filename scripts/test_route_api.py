import httpx
import time

now = int(time.time())
begin = now - 7200
for icao in ['3c4a0b', '06a102', '4843f3', '80163d', '801645']:
    url = f"https://opensky-network.org/api/flights/aircraft?icao24={icao}&begin={begin}&end={now}"
    try:
        res = httpx.get(url, timeout=5.0)
        print(f"[{icao}] Status: {res.status_code}")
        if res.status_code == 200:
            data = res.json()
            print(f"  Count: {len(data)}")
            for item in data:
                print(f"  Callsign: {item.get('callsign')}, Dep: {item.get('estDepartureAirport')}, Arr: {item.get('estArrivalAirport')}, firstSeen: {item.get('firstSeen')}")
        else:
            print(f"  Error: {res.text[:100]}")
    except Exception as e:
        print(f"  Exception: {e}")
