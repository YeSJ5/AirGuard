import asyncio
import json
import os
import sys
from datetime import datetime, timezone

# Add backend directory
backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend"))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from app.core.redis import redis_client

async def test():
    stream_name = "airguard:telemetry"
    group_name = "test-verification-group"
    
    # 1. Create consumer group if not exists
    try:
        await redis_client.xgroup_create(stream_name, group_name, id="$", mkstream=True)
    except Exception:
        pass
        
    # 2. Add sample telemetry record to stream
    sample_state = {
        "icao24": "test99",
        "callsign": "TEST-STREAM",
        "latitude": 28.5,
        "longitude": 77.1,
        "altitude_m": 8000.0,
        "velocity_ms": 220.0,
        "heading_deg": 90.0,
        "vertical_rate_ms": 0.0,
        "on_ground": False,
        "received_at": datetime.now(timezone.utc).isoformat(),
        "source": "opensky",
        "reported_nic": 9,
        "metadata": {"is_known_entity": False, "is_synthetic": True}
    }
    
    payload = {
        "record": sample_state,
        "trace_carrier": {}
    }
    
    msg_id = await redis_client.xadd(stream_name, {"payload": json.dumps(payload)})
    print(f"Pushed to stream {stream_name}, msg_id: {msg_id}")
    
    # 3. Read message via consumer group
    messages = await redis_client.xreadgroup(
        groupname=group_name,
        consumername="test-consumer",
        streams={stream_name: ">"},
        count=1,
        block=2000
    )
    print(f"Read messages type: {type(messages)}, value: {messages}")
    stream_items = messages.items() if isinstance(messages, dict) else messages
    
    records_read = 0
    for stream, msg_list in stream_items:
        if len(msg_list) > 0 and isinstance(msg_list[0], list):
            msg_list = msg_list[0]
        for m_id, m_payload in msg_list:
            data = json.loads(m_payload["payload"])
            print(f"Successfully consumed record for ICAO: {data['record']['icao24']} from stream: {stream}")
            await redis_client.xack(stream_name, group_name, m_id)
            records_read += 1
            
    assert records_read > 0, "No records read from consumer group!"
    print("SUCCESS: Redis Stream consumer group pipeline verified end-to-end!")
    await redis_client.aclose()

if __name__ == "__main__":
    asyncio.run(test())
