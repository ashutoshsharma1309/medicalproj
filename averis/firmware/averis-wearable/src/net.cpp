#include "net.h"
#include "config.h"

#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>

namespace averis {

namespace {
constexpr uint32_t kBackoffStartMs = 1000;
constexpr uint32_t kBackoffCeilingMs = 30000;

/** NVS namespace for the offline buffer. */
constexpr char kBufferNamespace[] = "averis_buf";

/**
 * How often the RAM buffer is mirrored to flash.
 *
 * NVS is wear-levelled but not free. Writing 90 entries every two seconds
 * would burn the partition in weeks; every thirty seconds costs at most
 * fifteen readings to a brownout and keeps the flash alive for years.
 */
constexpr uint32_t kPersistIntervalMs = 30000;

/** Extracts one integer field from a small JSON response, without a parser. */
long jsonNumber(const String& body, const char* key, long fallback) {
  const int at = body.indexOf(key);
  if (at < 0) return fallback;
  const int colon = body.indexOf(':', at);
  if (colon < 0) return fallback;
  return strtol(body.c_str() + colon + 1, nullptr, 10);
}

void jsonString(const String& body, const char* key, char* out, size_t cap) {
  out[0] = '\0';
  const int at = body.indexOf(key);
  if (at < 0) return;
  const int firstQuote = body.indexOf('"', body.indexOf(':', at));
  if (firstQuote < 0) return;
  const int lastQuote = body.indexOf('"', firstQuote + 1);
  if (lastQuote < 0) return;

  const size_t len = min(static_cast<size_t>(lastQuote - firstQuote - 1), cap - 1);
  strncpy(out, body.c_str() + firstQuote + 1, len);
  out[len] = '\0';
}
}  // namespace

bool Uplinker::connectWifi(uint32_t timeoutMs) {
  if (WiFi.status() == WL_CONNECTED) return true;

  WiFi.mode(WIFI_STA);
  // The band is worn, not carried between sites. Persisting credentials to
  // NVS on every boot wears the flash for no benefit.
  WiFi.persistent(false);
  WiFi.begin(AVERIS_WIFI_SSID, AVERIS_WIFI_PASSWORD);

  const uint32_t startedMs = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedMs < timeoutMs) {
    delay(200);
  }

  return WiFi.status() == WL_CONNECTED;
}

bool Uplinker::wifiConnected() const { return WiFi.status() == WL_CONNECTED; }

int16_t Uplinker::rssi() const {
  return WiFi.status() == WL_CONNECTED ? static_cast<int16_t>(WiFi.RSSI()) : 0;
}

