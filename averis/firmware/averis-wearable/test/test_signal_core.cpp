/**
 * Firmware logic, compiled and run on a development machine.
 *
 *     firmware/averis-wearable/test/run.sh
 *
 * The reason this exists: the code that decides whether a number is a
 * measurement or an artefact is the code most worth testing, and firmware that
 * can only run on an ESP32 gets tested by wearing one and hoping. Every header
 * under test is free of Arduino symbols precisely so this file can compile it
 * with clang or gcc.
 *
 * What is *not* tested here is anything touching I²C, WiFi or the radio.
 * Mocking a MAX30102 would test the mock. Those live behind the interfaces in
 * `sensors.h` and are exercised on real hardware with `--self-test`.
 */

#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

#include "../src/signal_core.h"
#include "../src/alert_levels.h"
#include "../src/payload.h"
#include "../src/edge_policy.h"

using namespace averis;

static int checks = 0;
static int failures = 0;

#define CHECK(cond, label)                                       \
  do {                                                           \
    checks++;                                                    \
    if (!(cond)) {                                               \
      failures++;                                                \
      printf("  not ok  %s\n    at %s:%d\n", label, __FILE__, __LINE__); \
    } else {                                                     \
      printf("  ok      %s\n", label);                           \
    }                                                            \
  } while (0)

static bool nearly(float a, float b, float tolerance = 0.05f) {
  return fabsf(a - b) <= tolerance;
}

// ---------------------------------------------------------------- filtering
static void test_smoothing() {
  printf("\n# smoothing and outlier rejection\n");

  SmoothedChannel<8> hr(kHeartRate, 25.0f);

  CHECK(!hasValue(hr.value()), "no value before three samples");

  for (int i = 0; i < 5; i++) hr.push(72.0f);
  CHECK(nearly(hr.value(), 72.0f), "a steady signal reads as itself");

  // The failure this filter exists for: one artefact from a sensor that lost
  // skin contact, which is plausible (210 BPM is a real heart rate) and would
  // be stored forever as a measurement.
  const bool accepted = hr.push(210.0f);
  CHECK(!accepted, "an implausible jump is rejected");
  CHECK(nearly(hr.value(), 72.0f), "and does not move the filtered value");

  CHECK(!hr.push(4000.0f), "a physically impossible value is rejected");
  CHECK(hr.rejectedRun() == 2, "consecutive rejections are counted");

  // Impossible values never resync. A run of 4000s is a broken sensor, and
  // rebuilding the window around one would turn a fault into a baseline.
  for (int i = 0; i < 10; i++) hr.push(4000.0f);
  CHECK(nearly(hr.value(), 72.0f), "an impossible run never becomes the new baseline");

  // A filter that only rejects is a lock. Someone starting to run produces a
  // climb that outruns the tolerance, and a band that reported a resting heart
  // rate through it would be worse than no band. After a sustained
  // disagreement the window is rebuilt around the new level.
  for (int i = 0; i < 20; i++) hr.push(150.0f);
  CHECK(hr.value() > 120.0f, "a sustained genuine change is followed");

  hr.reset();
  CHECK(!hasValue(hr.value()), "reset forgets the wrist it was on");
}

static void test_no_contact_run() {
  printf("\n# losing skin contact\n");

  SmoothedChannel<8> spo2(kSpo2, 6.0f);
  for (int i = 0; i < 5; i++) spo2.push(98.0f);

  // Contact lost: the sensor keeps answering, with nonsense.
  for (int i = 0; i < 4; i++) spo2.push(51.0f);

  CHECK(spo2.rejectedRun() == 4, "a run of rejections is visible to the caller");
  CHECK(!channelIsTrustworthy(SensorState::kOk, spo2.rejectedRun(), 4),
        "the channel stops being trustworthy");
  CHECK(nearly(spo2.value(), 98.0f), "and the last believed value is not corrupted");

  // Past the resync point the window is rebuilt, so the channel reports
  // nothing at all until three samples agree — which is the honest state when
  // a sensor has started saying something new.
  for (int i = 0; i < 2; i++) spo2.push(51.0f);
  CHECK(!hasValue(spo2.value()), "after a resync the channel claims nothing yet");
  CHECK(!channelIsTrustworthy(SensorState::kAbsent, 0),
        "a sensor that never answered is never trustworthy");
  CHECK(channelIsTrustworthy(SensorState::kOk, 0), "a healthy channel is");
}

