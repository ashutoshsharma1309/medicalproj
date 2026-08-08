#pragma once
/**
 * The uplink payload.
 *
 * Built with snprintf rather than ArduinoJson. The body is eleven fields of
 * known shape, the encoder is forty lines, and the alternative is a 40 KB
 * library plus a heap allocator on a device whose failure mode is running out
 * of RAM at 3am. Hand-rolling JSON is usually the wrong call; for a fixed
 * schema on a microcontroller it is the right one.
 *
 * **The field names are not ours to choose.** They are the wire contract in
 * `lib/iot/reading-validation.ts` and `iot-service/app/validation.py`, which
 * predates this firmware — the simulator has been speaking it since Phase 1.
 * `test/test_payload.cpp` asserts the exact bytes so a rename on either side
 * breaks a test rather than a fleet.
 *
 * ── One field is deliberately absent ───────────────────────────────────────
 *
 * `patient_id`. The brief's example payload includes one; this firmware does
 * not send it and the server would ignore it if it did. Ownership is read from
 * the authenticated device row, so a patient id on the wire is either
 * redundant or an attempt to write into somebody else's chart. There is no
 * code path here that could carry one, which is a stronger guarantee than
 * validating it.
 *
 * ── Missing values are omitted, never zeroed ───────────────────────────────
 *
 * A sensor with nothing trustworthy to say contributes no key at all. The
 * server stores NULL and the dashboard draws a gap. `"heart_rate": 0` would be
 * stored as a measurement of zero, and no code downstream could tell it from a
 * flatline.
 */

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "signal_core.h"

namespace averis {

/** Everything one uplink carries. */
struct Uplink {
  const char* deviceKey;
  float heartRate;      // kNoValue when not trustworthy
  float spo2;
  float temperature;
  Movement movement;
  float batteryPercent;

  /** ISO-8601 UTC, or null/empty when the clock has never been set. */
  const char* recordedAt;