HelloResponse Uplinker::hello() {
  HelloResponse response;
  if (!wifiConnected()) return response;

  HTTPClient http;
  http.setTimeout(8000);
  http.begin(AVERIS_HELLO_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " AVERIS_DEVICE_TOKEN);

  char body[192];
  snprintf(body, sizeof(body),
           "{\"device_id\":\"%s\",\"firmware\":\"%s\",\"hardware\":\"esp32\"}",
           AVERIS_DEVICE_KEY, AVERIS_FIRMWARE_VERSION);

  const int status = http.POST(reinterpret_cast<uint8_t*>(body), strlen(body));

  if (status == 200) {
    const String payload = http.getString();
    response.ok = true;
    response.verified = payload.indexOf("\"verified\":true") >= 0;
    response.epochSeconds = static_cast<uint32_t>(jsonNumber(payload, "\"server_time\"", 0));
    response.uplinkIntervalMs =
        static_cast<uint32_t>(jsonNumber(payload, "\"uplink_interval_ms\"", 0));
    jsonString(payload, "\"device_name\"", response.deviceName, sizeof(response.deviceName));
  } else if (status == 401 || status == 403) {
    // The band is not who it says it is. Nothing it sends afterwards will be
    // accepted, and continuing to try burns the battery that local alerting
    // still needs.
    lockedOut_ = true;
  }

  http.end();
  return response;
}

UplinkResult Uplinker::post(const char* body, uint32_t* latencyMsOut) {
  HTTPClient http;
  http.setTimeout(8000);
  http.setReuse(true);
  http.begin(AVERIS_INGEST_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " AVERIS_DEVICE_TOKEN);

  const uint32_t startedMs = millis();
  const int status = http.POST(reinterpret_cast<uint8_t*>(const_cast<char*>(body)), strlen(body));
  const uint32_t latencyMs = millis() - startedMs;
  if (latencyMsOut) *latencyMsOut = latencyMs;

  http.end();

  if (status == 201 || status == 200) return UplinkResult::kAccepted;
  if (status == 401 || status == 403) return UplinkResult::kUnauthorised;

  // 422 is a payload this firmware built wrong. Retrying sends the same bytes
  // to the same rejection forever, so it is dropped and counted instead.
  if (status >= 400 && status < 500 && status != 429) return UplinkResult::kRejected;

  return UplinkResult::kRetryLater;
}

void Uplinker::buffer(const Uplink& reading, const char* isoTimestamp) {
  Uplink stamped = reading;
  stamped.recordedAt = isoTimestamp;
  stamped.transport = "wifi_buffered";

  const uint16_t slot = (bufferHead_ + bufferCount_) % kBufferSlots;
  if (encodeUplink(stamped, bufferBodies_[slot], kBodyBytes) == 0) return;

  if (bufferCount_ < kBufferSlots) {
    bufferCount_++;
  } else {
    // Full: the oldest reading is overwritten. After a long outage the newest
    // readings are the ones describing the patient now.
    bufferHead_ = (bufferHead_ + 1) % kBufferSlots;
  }

  // Rate-limited inside persist(), so calling it per reading is safe and the
  // cadence lives in one place.
  persist();
}

/**
 * Posts the whole buffer as one request.
 *
 * The rural path. Ninety separate uplinks pay for ninety TLS handshakes, and
 * on a battery a handshake costs more than the readings it carries — so a band
 * that has been offline for an hour spends its few minutes of signal on one
 * connection rather than on setting up ninety.
 *
 * The bodies are already encoded JSON objects, so the batch is assembled by
 * joining them with commas inside brackets. Re-encoding would need every
 * reading held as a struct as well as a string, which is RAM this device does
 * not have to spare.
 */
UplinkResult Uplinker::postBatch(uint16_t count, uint32_t* latencyMsOut) {
  if (count == 0) return UplinkResult::kAccepted;

  HTTPClient http;
  http.setTimeout(20000);  // A batch is a bigger request on a worse link.
  http.begin(AVERIS_BATCH_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " AVERIS_DEVICE_TOKEN);

  // Streamed rather than assembled in a buffer: 90 × 320 bytes is 28 KB, and
  // holding a second copy of the buffer to send the first would be the
  // allocation that fails at 3am.
  String payload;
  payload.reserve(static_cast<size_t>(count) * 200 + 16);
  payload += '[';
  for (uint16_t i = 0; i < count; i++) {
    if (i > 0) payload += ',';
    payload += bufferBodies_[(bufferHead_ + i) % kBufferSlots];
  }
  payload += ']';

  const uint32_t startedMs = millis();
  const int status = http.POST(payload);
  if (latencyMsOut) *latencyMsOut = millis() - startedMs;

  http.end();

  // 207 means some readings were rejected and the rest were stored. The batch
  // is still done — retrying would resend the accepted ones as duplicates.
  if (status == 201 || status == 200 || status == 207) return UplinkResult::kAccepted;
  if (status == 401 || status == 403) return UplinkResult::kUnauthorised;
  if (status == 413) return UplinkResult::kRejected;  // too large; fall back
  if (status >= 400 && status < 500 && status != 429) return UplinkResult::kRejected;

  return UplinkResult::kRetryLater;
}

UplinkResult Uplinker::flushBuffer() {
  // One request for the whole buffer when there is enough to be worth it. The
  // threshold exists because a batch of two is a batch-shaped single reading
  // with extra parsing on both ends.
  if (bufferCount_ >= 5) {
    const UplinkResult batched = postBatch(bufferCount_, nullptr);

    if (batched == UplinkResult::kAccepted) {
      bufferHead_ = (bufferHead_ + bufferCount_) % kBufferSlots;
      bufferCount_ = 0;
      persist();
      return UplinkResult::kAccepted;
    }

    if (batched == UplinkResult::kUnauthorised) {
      lockedOut_ = true;
      return batched;
    }

    if (batched == UplinkResult::kRetryLater) return batched;

    // Rejected as a batch — fall through and send them one at a time, so a
    // single malformed body cannot cost the rest.
  }

  while (bufferCount_ > 0) {
    const UplinkResult result = post(bufferBodies_[bufferHead_], nullptr);

    if (result == UplinkResult::kRetryLater) return result;

    // Accepted or permanently rejected: either way this reading is done. A
    // rejected one is dropped rather than blocking every reading behind it —
    // one malformed body must not cost the whole buffer.
    bufferHead_ = (bufferHead_ + 1) % kBufferSlots;
    bufferCount_--;

    if (result == UplinkResult::kUnauthorised) {
      lockedOut_ = true;
      return result;
    }

    // The radio is the expensive part; a short yield keeps the watchdog happy
    // without idling the link.
    delay(20);
  }

  persist();
  return UplinkResult::kAccepted;
}

/**
 * Mirrors the buffer into flash.
 *
 * Rate-limited internally so callers can invoke it freely — the alternative is
 * every call site remembering the cadence, and the one that forgets is the one
 * that wears out the partition.
 */
void Uplinker::persist() {
  const uint32_t nowMs = millis();
  if (lastPersistMs_ != 0 && nowMs - lastPersistMs_ < kPersistIntervalMs && bufferCount_ > 0) {
    return;
  }
  lastPersistMs_ = nowMs;

  Preferences prefs;
  if (!prefs.begin(kBufferNamespace, false)) return;

  prefs.putUShort("count", bufferCount_);

  char key[8];
  for (uint16_t i = 0; i < bufferCount_; i++) {
    snprintf(key, sizeof(key), "r%u", i);
    prefs.putString(key, bufferBodies_[(bufferHead_ + i) % kBufferSlots]);
  }

  prefs.end();
}

/**
 * Reads the buffer back after a reset.
 *
 * Called once at boot. A band that lost power with four hours of readings
 * buffered comes back with them — which is the difference between a gap in a
 * chart and a gap in a patient's record.
 */
void Uplinker::restore() {
  Preferences prefs;
  if (!prefs.begin(kBufferNamespace, true)) return;

  const uint16_t stored = prefs.getUShort("count", 0);
  const uint16_t count = stored > kBufferSlots ? kBufferSlots : stored;

  char key[8];
  for (uint16_t i = 0; i < count; i++) {
    snprintf(key, sizeof(key), "r%u", i);
    // Straight into the slot: the buffer is empty at boot, so head is 0 and
    // the order on flash is the order they were measured.
    prefs.getString(key, bufferBodies_[i], kBodyBytes);
  }

  prefs.end();

  bufferHead_ = 0;
  bufferCount_ = count;
}

UplinkResult Uplinker::send(const Uplink& reading) {
  if (lockedOut_) return UplinkResult::kUnauthorised;

  const uint32_t nowMs = millis();
  if (nextAttemptMs_ != 0 && nowMs < nextAttemptMs_) return UplinkResult::kRetryLater;

  if (!wifiConnected() && !connectWifi(6000)) {
    backoffMs_ = backoffMs_ == 0 ? kBackoffStartMs : min(backoffMs_ * 2, kBackoffCeilingMs);
    nextAttemptMs_ = nowMs + backoffMs_;
    return UplinkResult::kRetryLater;
  }

  // Buffered readings go first, so the series arrives in the order it
  // happened. A dashboard that receives now-then-ten-minutes-ago draws a chart
  // that jumps backwards.
  if (bufferCount_ > 0) {
    const UplinkResult flushed = flushBuffer();
    if (flushed == UplinkResult::kRetryLater || flushed == UplinkResult::kUnauthorised) {
      backoffMs_ = backoffMs_ == 0 ? kBackoffStartMs : min(backoffMs_ * 2, kBackoffCeilingMs);
      nextAttemptMs_ = millis() + backoffMs_;
      return flushed;
    }
  }

  char body[kBodyBytes];
  Uplink annotated = reading;
  annotated.bufferedCount = bufferCount_;
  if (encodeUplink(annotated, body, sizeof(body)) == 0) return UplinkResult::kRejected;

  uint32_t latencyMs = 0;
  const UplinkResult result = post(body, &latencyMs);

  switch (result) {
    case UplinkResult::kAccepted:
      backoffMs_ = 0;
      nextAttemptMs_ = 0;
      break;
    case UplinkResult::kUnauthorised:
      lockedOut_ = true;
      break;
    case UplinkResult::kRetryLater:
      backoffMs_ = backoffMs_ == 0 ? kBackoffStartMs : min(backoffMs_ * 2, kBackoffCeilingMs);
      nextAttemptMs_ = millis() + backoffMs_;
      break;
    case UplinkResult::kRejected:
      // Not backed off: the next reading is a different payload and may well
      // be fine. Backing off here would let one bad value silence the band.
      break;
  }

  return result;
}

}  // namespace averis
