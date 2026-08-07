"""WebSocket fan-out.

Holds one set of dashboard sockets per patient and pushes each stored reading
to that patient's sockets only.

**The isolation rule.** Sockets are keyed by patient id, and a reading is
published to exactly one key. There is no broadcast-to-all path in this module,
because the moment one exists it is one typo away from streaming a stranger's
vital signs into someone's browser — and nothing about the dashboard would look
wrong while it happened.

**Live data is not the record.** The socket carries the newest reading for the
tiles; history comes from the database over RLS. A dropped socket therefore
costs the live number and never the record, which is why no delivery guarantee
is attempted here: a reading that fails to send is already durably stored, and
the client re-reads on reconnect.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger("averis.hub")

# A dashboard with several tabs open is normal; a thousand sockets for one
# patient is a leak or an attack.
MAX_SOCKETS_PER_PATIENT = 8


class ConnectionHub:
    def __init__(self) -> None:
        self._by_patient: dict[str, set[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, patient_id: str, socket: WebSocket) -> bool:
        async with self._lock:
            sockets = self._by_patient.setdefault(patient_id, set())
            if len(sockets) >= MAX_SOCKETS_PER_PATIENT:
                return False
            sockets.add(socket)
        return True

    async def disconnect(self, patient_id: str, socket: WebSocket) -> None:
        async with self._lock:
            sockets = self._by_patient.get(patient_id)
            if not sockets:
                return
            sockets.discard(socket)
            # Empty sets are removed so a long-lived process does not
            # accumulate a key per patient who has ever connected.
            if not sockets:
                self._by_patient.pop(patient_id, None)

    async def publish(self, patient_id: str, event: dict[str, Any]) -> int:
        """Sends to one patient's sockets. Returns how many received it."""
        async with self._lock:
            targets = list(self._by_patient.get(patient_id, ()))

        if not targets:
            return 0

        payload = json.dumps(event, default=str)
        delivered = 0
        dead: list[WebSocket] = []

        for socket in targets:
            try:
                await socket.send_text(payload)
                delivered += 1
            except Exception:  # noqa: BLE001 - a dead socket must not fail ingest
                # The reading is already stored. Losing the push costs a tile
                # refresh, and the client re-reads history on reconnect.
                dead.append(socket)

        if dead:
            async with self._lock:
                sockets = self._by_patient.get(patient_id)
                if sockets:
                    for socket in dead:
                        sockets.discard(socket)
                    if not sockets:
                        self._by_patient.pop(patient_id, None)

        return delivered

    def connection_count(self) -> int:
        return sum(len(s) for s in self._by_patient.values())

    def patient_count(self) -> int:
        return len(self._by_patient)
