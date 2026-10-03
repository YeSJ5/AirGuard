import redis.asyncio as aioredis
from app.core.config import settings

redis_client = aioredis.from_url(
    settings.REDIS_URL,
    decode_responses=True,
    socket_timeout=5.0,
    socket_connect_timeout=5.0,
    protocol=3
)
