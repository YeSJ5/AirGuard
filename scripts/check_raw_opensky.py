import urllib.request
import urllib.error
import json
import time

def check_opensky():
    url = 'https://opensky-network.org/api/states/all?lamin=6.0&lomin=68.0&lamax=37.0&lomax=98.0'
    print(f"=== STANDALONE OPENSKY QUERY ===")
    print(f"URL: {url}")
    
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AirGuard-Standalone-Audit/1.0'
    }
    
    req = urllib.request.Request(url, headers=headers)
    start_time = time.time()
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            latency = (time.time() - start_time) * 1000.0
            status_code = response.getcode()
            rate_remaining = response.headers.get('X-Rate-Limit-Remaining')
            rate_retry = response.headers.get('X-Rate-Limit-Retry-After-Seconds')
            
            raw_data = json.loads(response.read().decode('utf-8'))
            states = raw_data.get('states') or []
            
            print(f"HTTP Status Code: {status_code}")
            print(f"Response Latency: {latency:.1f}ms")
            print(f"Rate Limit Remaining Header: {rate_remaining}")
            print(f"Rate Limit Retry After Header: {rate_retry}")
            print(f"RAW OPENSKY AIRCRAFT ARRAY LENGTH: {len(states)}")
            
            if states:
                print("\nSample 5 aircraft from raw OpenSky response:")
                print(f"{'ICAO24':<8} | {'Callsign':<10} | {'Lat':<8} | {'Lon':<8} | {'Altitude (m)':<12} | {'Velocity (m/s)':<15}")
                print("-" * 75)
                for s in states[:5]:
                    print(f"{str(s[0]):<8} | {str(s[1]).strip():<10} | {str(s[6]):<8} | {str(s[5]):<8} | {str(s[7]):<12} | {str(s[9]):<15}")
            else:
                print("OpenSky returned 0 states (empty array).")

    except urllib.error.HTTPError as e:
        print(f"HTTP Error: {e.code} - {e.reason}")
        print(f"Response Headers: {dict(e.headers)}")
    except Exception as e:
        print(f"Request Failed: {e}")

if __name__ == '__main__':
    check_opensky()
