"""Service configuration.

Every value comes from the environment. Nothing here has a default that would
work in production by accident — a missing service-role key raises at startup
rather than silently degrading to a client that cannot write.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(RuntimeError):
    """Raised at startup, never at request time."""


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(
            f"{name} is not set. The IoT service cannot start without it — "
            f"see iot-service/.env.example."
        )
    return value


def _optional(name: str, default: str) -> str:
    return os.environ.get(name, "").strip() or default


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    # The service role key bypasses RLS, which is exactly what this service
    # needs and exactly why it lives nowhere near the browser. It is the only
    # component in AVERIS that holds one.
    service_role_key: str
    log_level: str
    # Ingest is per-device; a misbehaving device must not be able to spend the
    # whole fleet's budget.
    max_readings_per_minute: int
    cors_origins: tuple[str, ...]

    @property
    def rest_url(self) -> str:
        return f"{self.supabase_url.rstrip('/')}/rest/v1"


def load_settings() -> Settings:
    origins = _optional("CORS_ORIGINS", "http://localhost:3100")

    return Settings(
        supabase_url=_required("SUPABASE_URL"),
        service_role_key=_required("SUPABASE_SERVICE_ROLE_KEY"),
        log_level=_optional("LOG_LEVEL", "info"),
        max_readings_per_minute=int(_optional("MAX_READINGS_PER_MINUTE", "60")),
        cors_origins=tuple(o.strip() for o in origins.split(",") if o.strip()),
    )