// ------------------------------------------------------------------- falls
static void test_fall_sequence() {
  printf("\n# fall detection\n");

  FallDetector detector;
  uint32_t t = 10000;

  // Resting.
  CHECK(detector.update(1.00f, t) == Movement::kResting, "1g reads as resting");
  t += 100;

  // Free fall.
  detector.update(0.20f, t);
  t += 200;
  // Impact.
  detector.update(3.4f, t);
  t += 100;

  // Still on the floor. The fall is not declared until the stillness window
  // has passed — this is the delay that removes the false positives.
  Movement m = detector.update(1.01f, t);
  CHECK(m != Movement::kFallSuspected, "no fall declared during the stillness window");

  t += 2100;
  m = detector.update(1.00f, t);
  CHECK(m == Movement::kFallSuspected, "a fall is declared after stillness");
  CHECK(detector.fallCount() == 1, "and counted once");

  // Latched, so a twitch does not retract an emergency someone is responding to.
  t += 500;
  CHECK(detector.update(1.4f, t) == Movement::kFallSuspected, "the fall latches");
  CHECK(detector.isFallLatched(t), "and reports itself as latched");

  detector.acknowledge();
  CHECK(!detector.isFallLatched(t), "the wearer can say they are fine");
}

static void test_stumble_is_not_a_fall() {
  printf("\n# the false positive that matters\n");

  FallDetector detector;
  uint32_t t = 0;

  detector.update(1.0f, t);
  t += 100;
  detector.update(0.2f, t);   // stumble
  t += 200;
  detector.update(3.0f, t);   // catches themselves — impact
  t += 200;

  // ...and keeps walking.
  bool declared = false;
  for (int i = 0; i < 40; i++) {
    if (detector.update(i % 2 ? 1.45f : 0.62f, t) == Movement::kFallSuspected) declared = true;
    t += 100;
  }

  CHECK(!declared, "walking on after a stumble never declares a fall");
  CHECK(detector.fallCount() == 0, "someone who trips and catches themselves is not a fall");
}

static void test_dropped_band_is_not_a_fall() {
  printf("\n# a band dropped on a table\n");

  FallDetector detector;
  uint32_t t = 0;

  detector.update(1.0f, t);
  t += 100;
  detector.update(0.05f, t);  // dropped
  t += 250;
  detector.update(6.0f, t);   // hits the table hard
  t += 100;

  // A band on a table is very still indeed, so this *does* declare a fall.
  // Asserted rather than wished away: the accelerometer cannot tell a still
  // wrist from a still table, and pretending otherwise in a test would hide a
  // limitation the documentation has to state.
  for (int i = 0; i < 25; i++) {
    detector.update(1.0f, t);
    t += 100;
  }
  CHECK(detector.fallCount() == 1,
        "a dropped band reads as a fall — a known limitation, not a passing test");
}

static void test_free_fall_without_impact() {
  printf("\n# free fall with no impact\n");

  FallDetector detector;
  uint32_t t = 0;

  detector.update(0.2f, t);
  // An arm swung down fast enough to unload the sensor, then nothing.
  for (int i = 0; i < 20; i++) {
    t += 100;
    detector.update(1.0f, t);
  }

  CHECK(detector.fallCount() == 0, "free fall alone is not a fall");
}

static void test_activity_levels() {
  printf("\n# activity classification\n");

  FallDetector detector;
  CHECK(detector.update(1.02f, 0) == Movement::kResting, "sitting still");
  CHECK(detector.update(1.22f, 100) == Movement::kNormal, "moving about");
  CHECK(detector.update(1.60f, 200) == Movement::kActive, "walking");

  CHECK(std::string(movementName(Movement::kFallSuspected)) == "FALL_SUSPECTED",
        "movement names match the wire contract exactly");
  CHECK(std::string(movementName(Movement::kActive)) == "ACTIVE", "ACTIVE spelled as the server expects");
}

