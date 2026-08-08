"""Batch uplink — the rural connectivity path.

The property under test throughout: **a batch is a convenience for the radio,
never a shortcut through the pipeline.** Every reading in one is validated,
evaluated and escalated exactly as a single uplink would be, and a bad reading
inside a good batch costs that reading rather than the afternoon.

    iot-service/.venv/bin/python -m pytest iot-service/tests -q
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import asyncio  # noqa: E402

from app.batch import MAX_BATCH, extract_readings, process_batch  # noqa: E402
from app.services.sensor_processing_service import ProcessingError  # noqa: E402


def run(coro):
    """Drives a coroutine without pytest-asyncio.

    The batch module is the only async code in this suite, and adding a plugin
    dependency for eleven tests would make the whole suite harder to run in an
    environment that has to be reproduced on a judge's laptop.
    """
    return asyncio.run(coro)


class FakeProcessing:
    """Stands in for the pipeline, recording what it was asked to do.

    Deliberately not a mock of the *validator* — the batch module's job is
    orchestration, and what is worth testing here is which readings reach the
    pipeline and what happens when one of them fails.
    """

    def __init__(self, failures: dict[int, ProcessingError] | None = None) -> None:
        self.seen: list[dict] = []
        self.failures = failures or {}

    async def process(self, token, body):  # noqa: ANN001
        index = len(self.seen)
        self.seen.append(body)

        if index in self.failures:
            raise self.failures[index]

        class Processed:
            alerts = []
            emergencies = []

        return Processed()


def reading(hr: int = 72) -> dict:
    return {"device_id": "AVR001", "heart_rate": hr, "spo2": 98, "temperature": 36.7}


def test_accepts_a_bare_array():
    processing = FakeProcessing()
    outcome, error = run(process_batch(processing, "avd_x", [reading(70), reading(71)]))

    assert error is None
    assert outcome.accepted == 2
    assert len(processing.seen) == 2


def test_accepts_a_wrapped_object():
    # What a device that also sends batch-level telemetry sends. Supporting
    # both shapes costs one branch; supporting one would mean a firmware
    # revision choosing wrongly and being rejected wholesale.
    processing = FakeProcessing()
    outcome, error = run(
        process_batch(
            processing, "avd_x", {"readings": [reading()], "telemetry": {"rssi": -80}}
        )
    )

    assert error is None
    assert outcome.accepted == 1


def test_every_reading_goes_through_the_pipeline():
    # The property that makes a batch safe: it is a convenience for the radio,
    # not a shortcut past validation.
    processing = FakeProcessing()
    run(process_batch(processing, "avd_x", [reading(70), reading(80), reading(90)]))

    assert [r["heart_rate"] for r in processing.seen] == [70, 80, 90]


def test_order_is_preserved():
    # A replayed batch must produce the same chart as the live stream would
    # have. Reordering would make a buffered afternoon look different from a
    # connected one.
    processing = FakeProcessing()
    run(process_batch(processing, "avd_x", [reading(i) for i in (60, 61, 62, 63)]))

    assert [r["heart_rate"] for r in processing.seen] == [60, 61, 62, 63]


def test_one_bad_reading_does_not_cost_the_batch():
    # Losing an afternoon of monitoring to a NaN in the fourteenth reading is
    # the failure this behaviour exists to prevent.
    processing = FakeProcessing(
        failures={1: ProcessingError(422, "invalid_reading", ["spo2 must be a number."])}
    )

    outcome, error = run(
        process_batch(processing, "avd_x", [reading(70), reading(71), reading(72)])
    )

    assert error is None
    assert outcome.accepted == 2
    assert outcome.rejected == 1
    assert outcome.errors[0]["index"] == 1
    assert outcome.errors[0]["error"] == "invalid_reading"


def test_an_unauthenticated_batch_stops_immediately():
    # If the token is wrong for the first reading it is wrong for all of them,
    # and continuing would mean 240 identical failures.
    processing = FakeProcessing(failures={0: ProcessingError(401, "unauthorized")})

    outcome, error = run(process_batch(processing, "bad", [reading() for _ in range(50)]))

    assert outcome is None
    assert error.status == 401
    assert len(processing.seen) == 1, "should not have tried the rest"


def test_a_device_mismatch_stops_immediately():
    processing = FakeProcessing(failures={0: ProcessingError(403, "device_mismatch")})

    outcome, error = run(process_batch(processing, "avd_x", [reading(), reading()]))

    assert outcome is None
    assert error.status == 403


def test_an_empty_batch_is_not_an_error():
    # A device that reconnects with nothing buffered should get a clean answer
    # rather than a 400 it will retry.
    outcome, error = run(process_batch(FakeProcessing(), "avd_x", []))

    assert error is None
    assert outcome.accepted == 0


def test_an_oversized_batch_is_refused_whole():
    processing = FakeProcessing()
    outcome, error = run(
        process_batch(processing, "avd_x", [reading() for _ in range(MAX_BATCH + 1)])
    )

    assert outcome is None
    assert error.status == 413
    assert processing.seen == [], "nothing should be processed from a refused batch"


def test_a_non_list_body_is_refused():
    outcome, error = run(process_batch(FakeProcessing(), "avd_x", {"device_id": "AVR001"}))

    assert outcome is None
    assert error.status == 400


def test_an_unexpected_failure_costs_one_reading_not_the_batch():
    class Exploding(FakeProcessing):
        async def process(self, token, body):  # noqa: ANN001
            if len(self.seen) == 1:
                self.seen.append(body)
                raise RuntimeError("something nobody predicted")
            return await super().process(token, body)

    processing = Exploding()
    outcome, error = run(process_batch(processing, "avd_x", [reading(), reading(), reading()]))

    assert error is None
    assert outcome.accepted == 2
    assert outcome.rejected == 1
    assert outcome.errors[0]["error"] == "internal_error"


def test_error_list_is_bounded():
    # A band with broken firmware could otherwise generate a response larger
    # than the request that caused it.
    failures = {i: ProcessingError(422, "invalid_reading") for i in range(40)}
    processing = FakeProcessing(failures=failures)

    outcome, _ = run(process_batch(processing, "avd_x", [reading() for _ in range(40)]))

    assert outcome.rejected == 40
    assert len(outcome.to_dict()["errors"]) <= 10


def test_extract_readings_shapes():
    assert extract_readings([{"a": 1}]) == [{"a": 1}]
    assert extract_readings({"readings": [{"a": 1}]}) == [{"a": 1}]
    assert extract_readings({"device_id": "AVR001"}) is None
    assert extract_readings("nope") is None
    assert extract_readings(None) is None
