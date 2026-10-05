"""Isolated Redis Streams integration checks; never touches production keys."""

import json
import uuid

import pytest
from redis.asyncio import Redis
from redis.exceptions import RedisError

from app.core.config import settings


@pytest.mark.asyncio
async def test_isolated_stream_group_read_reclaim_and_ack():
    """Exercise Redis consumer delivery/reclaim/ack with a non-aircraft probe."""
    client = Redis.from_url(settings.REDIS_URL, decode_responses=True, protocol=2)
    stream = f"airguard:test:redis-verification:{uuid.uuid4().hex}"
    group = "isolated-verification-group"
    probe = {"probe_id": uuid.uuid4().hex, "purpose": "stream-integration-test"}
    stream_created = False

    try:
        try:
            await client.ping()
        except RedisError:
            pytest.skip("A real Redis service is not configured for integration tests")

        await client.xgroup_create(stream, group, id="0", mkstream=True)
        stream_created = True
        message_id = await client.xadd(stream, {"payload": json.dumps(probe)})

        delivered = await client.xreadgroup(
            group, "verification-reader-a", {stream: ">"}, count=1, block=1000
        )
        assert delivered[0][1][0][0] == message_id
        assert json.loads(delivered[0][1][0][1]["payload"]) == probe
        assert (await client.xpending(stream, group))["pending"] == 1

        reclaimed = await client.xautoclaim(
            stream,
            group,
            "verification-reader-b",
            min_idle_time=0,
            start_id="0-0",
            count=1,
        )
        assert reclaimed[1][0][0] == message_id
        assert (await client.xpending(stream, group))["pending"] == 1

        assert await client.xack(stream, group, message_id) == 1
        assert (await client.xpending(stream, group))["pending"] == 0
    finally:
        if stream_created:
            await client.delete(stream)
        await client.aclose()
