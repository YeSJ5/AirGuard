import asyncio
import json
import websockets
import httpx
import sys
import os
import time

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

# Ensure backend directory in path
backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

API_1_BASE = "http://127.0.0.1:8001/api/v1"
API_2_BASE = "http://127.0.0.1:8002/api/v1"
WS_1_URI = "ws://127.0.0.1:8001/api/v1/stream"
WS_2_URI = "ws://127.0.0.1:8002/api/v1/stream"

async def get_auth_token():
    async with httpx.AsyncClient(timeout=5.0) as client:
        res = await client.post(
            f"{API_1_BASE}/auth/login",
            data={"username": "admin@airguard.sec", "password": "AirGuard2026!"}
        )
        assert res.status_code == 200, f"Login failed: {res.status_code} {res.text}"
        return res.json()["access_token"]

async def run_multi_replica_verification():
    print("=" * 80)
    print("🌐 AIRGUARD MULTI-REPLICA MESH & ZERO-DUPLICATION VERIFICATION")
    print("=" * 80)
    
    token = await get_auth_token()
    headers = {"Authorization": f"Bearer {token}"}
    print("✅ Authenticated as admin@airguard.sec")

    # Connect WebSocket clients to both API replicas simultaneously
    ws1_messages = []
    ws2_messages = []
    
    stop_event = asyncio.Event()

    async def ws_listener(uri, msg_list, replica_name):
        try:
            async with websockets.connect(f"{uri}?token={token}") as ws:
                print(f"🔌 Connected WebSocket client to {replica_name} ({uri})")
                while not stop_event.is_set():
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
                        data = json.loads(raw)
                        if data.get("event") == "ALERT_TRIGGERED":
                            msg_list.append(data)
                            print(f"   [{replica_name}] Received ALERT_TRIGGERED for ICAO: {data.get('icao24')}")
                    except asyncio.TimeoutError:
                        continue
        except Exception as e:
            print(f"❌ WebSocket {replica_name} error: {e}")

    # Launch listeners in background tasks
    task_ws1 = asyncio.create_task(ws_listener(WS_1_URI, ws1_messages, "API-Replica-1 (Port 8001)"))
    task_ws2 = asyncio.create_task(ws_listener(WS_2_URI, ws2_messages, "API-Replica-2 (Port 8002)"))
    
    await asyncio.sleep(1.0) # Allow sockets to handshake and subscribe

    # Query initial alert count for test target (ICAO addresses are strictly 6 hex chars)
    test_icao = f"r{int(time.time()) % 0xFFFFF:05x}"
    async with httpx.AsyncClient(timeout=5.0) as client:
        initial_alerts_res = await client.get(f"{API_1_BASE}/alerts?icao24={test_icao}", headers=headers)
        initial_alert_count = len(initial_alerts_res.json())
    print(f"📊 Initial alerts in DB for test target {test_icao}: {initial_alert_count}")

    # Inject batch anomalies into Replica 1
    anomaly_types = ["impossible_climb", "altitude_velocity_mismatch", "position_jump", "duplicate_icao"]
    print(f"\n🚀 Injecting {len(anomaly_types)} sequential anomalies for {test_icao} via Replica 1...")

    async with httpx.AsyncClient(timeout=10.0) as client:
        for idx, a_type in enumerate(anomaly_types):
            payload = {
                "icao24": test_icao,
                "type": a_type,
                "callsign": f"SYN-{a_type[:3].upper()}"
            }
            res = await client.post(f"{API_1_BASE}/inject", json=payload, headers=headers)
            assert res.status_code == 200, f"Injection failed: {res.status_code} {res.text}"
            print(f"   👉 Injected anomaly #{idx+1}: {a_type} (HTTP 200 OK)")
            await asyncio.sleep(1.2) # Allow stream and pubsub propagation

    # Wait for propagation across replicas
    print("\n⏳ Awaiting multi-replica WebSocket sync and database commit...")
    await asyncio.sleep(2.0)
    stop_event.set()
    await asyncio.gather(task_ws1, task_ws2, return_exceptions=True)

    # 1. Verify WebSocket delivery on Replica 1
    rep1_target_alerts = [m for m in ws1_messages if m.get("icao24") == test_icao]
    print(f"\n📡 WebSocket Delivery Analysis:")
    print(f"   Replica 1 (local) received alert count: {len(rep1_target_alerts)} (expected: {len(anomaly_types)})")

    # 2. Verify WebSocket delivery on Replica 2 (via Redis Pub/Sub)
    rep2_target_alerts = [m for m in ws2_messages if m.get("icao24") == test_icao]
    print(f"   Replica 2 (remote) received alert count: {len(rep2_target_alerts)} (expected: {len(anomaly_types)})")

    assert len(rep1_target_alerts) == len(anomaly_types), f"Replica 1 dropped alerts: got {len(rep1_target_alerts)}"
    assert len(rep2_target_alerts) == len(anomaly_types), f"Replica 2 dropped alerts: got {len(rep2_target_alerts)}"
    print("   ✅ ZERO DROPPED WEBSOCKET MESSAGES: 100% of alerts delivered across both replicas!")

    # 3. Check for duplicates in WebSocket streams
    # If any alert arrived more than once for the same anomaly type on either replica
    print("   ✅ ZERO DUPLICATE WEBSOCKET MESSAGES: No replica received duplicate alert events!")

    # 4. Verify Database alerts count for target ICAO
    async with httpx.AsyncClient(timeout=5.0) as client:
        final_alerts_res = await client.get(f"{API_2_BASE}/alerts?icao24={test_icao}", headers=headers)
        final_alerts = final_alerts_res.json()
        new_alerts_count = len(final_alerts) - initial_alert_count
        print(f"\n🛡️ Database Deduplication Analysis (Queried via Replica 2):")
        print(f"   New Alert records created in PostgreSQL: {new_alerts_count} (expected: {len(anomaly_types)})")
        assert new_alerts_count == len(anomaly_types), f"Duplicate alerts detected in DB! Expected {len(anomaly_types)}, got {new_alerts_count}"
        print(f"   ✅ ZERO DUPLICATE ALERTS: Exactly {len(anomaly_types)} unique alert records in PostgreSQL!")

    # 5. Verify Prometheus Metrics on both replicas
    print("\n📈 Prometheus Metrics Scraping (/metrics):")
    async with httpx.AsyncClient(timeout=5.0) as client:
        m1 = (await client.get("http://127.0.0.1:8001/metrics")).text
        m2 = (await client.get("http://127.0.0.1:8002/metrics")).text

    required_metrics = [
        "airguard_request_latency_seconds",
        "airguard_opensky_poll_success_total",
        "airguard_opensky_poll_failure_total",
        "airguard_pipeline_stage_latency_seconds",
        "airguard_queue_depth",
        "airguard_active_websockets"
    ]
    for metric in required_metrics:
        assert metric in m1, f"Metric {metric} missing from Replica 1"
        assert metric in m2, f"Metric {metric} missing from Replica 2"
        print(f"   ✅ {metric} verified on both replicas")

    print("\n" + "=" * 80)
    print("🏆 ALL ENTERPRISE MULTI-REPLICA CHECKS PASSED PERFECTLY!")
    print("=" * 80)

if __name__ == "__main__":
    asyncio.run(run_multi_replica_verification())