// ------------------------------------------------------------ local alerts
static void test_local_alerts() {
  printf("\n# local alerts\n");

  CHECK(evaluateLocalAlert(72, 98, 36.7f, 80, false) == LocalAlert::kNone,
        "a healthy reading buzzes at nobody");

  CHECK(evaluateLocalAlert(72, 86, 36.7f, 80, false) == LocalAlert::kLowOxygen,
        "SpO2 below 90% is a local alert");

  CHECK(evaluateLocalAlert(72, 92, 36.7f, 80, false) == LocalAlert::kNone,
        "a warning-level SpO2 does not buzz — only critical does");

  CHECK(evaluateLocalAlert(168, 98, 36.7f, 80, false) == LocalAlert::kHighHeartRate,
        "an extreme heart rate is a local alert");

  CHECK(evaluateLocalAlert(72, 86, 40.0f, 5, true) == LocalAlert::kFallDetected,
        "a fall outranks every other alert");

  CHECK(evaluateLocalAlert(72, 86, 36.7f, 5, false) == LocalAlert::kLowOxygen,
        "hypoxia outranks a flat battery");

  CHECK(evaluateLocalAlert(72, 98, 36.7f, 5, false) == LocalAlert::kBatteryCritical,
        "the battery is mentioned only when the wearer is fine");

  CHECK(evaluateLocalAlert(kNoValue, kNoValue, kNoValue, 80, false) == LocalAlert::kNone,
        "no measurements means no alert, never a default one");

  CHECK(std::string(bannerFor(LocalAlert::kLowOxygen).detail) == "Low Oxygen Level",
        "the banner matches the brief's wording");

  CHECK(buzzFor(LocalAlert::kFallDetected).beeps > buzzFor(LocalAlert::kBatteryCritical).beeps,
        "a fall sounds more insistent than a low battery");
  CHECK(buzzFor(LocalAlert::kNone).beeps == 0, "silence when there is nothing to say");
}

// ---------------------------------------------------------------- payload
static void test_payload() {
  printf("\n# the uplink payload\n");

  char buffer[512];

  Uplink u{};
  u.deviceKey = "AVR001";
  u.heartRate = 82.4f;
  u.spo2 = 97.0f;
  u.temperature = 36.83f;
  u.movement = Movement::kActive;
  u.batteryPercent = 85.0f;
  u.recordedAt = "2026-08-09T10:30:00Z";
  u.rssiDbm = -57;
  u.uptimeSeconds = 3600;
  u.bootCount = 4;
  u.firmwareVersion = "1.0.0";
  u.transport = "wifi";
  u.pulseSensor = SensorState::kOk;
  u.thermometer = SensorState::kOk;
  u.imu = SensorState::kOk;
  u.bufferedCount = 0;

  size_t n = encodeUplink(u, buffer, sizeof(buffer));
  CHECK(n > 0, "a full reading encodes");

  std::string body(buffer, n);
  CHECK(body.find("\"device_id\":\"AVR001\"") != std::string::npos, "device_id is the contract's name");
  CHECK(body.find("\"heart_rate\":82") != std::string::npos, "heart rate is rounded to an integer");
  CHECK(body.find("\"temperature\":36.8") != std::string::npos, "temperature keeps one decimal");
  CHECK(body.find("\"movement\":\"ACTIVE\"") != std::string::npos, "movement uses the contract's vocabulary");
  CHECK(body.find("patient_id") == std::string::npos,
        "no patient_id — ownership comes from the device row, never the wire");
  CHECK(body.find("\"pulse\":\"ok\"") != std::string::npos, "sensor health rides along");
  CHECK(body.back() == '}', "the object is closed");

  // A missing channel is absent, not zero.
  Uplink partial = u;
  partial.heartRate = kNoValue;
  partial.spo2 = kNoValue;
  n = encodeUplink(partial, buffer, sizeof(buffer));
  std::string partialBody(buffer, n);
  CHECK(partialBody.find("heart_rate") == std::string::npos,
        "an untrustworthy channel is omitted entirely");
  CHECK(partialBody.find("\"heart_rate\":0") == std::string::npos,
        "and is never sent as zero, which would store as a measurement");
  CHECK(partialBody.find("\"temperature\":36.8") != std::string::npos,
        "while the channels that do work still report");

  // No clock: the field is dropped and the server stamps arrival.
  Uplink noClock = u;
  noClock.recordedAt = "";
  n = encodeUplink(noClock, buffer, sizeof(buffer));
  CHECK(std::string(buffer, n).find("recorded_at") == std::string::npos,
        "a band with no time does not invent one");

  // Truncation is a dropped reading, not a malformed one.
  char tiny[40];
  CHECK(encodeUplink(u, tiny, sizeof(tiny)) == 0,
        "a buffer too small returns nothing rather than half a body");
}

