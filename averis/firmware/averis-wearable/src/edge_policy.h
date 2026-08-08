#pragma once
/**
 * AVERIS wearable — deciding whether a reading is worth a radio transmission.
 *
 * Header-only and free of Arduino symbols, like `signal_core.h`, so the host
 * test suite compiles and runs it. This file decides when the band stays quiet,
 * which is a decision with clinical consequences, and clinical decisions do not
 * belong in code that can only be tested by wearing the device.
 *
 * ── Why suppress anything ──────────────────────────────────────────────────
 *
 * The radio is the largest consumer on the board by a wide margin. Sensing at
 * 0.5 Hz costs milliamps; a WiFi transmission costs a couple of hundred for the
 * duration of the exchange. A band that transmits every reading spends most of
 * its battery telling a server that a resting patient is still resting.
 *
 * A patient asleep produces four hours of readings that differ by a beat or
 * two. Sending all of them is not more monitoring; it is the same monitoring,
 * more expensively, and the cost is measured in hours of battery — which is to
 * say in hours at the end of the day when the band is flat and watching nobody.
 *
 * ── Why suppressing is dangerous, and the four rules that make it safe ─────
 *
 * A monitoring device that goes quiet is indistinguishable from a monitoring
 * device that has failed. Worse, naive "send on change" hides the two things
 * this system exists to catch: a slow drift, where each reading is close enough
 * to the last to suppress while the day's total movement is enormous; and the
 * transition into a concerning range, where the reading that crosses 90% SpO₂
 * differs from its predecessor by one point and gets dropped.
 *
 * So suppression is bounded by four rules, and each exists because of a
 * specific way this goes wrong:
 *
 *   1. **A heartbeat interval.** However unchanged the readings, one goes out
 *      at least every `heartbeatMs`. The server can then treat silence as a
 *      fault rather than as reassurance, which is the property the whole
 *      offline-detection feature depends on.
 *
 *   2. **Drift is measured from the last *sent* value, never the last
 *      *observed* one.** This is the subtle one. Comparing against the previous
 *      reading lets a patient's saturation walk from 98% to 88% one point at a
 *      time without a single transmission, because no consecutive pair ever
 *      differs by more than the deadband. Comparing against what the server
 *      last saw makes the cumulative change visible.
 *
 *   3. **Anything concerning is always sent.** If the reading would raise a
 *      local alert, or if the previous sent reading did, it goes out. A band
 *      does not get to decide that a patient below 90% is boring, and the
 *      *recovery* is equally worth sending — a server watching a patient it
 *      last saw at 88% needs to know they came back.
 *
 *   4. **A change of movement state is always sent.** RESTING to WALKING is
 *      context that changes how every other number should be read; a heart rate
 *      of 110 means different things in each.
 *
 * The rule underneath all four: **suppression may only ever delay a boring
 * reading. It may never delay an interesting one.**
 */

#include <stdint.h>
#include <math.h>

#include "alert_levels.h"
#include "signal_core.h"

namespace averis {

/**
 * How much a channel must move before it is worth a transmission.
 *
 * These are sized against sensor noise, not against clinical significance. A
 * MAX30102 on a still wrist reports a heart rate wandering by a beat or two
 * between reads with nothing happening to the patient; sending that is sending
 * noise. Two beats is inside that band. Anything a clinician would notice is
 * far outside it.
 *
 * SpO₂ is deliberately the tightest at a single point, because the whole
 * clinically interesting range is ten points wide — 100 down to 90 — and a
 * two-point deadband would throw away a fifth of it.
 */
struct Deadband {
  float heartRate   = 2.0f;   // bpm
  float spo2        = 1.0f;   // percentage points
  float temperature = 0.2f;   // °C
  float battery     = 5.0f;   // percent — nobody needs 1% resolution on this
};

struct EdgePolicy {
  Deadband deadband{};

  /**
   * The longest the band may stay silent while readings are unchanging.
   *
   * Two minutes. Long enough to skip most of a sleeping patient's night, short
   * enough that the server's offline detection — which fires well after this —
   * is never triggered by a healthy quiet band.
   */
  uint32_t heartbeatMs = 120000;

  /**
   * The shortest gap between transmissions, whatever changes.
   *
   * Rate limiting at the source. Without it a patient walking on a treadmill
   * produces a transmission per sample, which is the exact battery drain this
   * file exists to prevent, arriving precisely when the readings matter and the
   * band should still be alive in four hours.
   *
   * Zero disables it. Nothing that crosses an alert threshold is subject to it
   * — see `shouldSend`.
   */
  uint32_t minIntervalMs = 4000;

