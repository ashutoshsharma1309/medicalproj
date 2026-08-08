"""Batch uplink — for connectivity that comes and goes.

A band on a rural network is not "online" or "offline". It has a few minutes of
GPRS every hour, or a share of a household connection that works in the
evening. The per-reading uplink assumes a link that is there; this assumes one
that is not.

── What batching actually buys ────────────────────────────────────────────

Not bytes, mostly. One TLS handshake costs several kilobytes and a second or
two of radio time; ninety separate uplinks pay that ninety times, and on a
battery the radio is the expensive part by a wide margin. Sending ninety
readings in one request pays it once.

So the win is **connections, not payload size** — which is why this endpoint
takes a plain JSON array rather than a compressed binary format. Compression
would save a few hundred bytes on a request whose cost is dominated by setting
it up, in exchange for a format nobody can read with curl when a band in a
village is misbehaving.

── What it deliberately does not do ───────────────────────────────────────

**It does not skip validation.** Every reading in the batch goes through the
same validator, the same alert rules and the same escalation path as a single
uplink. A batch endpoint that trusted its input because it arrived in bulk
would be the easiest way into the system.

**It does not reorder or deduplicate silently.** Readings are processed in the
order the device sent them, and a duplicate is a duplicate. The device knows
what it buffered; the server inventing an opinion about that would make a
replayed batch produce a different chart from the live stream.

**It does not partially fail.** A malformed reading is rejected and *counted*,
and the rest are stored. Refusing ninety readings because the fourteenth had a
NaN in it would lose an afternoon of a patient's monitoring to a firmware bug.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from .services.sensor_processing_service import ProcessedReading, ProcessingError

logger = logging.getLogger("averis.batch")

# The most readings one request may carry.
#
# 240 is two hours at the 0.5 Hz cadence — long enough to cover a realistic
# rural outage, short enough that one request cannot occupy a worker for
# minutes while the rest of the fleet waits.
MAX_BATCH = 240


@dataclass
class BatchOutcome:
    accepted: int = 0
    rejected: int = 0
    alerts_raised: int = 0
    emergencies_raised: int = 0
    # Why each rejection happened, so a firmware bug is diagnosable from the
    # response rather than from a server log nobody in the field can read.
    errors: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "status": "accepted" if self.accepted else "rejected",
            "accepted": self.accepted,
            "rejected": self.rejected,
            "alerts_raised": self.alerts_raised,
            "emergencies_raised": self.emergencies_raised,
            # Bounded: a band with broken firmware could otherwise generate a
            # response larger than the request that caused it.
            "errors": self.errors[:10],
        }


def extract_readings(body: object) -> list[dict] | None:
    """Pulls the reading list out of either accepted shape.

    A bare array is what a minimal device sends; `{"readings": [...]}` is what
    a device that also wants to send batch-level telemetry sends. Supporting
    both costs one branch, and supporting only one would mean a firmware
    revision choosing wrongly and being rejected wholesale.
    """
    if isinstance(body, list):
        return body

    if isinstance(body, dict):
        readings = body.get("readings")
        if isinstance(readings, list):
            return readings

    return None


async def process_batch(
    processing,
    token: str | None,
    body: object,
) -> tuple[BatchOutcome | None, ProcessingError | None]:
    """Runs every reading in a batch through the ordinary pipeline.

    Returns `(outcome, None)` on success, or `(None, error)` when the batch
    itself is unusable — an unauthenticated caller, or a body that is not a
    list of readings. Note the asymmetry: a bad *batch* fails, a bad *reading*
    inside a good batch is counted and skipped.
    """
    readings = extract_readings(body)

    if readings is None:
        return None, ProcessingError(400, "invalid_batch", ["Body must be a list of readings."])

    if not readings:
        # An empty batch is not an error. A device that reconnects with nothing
        # buffered should get a clean answer rather than a 400 it will retry.
        return BatchOutcome(), None

    if len(readings) > MAX_BATCH:
        return None, ProcessingError(
            413,
            "batch_too_large",
            [f"A batch may carry at most {MAX_BATCH} readings; this one had {len(readings)}."],
        )

    outcome = BatchOutcome()

    for index, reading in enumerate(readings):
        try:
            processed: ProcessedReading = await processing.process(token, reading)
        except ProcessingError as error:
            # Authentication and device mismatch are properties of the whole
            # batch, not of one reading — if the token is wrong for the first
            # reading it is wrong for all of them, and continuing would mean
            # 240 identical failures.
            if error.status in (401, 403):
                return None, error

            outcome.rejected += 1
            outcome.errors.append(
                {"index": index, "error": error.code, "details": error.details[:3]}
            )
            continue
        except Exception:  # noqa: BLE001
            # One reading failing for an unforeseen reason must not cost the
            # rest of the batch. Logged loudly because it is a bug here, not a
            # bad payload.
            logger.exception("unexpected failure processing batch reading %d", index)
            outcome.rejected += 1
            outcome.errors.append({"index": index, "error": "internal_error"})
            continue

        outcome.accepted += 1
        outcome.alerts_raised += len(processed.alerts)
        outcome.emergencies_raised += len(processed.emergencies)

    return outcome, None
