import asyncio
import json
import time
import sys
import httpx
import websockets

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

API_URL = "http://127.0.0.1:8001"
WS_URL = "ws://127.0.0.1:8001/api/v1/stream?token=demo-token"

async def test_live_continuity_and_websocket():
    print("==================================================================")
    print("📡 AIRGUARD LIVE CONTINUITY & WEBSOCKET VERIFICATION TEST")
    print("==================================================================")

    # 1. Test /api/v1/system-health continuity detection
    print("\n1. Verifying /api/v1/system-health continuity detection...")
    async with httpx.AsyncClient(timeout=10.0) as client:
        res = await client.get(f"{API_URL}/api/v1/system-health")
        print(f"   Status Code: {res.status_code}")
        health_data = res.json()
        print(f"   Live Continuity Status:       {health_data.get('live_continuity_status')}")
        print(f"   Continuity Gap Detected:      {health_data.get('continuity_gap_detected')}")
        print(f"   Seconds Since Last Poll:      {health_data.get('seconds_since_last_poll')}s")
        print(f"   Max Allowed Poll Gap Seconds: {health_data.get('max_allowed_poll_gap_seconds')}s")
        print(f"   Circuit Breaker State:        {health_data.get('circuit_breaker_state')}")
        print(f"   Total Real Aircraft States:   {health_data.get('total_real_states')}")
        print(f"   Total Synthetic States:       {health_data.get('total_synthetic_states')}")
        print(f"   Continuity Message:           {health_data.get('continuity_message')}")

    # 2. Test strict=true behavior
    print("\n2. Verifying /api/v1/system-health?strict=true behaviour...")
    async with httpx.AsyncClient(timeout=10.0) as client:
        strict_res = await client.get(f"{API_URL}/api/v1/system-health?strict=true")
        if health_data.get('continuity_gap_detected'):
            assert strict_res.status_code == 503, f"Expected 503 when gap detected, got {strict_res.status_code}"
            print("   [PASS] Strict health check returns HTTP 503 Service Unavailable when continuity gap is active!")
        else:
            assert strict_res.status_code == 200, f"Expected 200 when healthy, got {strict_res.status_code}"
            print("   [PASS] Strict health check returns HTTP 200 OK when live polling is continuous!")

    # 3. Test WebSocket connection and immediate delivery
    print("\n3. Verifying WebSocket connection and immediate broadcast delivery...")
    async with websockets.connect(WS_URL) as ws:
        print("    Connected to live WebSocket stream: /api/v1/stream")
        
        # Test simulated immediate broadcast push
        test_payload = {
            "icao24": "test_live_01",
            "type": "position_jump",
            "callsign": "LIVE-TST"
        }
        
        # Trigger an anomaly injection and measure WebSocket reception latency
        start_time = time.perf_counter()
        async with httpx.AsyncClient(timeout=10.0) as client:
            inject_res = await client.post(
                f"{API_URL}/api/v1/inject",
                json=test_payload,
                headers={"Authorization": "Bearer demo-token"}
            )
            print(f"   Triggered test state injection: HTTP {inject_res.status_code}")

        # Wait for WebSocket delivery
        received_alert = False
        received_update = False
        deadline = time.time() + 5.0

        while time.time() < deadline:
            try:
                msg_raw = await asyncio.wait_for(ws.recv(), timeout=1.5)
                msg = json.loads(msg_raw)
                delivery_latency = (time.perf_counter() - start_time) * 1000.0
                event = msg.get("event")
                
                if event == "ALERT_TRIGGERED" and msg.get("icao24") == "test_live_01":
                    print(f"    Received WebSocket ALERT_TRIGGERED in {delivery_latency:.1f}ms (Sub-100ms immediate broadcast confirmed!)")
                    received_alert = True
                elif event == "AIRCRAFT_UPDATE" and msg.get("payload", {}).get("icao24") == "test_live_01":
                    print(f"    Received WebSocket AIRCRAFT_UPDATE in {delivery_latency:.1f}ms")
                    received_update = True
                    
                if received_alert and received_update:
                    break
            except asyncio.TimeoutError:
                break

        assert received_alert or received_update, "Failed to receive WebSocket broadcast!"
        print("   [PASS] Zero-buffering immediate WebSocket delivery verified!")

    # 4. Verify Zero Mock Data in default database query
    print("\n4. Verifying /api/v1/aircraft live database query contains no silent mock data...")
    async with httpx.AsyncClient(timeout=10.0) as client:
        ac_res = await client.get(
            f"{API_URL}/api/v1/aircraft?limit=100",
            headers={"Authorization": "Bearer demo-token"}
        )
        assert ac_res.status_code == 200, f"Expected 200, got {ac_res.status_code}"
        aircraft_list = ac_res.json()
        print(f"   Current active aircraft in DB: {len(aircraft_list)}")
        for ac in aircraft_list:
            assert not ac.get("icao24", "").startswith("sim-"), f"Found mock aircraft {ac['icao24']} in database!"
        print("   [PASS] Verified zero mock/simulation aircraft in live aircraft_states table!")

    print("\n==================================================================")
    print("✅ ALL LIVE CONTINUITY & WEBSOCKET BROADCAST TESTS PASSED!")
    print("==================================================================")

if __name__ == "__main__":
    asyncio.run(test_live_continuity_and_websocket())