static void test_timestamps() {
  printf("\n# timestamps\n");

  char iso[32];

  // Pair verified against Python's datetime.fromtimestamp(tz=utc), not against
  // this implementation — a test that agrees with the code it tests about a
  // calendar algorithm proves only that both are consistent.
  CHECK(formatIso8601(1786581000UL, iso, sizeof(iso)), "a real epoch formats");
  CHECK(std::string(iso) == "2026-08-13T00:30:00Z", "as ISO-8601 UTC");
  CHECK(formatIso8601(1786501800UL, iso, sizeof(iso)) &&
            std::string(iso) == "2026-08-12T02:30:00Z",
        "and again across a day boundary");

  CHECK(!formatIso8601(0, iso, sizeof(iso)), "an unset clock is refused");
  CHECK(iso[0] == '\0', "and produces nothing rather than 1970");
  CHECK(!formatIso8601(1000000UL, iso, sizeof(iso)),
        "a clock that is obviously wrong is refused too");
}

// ---------------------------------------------------------------- battery
static void test_battery_curve() {
  printf("\n# battery\n");

  CHECK(nearly(batteryPercent(4.20f), 100.0f, 0.5f), "4.2V is full");
  CHECK(nearly(batteryPercent(3.30f), 0.0f, 0.5f), "3.3V is empty");
  CHECK(batteryPercent(4.30f) == 100.0f, "above full clamps");
  CHECK(batteryPercent(2.00f) == 0.0f, "below empty clamps");

  // The reason the curve is not linear: a LiPo spends most of its discharge
  // between 3.7V and 3.9V, and the naive mapping reports ~58% there for hours
  // before falling off a cliff.
  const float mid = batteryPercent(3.80f);
  CHECK(mid > 40.0f && mid < 65.0f, "the plateau maps to a plausible middle");
  CHECK(batteryPercent(3.70f) < batteryPercent(3.85f), "the curve is monotonic");
}


// ---------------------------------------------------------------------------
// Edge policy — when the band is allowed to stay quiet.
//
// Suppression is the one optimisation in this firmware that can hide a
// deteriorating patient, so every rule that bounds it is tested by the failure
// it prevents rather than by the behaviour it produces.
// ---------------------------------------------------------------------------
static void test_edge_suppresses_a_resting_patient() {
  EdgePolicy policy;
  LastSent last;
  uint32_t now = 0;

  auto step = [&](float hr, float spo2, uint32_t advanceMs) {
    now += advanceMs;
    SendDecision d = shouldSend(last, now, hr, spo2, 36.6f, 80.0f,
                                Movement::kResting, false, policy);
    if (d.send) noteSent(last, now, hr, spo2, 36.6f, 80.0f, Movement::kResting, false);
    return d;
  };

  CHECK(step(72, 98, 2000).reason == SendReason::kFirstReading,
        "edge: the first reading always goes out");

  // Two beats of jitter on a still wrist, five seconds apart. This is sensor
  // noise, and sending it is sending noise.
  CHECK(step(73, 98, 5000).send == false, "edge: a beat of jitter is suppressed");
  CHECK(step(71, 98, 5000).send == false, "edge: jitter the other way is suppressed");
  CHECK(step(72, 98, 5000).send == false, "edge: still suppressed while nothing happens");
}

