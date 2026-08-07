"""Threshold alerting.

Rules, not a model. An alert claims something about a person needs attention,
and a patient told that at 3am deserves to know exactly what tripped it. "Your
SpO2 was 88% and the threshold is 90%" is checkable; "the model flagged this"
is not.

Ported from `lib/iot/alert-rules.ts` and covered by the same vectors.
"""

from __future__ import annotations

from dataclasses import dataclass

from .validation import Reading

THRESHOLDS = {
    "heart_rate": {"critical_low": 40, "low": 50, "high": 120, "critical_high": 150},
    # 90% is the widely used escalation point; 94% a common early warning.
    "spo2": {"critical": 90, "warning": 94},
    "temperature": {"critical_low": 35.0, "low": 35.5, "high": 38.0, "critical_high": 39.5},
    "battery": {"low": 15},
}

SEVERITY_RANK = {"INFO": 1, "WARNING": 2, "CRITICAL": 3}


@dataclass(frozen=True)
class Alert:
    alert_type: str
    severity: str
    message: str
    observed_value: float | None
    threshold_value: float | None


def evaluate_reading(reading: Reading) -> list[Alert]:
    alerts: list[Alert] = []

    # SpO2 first: of these, low oxygen saturation moves fastest.
    if reading.spo2 is not None:
        spo2 = THRESHOLDS["spo2"]
        if reading.spo2 < spo2["critical"]:
            alerts.append(
                Alert(
                    "SPO2_LOW",
                    "CRITICAL",
                    f"Blood oxygen measured {reading.spo2}%, below the "
                    f"{spo2['critical']}% escalation threshold.",
                    reading.spo2,
                    spo2["critical"],
                )
            )
        elif reading.spo2 < spo2["warning"]:
            alerts.append(
                Alert(
                    "SPO2_LOW",
                    "WARNING",
                    f"Blood oxygen measured {reading.spo2}%, below the usual "
                    f"{spo2['warning']}% range.",
                    reading.spo2,
                    spo2["warning"],
                )
            )

    if reading.heart_rate is not None:
        hr = reading.heart_rate
        t = THRESHOLDS["heart_rate"]
        if hr >= t["critical_high"]:
            alerts.append(_hr("HEART_RATE_HIGH", "CRITICAL", hr, t["critical_high"], "above"))
        elif hr > t["high"]:
            alerts.append(_hr("HEART_RATE_HIGH", "WARNING", hr, t["high"], "above"))
        elif hr <= t["critical_low"]:
            alerts.append(_hr("HEART_RATE_LOW", "CRITICAL", hr, t["critical_low"], "below"))
        elif hr < t["low"]:
            alerts.append(_hr("HEART_RATE_LOW", "WARNING", hr, t["low"], "below"))

    if reading.temperature is not None:
        temp = reading.temperature
        t = THRESHOLDS["temperature"]
        if temp >= t["critical_high"]:
            alerts.append(_temp("TEMPERATURE_HIGH", "CRITICAL", temp, t["critical_high"]))
        elif temp > t["high"]:
            alerts.append(_temp("TEMPERATURE_HIGH", "WARNING", temp, t["high"]))
        elif temp <= t["critical_low"]:
            alerts.append(_temp("TEMPERATURE_LOW", "CRITICAL", temp, t["critical_low"]))
        elif temp < t["low"]:
            alerts.append(_temp("TEMPERATURE_LOW", "WARNING", temp, t["low"]))

    if reading.movement_status == "FALL_SUSPECTED":
        alerts.append(
            Alert(
                "FALL_SUSPECTED",
                "CRITICAL",
                "The device reported a movement pattern consistent with a fall.",
                None,
                None,
            )
        )

    if (
        reading.battery_percentage is not None
        and reading.battery_percentage <= THRESHOLDS["battery"]["low"]
    ):
        alerts.append(
            Alert(
                "BATTERY_LOW",
                # INFO, not WARNING: a flat battery is an inconvenience, and
                # ranking it beside a vital sign teaches people to ignore the
                # colour.
                "INFO",
                f"Device battery is at {reading.battery_percentage}%.",
                reading.battery_percentage,
                THRESHOLDS["battery"]["low"],
            )
        )

    return alerts


def should_raise(candidate: Alert, open_alerts: list[dict]) -> bool:
    """Suppresses a repeat of an alert that is already open.

    A device at 0.5 Hz sitting below threshold for ten minutes would otherwise
    produce 300 identical rows. That is not 300 times the safety — it is a list
    nobody reads, which is strictly less safe than one alert that stays visible.

    An escalation still gets through: WARNING → CRITICAL is new information.
    """
    for existing in open_alerts:
        if existing.get("alert_type") == candidate.alert_type:
            return SEVERITY_RANK[candidate.severity] > SEVERITY_RANK.get(
                existing.get("severity", "INFO"), 0
            )
    return True


def _hr(alert_type: str, severity: str, observed: int, threshold: int, direction: str) -> Alert:
    return Alert(
        alert_type,
        severity,
        f"Heart rate measured {observed} BPM, {direction} the {threshold} BPM threshold.",
        observed,
        threshold,
    )


def _temp(alert_type: str, severity: str, observed: float, threshold: float) -> Alert:
    direction = "above" if alert_type == "TEMPERATURE_HIGH" else "below"
    return Alert(
        alert_type,
        severity,
        f"Body temperature measured {observed}°C, {direction} the {threshold}°C threshold.",
        observed,
        threshold,
    )