  // ── Telemetry ────────────────────────────────────────────────────────────
  // Not vital signs, and not decoration either: this is what turns "the device
  // is offline" into "the device is on WiFi at -89 dBm with a dead MAX30102",
  // which is the difference between shipping a band back and re-seating it.
  int16_t rssiDbm;
  uint32_t uptimeSeconds;
  uint32_t bootCount;
  const char* firmwareVersion;
  const char* transport;         // "wifi" | "ble" | "wifi_buffered"
  SensorState pulseSensor;
  SensorState thermometer;
  SensorState imu;
  /** Readings the band could not deliver and is now catching up on. */
  uint16_t bufferedCount;
};

namespace detail {

/**
 * One optional numeric field, or nothing at all.
 *
 * Returns the bytes written, or -1 when the field did not fit. The -1 matters:
 * snprintf reports what it *would* have written, so adding its return value
 * blindly walks the cursor past the end of the buffer and every subsequent
 * bounds check compares against an underflowed size_t. That is how a truncated
 * body escapes as valid-looking JSON.
 */
inline int appendNumber(char* out, size_t cap, size_t used, const char* key,
                        float value, int decimals) {
  if (!hasValue(value)) return 0;
  if (used >= cap) return -1;

  const size_t room = cap - used;
  const int written =
      decimals == 0
          ? snprintf(out + used, room, "\"%s\":%d,", key, static_cast<int>(lroundf(value)))
          : snprintf(out + used, room, "\"%s\":%.1f,", key, static_cast<double>(value));

  if (written < 0 || static_cast<size_t>(written) >= room) return -1;
  return written;
}

}  // namespace detail

/**
 * Serialises an uplink. Returns bytes written, or 0 if the buffer was too
 * small.
 *
 * Truncation returns 0 rather than a partial body. A half-written JSON object
 * is a 400 from the server and a reading lost to a formatting bug — better to
 * drop it here, where the caller can count it, than to spend the radio on
 * something that cannot parse.
 */
inline size_t encodeUplink(const Uplink& u, char* out, size_t cap) {
  if (cap == 0) return 0;

  size_t n = 0;
  int written = snprintf(out, cap, "{\"device_id\":\"%s\",", u.deviceKey);
  if (written < 0 || static_cast<size_t>(written) >= cap) return 0;
  n = static_cast<size_t>(written);

  const struct { const char* key; float value; int decimals; } numbers[] = {
      {"heart_rate", u.heartRate, 0},
      {"spo2", u.spo2, 0},
      {"temperature", u.temperature, 1},
      {"battery", u.batteryPercent, 0},
  };

  for (const auto& field : numbers) {
    const int written_field =
        detail::appendNumber(out, cap, n, field.key, field.value, field.decimals);
    if (written_field < 0) return 0;
    n += static_cast<size_t>(written_field);
  }

  if (n >= cap) return 0;
  written = snprintf(out + n, cap - n, "\"movement\":\"%s\",", movementName(u.movement));
  if (written < 0 || static_cast<size_t>(written) >= cap - n) return 0;
  n += static_cast<size_t>(written);

  // Omitted entirely when the clock has never been set. The server stamps
  // arrival time in that case, which is honest: a band with no NTP sync and no
  // RTC genuinely does not know what time it is, and inventing one would put
  // readings at the wrong point on a chart a clinician reads.
  if (u.recordedAt != nullptr && u.recordedAt[0] != '\0') {
    if (n >= cap) return 0;
    written = snprintf(out + n, cap - n, "\"recorded_at\":\"%s\",", u.recordedAt);
    if (written < 0 || static_cast<size_t>(written) >= cap - n) return 0;
    n += static_cast<size_t>(written);
  }

  if (n >= cap) return 0;
  written = snprintf(
      out + n, cap - n,
      "\"telemetry\":{"
      "\"rssi\":%d,\"uptime_s\":%lu,\"boot_count\":%lu,"
      "\"firmware\":\"%s\",\"transport\":\"%s\",\"buffered\":%u,"
      "\"sensors\":{\"pulse\":\"%s\",\"thermometer\":\"%s\",\"imu\":\"%s\"}}}",
      static_cast<int>(u.rssiDbm),
      static_cast<unsigned long>(u.uptimeSeconds),
      static_cast<unsigned long>(u.bootCount),
      u.firmwareVersion ? u.firmwareVersion : "unknown",
      u.transport ? u.transport : "wifi",
      static_cast<unsigned>(u.bufferedCount),
      sensorStateName(u.pulseSensor),
      sensorStateName(u.thermometer),
      sensorStateName(u.imu));

  if (written < 0 || static_cast<size_t>(written) >= cap - n) return 0;
  n += static_cast<size_t>(written);

  return n;
}

/**
 * Formats a UTC timestamp the server will accept.
 *
 * `epochSeconds` is Unix time from NTP. Returns false when the clock has never
 * been set, so the caller omits the field rather than sending 1970 — a
 * timestamp from 1970 is not a missing timestamp, it is a reading that sorts
 * before every other reading the patient has ever produced.
 */
inline bool formatIso8601(uint32_t epochSeconds, char* out, size_t cap) {
  // Anything before 2020 means NTP has not answered yet.
  if (epochSeconds < 1577836800UL || cap < 21) {
    if (cap > 0) out[0] = '\0';
    return false;
  }

  uint32_t days = epochSeconds / 86400UL;
  uint32_t rem = epochSeconds % 86400UL;

  const int hour = static_cast<int>(rem / 3600UL);
  const int minute = static_cast<int>((rem % 3600UL) / 60UL);
  const int second = static_cast<int>(rem % 60UL);

  // Civil-from-days, Howard Hinnant's algorithm: no time.h, no locale, no
  // 64-bit division on a 32-bit core.
  int32_t z = static_cast<int32_t>(days) + 719468;
  const int32_t era = (z >= 0 ? z : z - 146096) / 146097;
  const uint32_t doe = static_cast<uint32_t>(z - era * 146097);
  const uint32_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  int32_t y = static_cast<int32_t>(yoe) + era * 400;
  const uint32_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const uint32_t mp = (5 * doy + 2) / 153;
  const uint32_t d = doy - (153 * mp + 2) / 5 + 1;
  const uint32_t m = mp < 10 ? mp + 3 : mp - 9;
  y += (m <= 2);

  snprintf(out, cap, "%04ld-%02u-%02uT%02d:%02d:%02dZ",
           static_cast<long>(y), static_cast<unsigned>(m), static_cast<unsigned>(d),
           hour, minute, second);
  return true;
}

}  // namespace averis