static void test_edge_never_hides_a_slow_drift() {
  // The rule that matters most, and the one a naive implementation gets wrong.
  //
  // Comparing each reading against the *previous* one lets saturation walk from
  // 98% to 88% a single point at a time without ever transmitting, because no
  // consecutive pair exceeds the deadband. Comparing against the last value the
  // server actually saw makes the cumulative movement visible.
  EdgePolicy policy;
  policy.minIntervalMs = 0;   // isolate the drift rule from rate limiting
  policy.heartbeatMs = 3600000;  // and from the heartbeat

  LastSent last;
  uint32_t now = 1000;

  SendDecision first = shouldSend(last, now, 72, 99, 36.6f, 80.0f,
                                  Movement::kResting, false, policy);
  CHECK(first.send, "edge: drift test starts from a sent reading");
  noteSent(last, now, 72, 99, 36.6f, 80.0f, Movement::kResting, false);

  // 99 → 98.4: below the 1-point deadband, correctly suppressed.
  now += 5000;
  SendDecision small = shouldSend(last, now, 72, 98.4f, 36.6f, 80.0f,
                                  Movement::kResting, false, policy);
  CHECK(small.send == false, "edge: a sub-deadband step is suppressed");

  // Another sub-deadband step, but now 1.2 points below what the server saw.
  // Against the previous *reading* this is 0.6 and would be suppressed forever.
  now += 5000;
  SendDecision cumulative = shouldSend(last, now, 72, 97.8f, 36.6f, 80.0f,
                                       Movement::kResting, false, policy);
  CHECK(cumulative.send, "edge: cumulative drift past the deadband is sent");
  CHECK(cumulative.reason == SendReason::kSignificantChange,
        "edge: and it is reported as a change");
}

static void test_edge_always_sends_a_concerning_reading() {
  EdgePolicy policy;
  LastSent last;

  // A reading two seconds after the last one, inside the minimum interval and
  // inside every deadband — except that it is below the escalation point.
  last.valid = true;
  last.atMs = 10000;
  last.heartRate = 72;
  last.spo2 = 90.5f;
  last.temperature = 36.6f;
  last.battery = 80.0f;
  last.movement = Movement::kResting;

  SendDecision d = shouldSend(last, 11000, 72, 89.8f, 36.6f, 80.0f,
                              Movement::kResting, false, policy);

  CHECK(d.send, "edge: a reading below the escalation point is never suppressed");
  CHECK(d.reason == SendReason::kAlerting, "edge: and it says why");

  // A fall, likewise, regardless of how ordinary the vitals look.
  SendDecision fall = shouldSend(last, 11000, 72, 98, 36.6f, 80.0f,
                                 Movement::kResting, true, policy);
  CHECK(fall.send, "edge: a latched fall is never suppressed");
}

static void test_edge_sends_the_recovery_too() {
  // A server that last saw 88% needs to know the patient came back. Without
  // this rule it would wait for the heartbeat to find out.
  EdgePolicy policy;
  LastSent last;
  last.valid = true;
  last.atMs = 10000;
  last.heartRate = 72;
  last.spo2 = 88.0f;
  last.temperature = 36.6f;
  last.battery = 80.0f;
  last.movement = Movement::kResting;
  last.wasAlerting = true;

  SendDecision d = shouldSend(last, 11000, 72, 97.0f, 36.6f, 80.0f,
                              Movement::kResting, false, policy);

  CHECK(d.send, "edge: the recovery from an alert is sent");
  CHECK(d.reason == SendReason::kAlertCleared, "edge: and it is labelled as recovery");
}

static void test_edge_heartbeat_bounds_the_silence() {
  // A monitoring device that goes quiet is indistinguishable from one that has
  // failed. The heartbeat is what lets the server treat silence as a fault.
  EdgePolicy policy;
  LastSent last;
  last.valid = true;
  last.atMs = 1000;
  last.heartRate = 72;
  last.spo2 = 98;
  last.temperature = 36.6f;
  last.battery = 80.0f;
  last.movement = Movement::kResting;

  SendDecision quiet = shouldSend(last, 1000 + policy.heartbeatMs - 1, 72, 98, 36.6f,
                                  80.0f, Movement::kResting, false, policy);
  CHECK(quiet.send == false, "edge: quiet just before the heartbeat");

  SendDecision beat = shouldSend(last, 1000 + policy.heartbeatMs, 72, 98, 36.6f,
                                 80.0f, Movement::kResting, false, policy);
  CHECK(beat.send, "edge: the heartbeat bounds how long the band may stay silent");
  CHECK(beat.reason == SendReason::kHeartbeat, "edge: and says it is a heartbeat");
}

