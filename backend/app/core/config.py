import os

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

env_mode = os.getenv("ENV", "dev").lower()
env_file_name = f".env.{env_mode}"
# Try in current directory first, then parent if not found
if not os.path.exists(env_file_name):
    parent_path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", env_file_name
    )
    if os.path.exists(parent_path):
        env_file_name = parent_path
    else:
        env_file_name = ".env"


class Settings(BaseSettings):
    ENV: str = "dev"
    PROJECT_NAME: str = "AirGuard"
    API_V1_STR: str = "/api/v1"
    DATABASE_URL: str = "postgresql+asyncpg://postgres:12345@127.0.0.1:5432/airguard"
    SECRET_KEY: str = "SUPER_SECRET_TACTICAL_KEY_123!"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    REDIS_URL: str = "redis://127.0.0.1:6379/0"
    JAEGER_HOST: str = "127.0.0.1"

    # OpenSky REST API uses OAuth2 client credentials (never HTTP Basic auth).
    OPENSKY_CLIENT_ID: str = ""
    OPENSKY_CLIENT_SECRET: str = ""
    OPENSKY_LAMIN: float = 6.0
    OPENSKY_LOMIN: float = 68.0
    OPENSKY_LAMAX: float = 37.0
    OPENSKY_LOMAX: float = 98.0
    OPENSKY_POLL_INTERVAL_SECONDS: float | None = None
    OPENSKY_GLOBAL_VIEW: bool = True
    MONITOR_REGION: str = "Global"
    # Keep research classifiers out of live trust decisions until validated for source and cadence.
    ENABLE_LIVE_ML: bool = False

    ALLOWED_ORIGINS: list[str] = [
        "http://localhost:3000",
        "http://localhost:5173",
        "http://localhost:8000",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:8000",
        "http://[::1]:3000",
        "http://[::1]:5173",
        "http://[::1]:8000",
    ]

    # Rate limiting
    RATE_LIMIT_DEFAULT: str = "100/minute"

    # Logging
    LOG_LEVEL: str = "INFO"

    @model_validator(mode="after")
    def validate_prod_secrets(self) -> "Settings":
        if self.ENV == "prod":
            if "localhost" in self.DATABASE_URL or "127.0.0.1" in self.DATABASE_URL:
                raise ValueError(
                    "DATABASE_URL must be a secure remote host in prod environment."
                )
            if self.SECRET_KEY == "SUPER_SECRET_TACTICAL_KEY_123!":
                raise ValueError(
                    "SECRET_KEY must be overridden with a secure key in prod environment."
                )
            if "localhost" in self.REDIS_URL or "127.0.0.1" in self.REDIS_URL:
                raise ValueError(
                    "REDIS_URL must point to a secure remote cluster in prod environment."
                )
        return self

    model_config = SettingsConfigDict(
        env_file=env_file_name,
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )


settings = Settings()
