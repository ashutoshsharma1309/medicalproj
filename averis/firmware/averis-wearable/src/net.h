#pragma once
/**
 * WiFi and the uplink.
 *
 * ── A reading that cannot be sent is not thrown away ───────────────────────
 *
 * The band buffers to RAM and replays when the link comes back. This is the
 * difference between a monitoring platform and a live dashboard: a patient who
 * walked into a basement for ten minutes should come back with ten minutes of
 * history, not a hole. The stored `recorded_at` is the device's own timestamp,
 * so replayed readings land at the moment they were measured rather than the
 * moment they arrived — which is the entire reason the wire contract accepts a
 * client timestamp at all.
 *
 * The buffer is bounded and drops **oldest first** when full. Dropping newest
 * would be easier and is wrong: after an hour offline, the newest readings are
 * the ones describing the patient now.
 *
 * ── Backoff, and why it is capped low ──────────────────────────────────────
 *
 * Exponential up to 30 seconds, not the usual several minutes. A band is not a
 * web client; the cost of retrying slightly too often is some battery, and the
 * cost of retrying too rarely is a patient whose deterioration reaches the
 * ward twenty minutes late.
 *
 * ── 401 stops everything ───────────────────────────────────────────────────
 *
 * A rejected token will never be accepted by retrying. The band stops
 * transmitting, says so on the display, and keeps buzzing locally — the local
 * alerting path has no dependency on the server, and a band whose token was
 * revoked should still tell the person wearing it that their oxygen is low.
 */

#include <Arduino.h>
#include "payload.h"

namespace averis {

/** What the server said, in the only terms the caller needs. */
enum class UplinkResult : uint8_t {
  kAccepted,
  kRetryLater,     // network error, 5xx, or 429
  kRejected,       // 4xx that will not improve — bad payload
  kUnauthorised,   // 401/403: stop trying
};

struct HelloResponse {
  bool ok = false;
  bool verified = false;
  char deviceName[48] = {0};
  /** Server time, for the RTC. The only clock the band ever trusts. */
  uint32_t epochSeconds = 0;
  /** Server-chosen cadence, so a fleet can be re-paced without reflashing. */
  uint32_t uplinkIntervalMs = 0;
};

class Uplinker {
 public:
  bool connectWifi(uint32_t timeoutMs = 20000);
  bool wifiConnected() const;
  int16_t rssi() const;

  /**
   * Announces the band and collects server time.
   *
   * Called once at boot and after every reconnect. The verification result is
   * what the OLED shows as "Verified" — a band displaying that has proved it
   * holds a token the server accepts, not merely that it has WiFi.
   */
  HelloResponse hello();

  /** Sends one reading, replaying anything buffered first. */
  UplinkResult send(const Uplink& reading);

  /** Stores a reading for later. Drops the oldest when full. */
  void buffer(const Uplink& reading, const char* isoTimestamp);

  uint16_t bufferedCount() const { return bufferCount_; }
  bool isLockedOut() const { return lockedOut_; }
  uint32_t backoffMs() const { return backoffMs_; }

 private:
  UplinkResult post(const char* body, uint32_t* latencyMsOut);
  UplinkResult flushBuffer();

  // 90 readings at the 2s cadence: three minutes of history, ~18 KB of RAM.
  // Sized against what an ESP32 can spare while holding a TLS session, not
  // against how long an outage might last — the honest limit is documented
  // rather than a number that pretends to cover any outage.
  static constexpr uint16_t kBufferSlots = 90;
  static constexpr size_t kBodyBytes = 320;

  char bufferBodies_[kBufferSlots][kBodyBytes] = {};
  uint16_t bufferHead_ = 0;
  uint16_t bufferCount_ = 0;

  uint32_t backoffMs_ = 0;
  uint32_t nextAttemptMs_ = 0;
  bool lockedOut_ = false;
};

}  // namespace averis