static void test_edge_survives_millis_wraparound() {
  // millis() rolls over about every 49.7 days. Unsigned subtraction stays
  // correct across the wrap; comparing timestamps directly does not, and the
  // symptom would be a band that goes silent for 49 days, once.
  EdgePolicy policy;
  LastSent last;
  last.valid = true;
  last.atMs = 0xFFFFF000u;   // shortly before the rollover
  last.heartRate = 72;
  last.spo2 = 98;
  last.temperature = 36.6f;
  last.battery = 80.0f;
  last.movement = Movement::kResting;

  // 8192 ms later, having wrapped through zero.
  const uint32_t afterWrap = 0xFFFFF000u + 8192u;   // wraps by construction
  CHECK(afterWrap < last.atMs, "edge: the test really does wrap the clock");

  SendDecision d = shouldSend(last, afterWrap, 72, 98, 36.6f, 80.0f,
                              Movement::kResting, false, policy);
  CHECK(d.send == false, "edge: 8 seconds across the wrap is not a 49-day silence");
}

static void test_edge_movement_change_is_context() {
  // A heart rate of 110 means different things resting and active.
  EdgePolicy policy;
  LastSent last;
  last.valid = true;
  last.atMs = 10000;
  last.heartRate = 72;
  last.spo2 = 98;
  last.temperature = 36.6f;
  last.battery = 80.0f;
  last.movement = Movement::kResting;

  SendDecision d = shouldSend(last, 10000 + policy.minIntervalMs + 1, 72, 98, 36.6f,
                              80.0f, Movement::kActive, false, policy);

  CHECK(d.send, "edge: a change of movement state is always sent");
  CHECK(d.reason == SendReason::kMovementChanged, "edge: and says so");
}

static void test_edge_dropout_does_not_reset_the_reference() {
  // If the pulse sensor drops out for a minute, the last heart rate the server
  // received is still the right thing to measure the next one against. Storing
  // the NaN would make the first reading after every dropout "significant" —
  // a transmission per dropout, and dropouts come in runs.
  LastSent last;
  noteSent(last, 1000, 72.0f, 98.0f, 36.6f, 80.0f, Movement::kResting, false);
  noteSent(last, 2000, kNoValue, 98.0f, 36.6f, 80.0f, Movement::kResting, false);

  CHECK(hasValue(last.heartRate) && nearly(last.heartRate, 72.0f, 0.001f),
        "edge: an absent channel does not overwrite the last sent value");
}

static void test_edge_stats_report_rather_than_assume() {
  EdgeStats stats;
  CHECK(stats.suppressionPercent() == 0.0f, "edge: no division by zero before any reading");

  for (int i = 0; i < 8; i++) stats.record(false);
  for (int i = 0; i < 2; i++) stats.record(true);

  CHECK(stats.considered == 10 && stats.sent == 2 && stats.suppressed == 8,
        "edge: the counters add up");
  CHECK(nearly(stats.suppressionPercent(), 80.0f, 0.01f),
        "edge: suppression is reported, not assumed");
}

int main() {
  printf("AVERIS wearable — firmware logic\n");

  test_smoothing();
  test_no_contact_run();
  test_fall_sequence();
  test_stumble_is_not_a_fall();
  test_dropped_band_is_not_a_fall();
  test_free_fall_without_impact();
  test_activity_levels();
  test_local_alerts();
  test_payload();
  test_timestamps();
  test_battery_curve();

  test_edge_suppresses_a_resting_patient();
  test_edge_never_hides_a_slow_drift();
  test_edge_always_sends_a_concerning_reading();
  test_edge_sends_the_recovery_too();
  test_edge_heartbeat_bounds_the_silence();
  test_edge_survives_millis_wraparound();
  test_edge_movement_change_is_context();
  test_edge_dropout_does_not_reset_the_reference();
  test_edge_stats_report_rather_than_assume();

  printf("\n# checks %d\n# pass %d\n# fail %d\n", checks, checks - failures, failures);
  return failures == 0 ? 0 : 1;
}
