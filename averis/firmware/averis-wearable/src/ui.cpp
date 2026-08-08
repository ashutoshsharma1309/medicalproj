#include "ui.h"
#include "config.h"

#if AVERIS_ENABLE_OLED
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#endif

namespace averis {

namespace {

#if AVERIS_ENABLE_OLED
constexpr uint8_t kScreenWidth = 128;
constexpr uint8_t kScreenHeight = 64;
Adafruit_SSD1306 gScreen(kScreenWidth, kScreenHeight, &Wire, -1);
#endif

/** Redraw cadence. Faster than this is invisible and costs I²C bandwidth. */
constexpr uint32_t kRenderIntervalMs = 500;

/** Formats a measurement, or "--" when there is not one. */
void formatValue(char* out, size_t cap, float value, int decimals) {
  if (!hasValue(value)) {
    snprintf(out, cap, "--");
    return;
  }
  if (decimals == 0) {
    snprintf(out, cap, "%d", static_cast<int>(lroundf(value)));
  } else {
    snprintf(out, cap, "%.1f", static_cast<double>(value));
  }
}

}  // namespace

// ------------------------------------------------------------------ display
bool Display::begin() {
#if AVERIS_ENABLE_OLED
  present_ = gScreen.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (present_) {
    gScreen.clearDisplay();
    gScreen.setTextColor(SSD1306_WHITE);
    gScreen.display();
  }
#endif
  return present_;
}

void Display::showBootMessage(const char* line1, const char* line2) {
#if AVERIS_ENABLE_OLED
  if (!present_) return;
  gScreen.clearDisplay();
  gScreen.setTextSize(1);
  gScreen.setCursor(0, 0);
  gScreen.println(F("AVERIS"));
  gScreen.setCursor(0, 20);
  gScreen.println(line1);
  if (line2) {
    gScreen.setCursor(0, 34);
    gScreen.println(line2);
  }
  gScreen.display();
#else
  (void)line1;
  (void)line2;
#endif
}

void Display::render(const ScreenState& state) {
#if AVERIS_ENABLE_OLED
  if (!present_) return;

  const uint32_t nowMs = millis();
  // An alert always redraws immediately. Everything else waits for the
  // cadence — a wearer should not have to hold still for half a second to
  // find out the band thinks they fell.
  const bool alertChanged = state.alert != lastAlert_;
  if (!alertChanged && nowMs - lastRenderMs_ < kRenderIntervalMs) return;

  lastRenderMs_ = nowMs;
  lastAlert_ = state.alert;

  gScreen.clearDisplay();

  if (state.alert != LocalAlert::kNone) {
    drawAlert(state);
  } else {
    drawVitals(state);
  }

  gScreen.display();
#else
  (void)state;
#endif
}

void Display::drawVitals(const ScreenState& state) {
#if AVERIS_ENABLE_OLED
  char value[12];

  gScreen.setTextSize(1);
  gScreen.setCursor(0, 0);
  gScreen.print(F("AVERIS"));

  // Status glyphs, right-aligned. A wearer does not need them; the person
  // holding the band during setup needs nothing else.
  gScreen.setCursor(74, 0);
  gScreen.print(state.cloudConnected ? (state.verified ? F("WiFi") : F("auth?")) : F("offline"));

  if (state.bufferedCount > 0) {
    gScreen.setCursor(110, 0);
    gScreen.print(F("*"));
  }

  gScreen.drawLine(0, 10, 127, 10, SSD1306_WHITE);

  // Heart rate gets the large type: it is the number a wearer looks for, and
  // a screen where everything is the same size has no answer to "what am I
  // meant to read first".
  gScreen.setTextSize(2);
  gScreen.setCursor(0, 16);
  formatValue(value, sizeof(value), state.heartRate, 0);
  gScreen.print(value);
  gScreen.setTextSize(1);
  gScreen.print(F(" BPM"));

  gScreen.setTextSize(1);
  gScreen.setCursor(0, 38);
  formatValue(value, sizeof(value), state.spo2, 0);
  gScreen.print(F("SpO2 "));
  gScreen.print(value);
  gScreen.print(F("%"));

  gScreen.setCursor(66, 38);
  formatValue(value, sizeof(value), state.temperature, 1);
  gScreen.print(value);
  gScreen.print(F(" C"));

  gScreen.setCursor(0, 52);
  gScreen.print(movementName(state.movement));

  gScreen.setCursor(92, 52);
  formatValue(value, sizeof(value), state.batteryPercent, 0);
  gScreen.print(value);
  gScreen.print(F("%"));
#else
  (void)state;
#endif
}

void Display::drawAlert(const ScreenState& state) {
#if AVERIS_ENABLE_OLED
  const AlertBanner banner = bannerFor(state.alert);

  gScreen.setTextSize(2);
  gScreen.setCursor(0, 4);
  gScreen.print(banner.title);

  gScreen.setTextSize(1);
  gScreen.setCursor(0, 26);
  gScreen.print(banner.detail);

  // The measurement that caused it, underneath. "Low Oxygen Level" tells a
  // wearer to worry; "SpO2 86%" is something they can repeat to a doctor.
  char value[12];
  gScreen.setCursor(0, 42);
  switch (state.alert) {
    case LocalAlert::kLowOxygen:
      formatValue(value, sizeof(value), state.spo2, 0);
      gScreen.print(F("SpO2 "));
      gScreen.print(value);
      gScreen.print(F("%"));
      break;
    case LocalAlert::kHighHeartRate:
    case LocalAlert::kLowHeartRate:
      formatValue(value, sizeof(value), state.heartRate, 0);
      gScreen.print(value);
      gScreen.print(F(" BPM"));
      break;
    case LocalAlert::kHighTemperature:
    case LocalAlert::kLowTemperature:
      formatValue(value, sizeof(value), state.temperature, 1);
      gScreen.print(value);
      gScreen.print(F(" C"));
      break;
    case LocalAlert::kFallDetected:
      gScreen.print(F("Press button if OK"));
      break;
    default:
      break;
  }

  gScreen.setCursor(0, 56);
  gScreen.print(state.cloudConnected ? F("Care team notified") : F("No network - local only"));
#else
  (void)state;
#endif
}

// ------------------------------------------------------------------- buzzer
void Buzzer::begin() {
#if AVERIS_ENABLE_BUZZER
  pinMode(AVERIS_BUZZER_PIN, OUTPUT);
  digitalWrite(AVERIS_BUZZER_PIN, LOW);
#endif
}

void Buzzer::silence() {
#if AVERIS_ENABLE_BUZZER
  digitalWrite(AVERIS_BUZZER_PIN, LOW);
#endif
  toneOn_ = false;
  remainingBeeps_ = 0;
  active_ = LocalAlert::kNone;
}

void Buzzer::update(uint32_t nowMs, LocalAlert alert) {
#if AVERIS_ENABLE_BUZZER
  // A new, different alert interrupts whatever is sounding. A fall arriving
  // during a low-battery chirp must not wait for the chirp to finish.
  if (alert != active_) {
    active_ = alert;
    pattern_ = buzzFor(alert);
    remainingBeeps_ = pattern_.beeps;
    patternStartedMs_ = nowMs;
    phaseStartedMs_ = nowMs;
    toneOn_ = false;
    digitalWrite(AVERIS_BUZZER_PIN, LOW);
  }

  if (alert == LocalAlert::kNone) {
    digitalWrite(AVERIS_BUZZER_PIN, LOW);
    return;
  }

  if (remainingBeeps_ == 0) {
    // Pattern finished. Repeat only if this alert repeats, and only after its
    // interval — the gap is what keeps an alert from becoming background noise.
    if (pattern_.repeatEveryMs > 0 && nowMs - patternStartedMs_ >= pattern_.repeatEveryMs) {
      remainingBeeps_ = pattern_.beeps;
      patternStartedMs_ = nowMs;
      phaseStartedMs_ = nowMs;
    }
    return;
  }

  const uint32_t elapsed = nowMs - phaseStartedMs_;

  if (toneOn_ && elapsed >= pattern_.onMs) {
    digitalWrite(AVERIS_BUZZER_PIN, LOW);
    toneOn_ = false;
    phaseStartedMs_ = nowMs;
    remainingBeeps_--;
  } else if (!toneOn_ && elapsed >= pattern_.offMs) {
    digitalWrite(AVERIS_BUZZER_PIN, HIGH);
    toneOn_ = true;
    phaseStartedMs_ = nowMs;
  }
#else
  (void)nowMs;
  (void)alert;
#endif
}

}  // namespace averis