  AlertLevels levels{};
};

/** What the band last put on the wire. */
struct LastSent {
  bool valid = false;
  uint32_t atMs = 0;
  float heartRate = kNoValue;
  float spo2 = kNoValue;
  float temperature = kNoValue;
  float battery = kNoValue;
  Movement movement = Movement::kUnknown;
  bool wasAlerting = false;
};

/** Why a reading is going out, for the device event log and the tests. */
enum class SendReason : uint8_t {
  kSuppressed = 0,
  kFirstReading,
  kHeartbeat,
  kSignificantChange,
  kMovementChanged,
  kAlerting,
  kAlertCleared,
};

inline const char* sendReasonName(SendReason reason) {
  switch (reason) {
    case SendReason::kSuppressed:        return "suppressed";
    case SendReason::kFirstReading:      return "first";
    case SendReason::kHeartbeat:         return "heartbeat";
    case SendReason::kSignificantChange: return "changed";
    case SendReason::kMovementChanged:   return "movement";
    case SendReason::kAlerting:          return "alerting";
    case SendReason::kAlertCleared:      return "recovered";
    default:                             return "unknown";
  }
}

struct SendDecision {
  bool send;
  SendReason reason;
};

/** True when either value is absent, or when they differ by at least `band`. */
inline bool movedBy(float previous, float current, float band) {
  // An absent previous value counts as moved: the server has never seen this
  // channel, so the first real number is news. An absent *current* value does
  // not — a channel that dropped out has nothing to report, and the gap is
  // carried by the reading's own null rather than by a transmission.
  if (!hasValue(current)) return false;
  if (!hasValue(previous)) return true;
  return fabsf(current - previous) >= band;
}

/**
 * Decides whether this reading goes out now.
 *
 * `nowMs` is the device's monotonic clock. Everything here is relative, so a
 * band whose wall clock has not yet synchronised still behaves correctly —
 * which matters, because the first minutes after a cold boot in a rural
 * deployment are exactly when NTP has not answered yet.
 */
inline SendDecision shouldSend(const LastSent& last,
                               uint32_t nowMs,
                               float heartRate,
                               float spo2,
                               float temperature,
                               float battery,
                               Movement movement,
                               bool fallLatched,
                               const EdgePolicy& policy = {}) {
  const bool alerting =
      evaluateLocalAlert(heartRate, spo2, temperature, battery, fallLatched,
                         policy.levels) != LocalAlert::kNone;

  // Rule 3, first half. Checked before the rate limit and before everything
  // else: a band does not get to decide that a patient below 90% is boring,
  // and it does not get to make them wait four seconds either.
  if (alerting) return {true, SendReason::kAlerting};

  // Rule 3, second half. The recovery is as much news as the onset — a server
  // that last saw 88% needs to know the patient came back, and without this it
  // would wait for a heartbeat to find out.
  if (last.wasAlerting) return {true, SendReason::kAlertCleared};

  if (!last.valid) return {true, SendReason::kFirstReading};

  // Monotonic-clock wraparound. millis() rolls over roughly every 49.7 days,
  // and unsigned subtraction handles it correctly — `now - then` stays right
  // across the wrap. Comparing the timestamps directly would not, and the
  // symptom would be a band that goes silent for 49 days once, which is the
  // kind of bug that is found in the field or never.
  const uint32_t sinceLast = nowMs - last.atMs;

  if (sinceLast >= policy.heartbeatMs) return {true, SendReason::kHeartbeat};

  // Rule 4. Context that changes how every other number reads.
  if (movement != last.movement) return {true, SendReason::kMovementChanged};

  if (sinceLast < policy.minIntervalMs) return {false, SendReason::kSuppressed};

  // Rule 2. Compared against the last *sent* value, not the last observed one,
  // so a patient walking from 98% to 88% a point at a time cannot slip through.
  const bool moved =
      movedBy(last.heartRate, heartRate, policy.deadband.heartRate) ||
      movedBy(last.spo2, spo2, policy.deadband.spo2) ||
      movedBy(last.temperature, temperature, policy.deadband.temperature) ||
      movedBy(last.battery, battery, policy.deadband.battery);

  if (moved) return {true, SendReason::kSignificantChange};

  return {false, SendReason::kSuppressed};
}

/** Records what went out, so the next decision compares against it. */
inline void noteSent(LastSent& last,
                     uint32_t nowMs,
                     float heartRate,
                     float spo2,
                     float temperature,
                     float battery,
                     Movement movement,
                     bool alerting) {
  last.valid = true;
  last.atMs = nowMs;
  last.movement = movement;
  last.wasAlerting = alerting;

  // Absent channels do not overwrite what the server last saw.
  //
  // If the pulse sensor drops out for a minute, the last heart rate the server
  // received is still the right thing to measure the next one against. Storing
  // the NaN would make the first reading after the gap unconditionally
  // "significant" — which is a transmission per dropout, and dropouts come in
  // runs.
  if (hasValue(heartRate))   last.heartRate = heartRate;
  if (hasValue(spo2))        last.spo2 = spo2;
  if (hasValue(temperature)) last.temperature = temperature;
  if (hasValue(battery))     last.battery = battery;
}

/**
 * How much traffic a policy is saving, for the diagnostics screen.
 *
 * Reported rather than assumed. A deadband tuned for one sensor's noise floor
 * behaves differently on another unit, and a band that turns out to be
 * suppressing 5% of readings is one whose sensor is noisier than expected —
 * which is a hardware finding, visible only because this counter exists.
 */
struct EdgeStats {
  uint32_t considered = 0;
  uint32_t sent = 0;
  uint32_t suppressed = 0;

  void record(bool didSend) {
    considered += 1;
    if (didSend) sent += 1;
    else suppressed += 1;
  }

  /** 0–100. Zero when nothing has been considered, not a division by zero. */
  float suppressionPercent() const {
    if (considered == 0) return 0.0f;
    return (static_cast<float>(suppressed) / static_cast<float>(considered)) * 100.0f;
  }
};

}  // namespace averis
