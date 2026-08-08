#pragma once
/**
 * Local alert levels — the ones the band acts on by itself.
 *
 * These mirror `THRESHOLDS` in `lib/iot/alert-rules.ts` and `alerts.py`, which
 * makes them a third copy of the same numbers. That is a real cost and it is
 * accepted for one reason: **the buzzer has to work when the WiFi does not.**
 * A wearable whose emergency alert requires a round trip to a server is a
 * wearable that goes silent in a lift, a basement, or a rural home with one
 * bar — which are not the places where it matters least.
 *
 * The duplication is bounded deliberately:
 *
 *   · Only the CRITICAL levels are here. The band does not buzz for a warning;
 *     it has no way to explain itself, and a device that beeps at a wearer
 *     several times a day is a device in a drawer by the end of the week.
 *   · The band never decides anything a clinician sees. It buzzes and it
 *     displays. Everything on the dashboard was decided by the server from the
 *     stored reading, so these constants drifting would change when a wearer
 *     is *nudged*, never what their doctor is told.
 *
 * If these need to change per patient, the right answer is the handshake in
 * `net.h` sending them down at boot — not a firmware reflash of every band on
 * every wrist. The struct is laid out so that is a change of assignment rather
 * than a change of design.
 */

#include <stdint.h>
#include "signal_core.h"

namespace averis {

struct AlertLevels {
  /** Published escalation point for oxygen saturation. */
  float spo2Critical = 90.0f;
  float heartRateCriticalHigh = 150.0f;
  float heartRateCriticalLow = 40.0f;
  float temperatureCriticalHigh = 39.5f;
  float temperatureCriticalLow = 35.0f;
  /** Below this the band warns the wearer that it is about to stop watching. */
  float batteryCritical = 10.0f;
};

enum class LocalAlert : uint8_t {
  kNone = 0,
  kLowOxygen,
  kHighHeartRate,
  kLowHeartRate,
  kHighTemperature,
  kLowTemperature,
  kFallDetected,
  kBatteryCritical,
};

/** Two lines, because that is what the OLED has room for. */
struct AlertBanner {
  const char* title;
  const char* detail;
};

inline AlertBanner bannerFor(LocalAlert alert) {
  switch (alert) {
    case LocalAlert::kLowOxygen:       return {"WARNING", "Low Oxygen Level"};
    case LocalAlert::kHighHeartRate:   return {"WARNING", "Heart Rate High"};
    case LocalAlert::kLowHeartRate:    return {"WARNING", "Heart Rate Low"};
    case LocalAlert::kHighTemperature: return {"WARNING", "Temperature High"};
    case LocalAlert::kLowTemperature:  return {"WARNING", "Temperature Low"};
    case LocalAlert::kFallDetected:    return {"FALL DETECTED", "Are you okay?"};
    case LocalAlert::kBatteryCritical: return {"BATTERY LOW", "Charge the band"};
    default:                           return {"AVERIS", ""};
  }
}

/**
 * The one alert the wearer is shown.
 *
 * Ordered by what a person should be told first when several are true at once.
 * A fall outranks everything: the wearer may be unable to read the screen, and
 * the buzzer pattern for a fall is the one that brings someone else into the
 * room.
 *
 * Deliberately returns a single alert rather than a list. Three warnings
 * cycling on a 128×64 display is a screen nobody reads, and a wearer who
 * cannot act on three things at once is not helped by being told three things.
 */
inline LocalAlert evaluateLocalAlert(float heartRate, float spo2,
                                     float temperature, float batteryPercent,
                                     bool fallLatched,
                                     const AlertLevels& levels = {}) {
  if (fallLatched) return LocalAlert::kFallDetected;

  // Oxygen first among the vitals: of these, hypoxia moves fastest.
  if (hasValue(spo2) && spo2 < levels.spo2Critical) return LocalAlert::kLowOxygen;

  if (hasValue(heartRate)) {
    if (heartRate >= levels.heartRateCriticalHigh) return LocalAlert::kHighHeartRate;
    if (heartRate <= levels.heartRateCriticalLow) return LocalAlert::kLowHeartRate;
  }

  if (hasValue(temperature)) {
    if (temperature >= levels.temperatureCriticalHigh) return LocalAlert::kHighTemperature;
    if (temperature <= levels.temperatureCriticalLow) return LocalAlert::kLowTemperature;
  }

  // Last, and only when nothing about the wearer is wrong. A flat battery is
  // an inconvenience; ranking it beside hypoxia teaches people to ignore the
  // buzzer.
  if (hasValue(batteryPercent) && batteryPercent <= levels.batteryCritical) {
    return LocalAlert::kBatteryCritical;
  }

  return LocalAlert::kNone;
}

/**
 * How the buzzer sounds, per alert.
 *
 * Different patterns rather than one tone, because a wearer learns the
 * difference and a carer in the next room learns it faster. A fall is a long
 * insistent repeat that carries through a door; a low battery is two short
 * chirps that are easy to ignore, which is correct for a low battery.
 */
struct BuzzPattern {
  uint16_t beeps;
  uint16_t onMs;
  uint16_t offMs;
  /** How often the pattern repeats while the condition holds, 0 = once. */
  uint32_t repeatEveryMs;
};

inline BuzzPattern buzzFor(LocalAlert alert) {
  switch (alert) {
    case LocalAlert::kFallDetected:    return {5, 400, 200, 5000};
    case LocalAlert::kLowOxygen:       return {3, 250, 150, 30000};
    case LocalAlert::kHighHeartRate:
    case LocalAlert::kLowHeartRate:    return {2, 200, 200, 60000};
    case LocalAlert::kHighTemperature:
    case LocalAlert::kLowTemperature:  return {2, 200, 400, 120000};
    // Once every ten minutes, and never again after the wearer has been told
    // twice — the band is about to stop monitoring, not about to catch fire.
    case LocalAlert::kBatteryCritical: return {2, 120, 120, 600000};
    default:                           return {0, 0, 0, 0};
  }
}

}  // namespace averis
