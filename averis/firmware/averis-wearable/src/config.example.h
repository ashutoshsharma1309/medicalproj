#pragma once
/**
 * AVERIS wearable — per-device configuration.
 *
 *     cp src/config.example.h src/config.h
 *
 * `config.h` is gitignored because it holds a device token. That token is the
 * band's whole identity: anything holding it can write readings into a
 * patient's chart, which is why it is issued once at registration, stored on
 * the server only as a SHA-256 hash, and never printed by this firmware after
 * boot.
 *
 * ── If you are flashing more than one band ─────────────────────────────────
 *
 * Every band needs its own key *and* its own token. Cloning a config across a
 * fleet means one revocation kills every band, and two bands writing under one
 * identity produce a single patient's chart containing two people's vital
 * signs — which is not a bug anyone would spot from the dashboard.
 */

// ── Build identity ─────────────────────────────────────────────────────────
// Reported in every uplink and shown on the hardware dashboard. Bump it when
// anything about what the band measures or sends changes — a fleet where two
// firmware versions behave differently and both report "1.0.0" is a fleet
// whose field reports cannot be believed.
#define AVERIS_FIRMWARE_VERSION "1.0.0"

// ── Identity ───────────────────────────────────────────────────────────────
// The key announced in every payload. Must match the device row exactly; the
// server compares it against the token's device and refuses a mismatch, so a
// typo here fails loudly at the first uplink rather than quietly writing
// somewhere unexpected.
#define AVERIS_DEVICE_KEY "AVR001"

// Issued once by Devices → Register a device. Shown one time and never again.
#define AVERIS_DEVICE_TOKEN "avd_replace_me"

// ── Network ────────────────────────────────────────────────────────────────
#define AVERIS_WIFI_SSID "your-network"
#define AVERIS_WIFI_PASSWORD "your-password"

// The ingest service, not the web app. A band talks to FastAPI directly —
// routing readings through Next.js would put a service-role credential in the
// path that serves patient dashboards.
#define AVERIS_INGEST_URL "http://192.168.1.50:8000/api/device/upload"
#define AVERIS_HELLO_URL "http://192.168.1.50:8000/api/device/hello"

// Use https:// in anything but a bench setup. Over http the token is on the
// wire in plaintext, and a token on the wire is a token anyone on the network
// can use to write into somebody's medical record.
//
// Defaults to 0 — certificates are validated. It was 1, which is the wrong
// default for a file people copy: an example config that ships with validation
// disabled is one that reaches a ward with validation disabled, and nobody
// reviews the line they did not have to change.
#define AVERIS_TLS_INSECURE 0  // set to 1 only on a bench with a self-signed cert

// ── Timing ─────────────────────────────────────────────────────────────────
// How often a reading is sent. The sensors are sampled far more often than
// this; the uplink carries the filtered value.
#define AVERIS_UPLINK_INTERVAL_MS 2000

// Sensor sampling. 20 Hz on the IMU is what fall detection needs — the impact
// phase of a real fall lasts under 100ms, and at 5 Hz it falls between samples.
#define AVERIS_IMU_SAMPLE_HZ 20
#define AVERIS_VITALS_SAMPLE_HZ 4

// ── Power ──────────────────────────────────────────────────────────────────
// Deep sleep between uplinks. Off by default, and the documentation says why:
// a sleeping band is not monitoring anyone, so this trades the thing the
// product exists for against battery life. Appropriate for an activity tracker
// and wrong for a patient at risk of falling.
#define AVERIS_DEEP_SLEEP_ENABLED 0
#define AVERIS_DEEP_SLEEP_MS 8000

// Below this, the band stops using WiFi and keeps only local alerting, so the
// last of the battery is spent buzzing rather than transmitting.
#define AVERIS_LOW_POWER_BATTERY_PCT 8

// ── Hardware ───────────────────────────────────────────────────────────────
// Pin map. Also in docs/HARDWARE.md — change both or neither.
#define AVERIS_I2C_SDA 21
#define AVERIS_I2C_SCL 22
#define AVERIS_BUZZER_PIN 25
#define AVERIS_BUTTON_PIN 26   // "I'm fine" — clears a latched fall
#define AVERIS_BATTERY_ADC_PIN 34

// The divider between the cell and the ADC. 2.0 for the usual 100k/100k pair.
#define AVERIS_BATTERY_DIVIDER 2.0f

// ── Features ───────────────────────────────────────────────────────────────
#define AVERIS_ENABLE_BLE 1
#define AVERIS_ENABLE_OLED 1
#define AVERIS_ENABLE_BUZZER 1

// Prints every reading to serial. Never leave this on in something a patient
// wears: it is a vital-sign stream out of a debug port.
//
// Also defaults to 0 now, for the same reason as TLS above. Turn it on while
// bringing a band up, and turn it off before it goes on a wrist.
#define AVERIS_SERIAL_DEBUG 0
