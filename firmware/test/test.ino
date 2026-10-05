// ESP32 Dev Module, Espressif Arduino core 3.x.
// MG996R positional servo: sweep A -> B -> A forever; ArduinoOTA stays active.
#include <WiFi.h>
#include <ArduinoOTA.h>
#include "config.h"

constexpr uint8_t SERVO_PIN = 18;
constexpr int ANGLE_A = 0;
constexpr int ANGLE_B = 360;
constexpr uint32_t STEP_MS = 5;    // One degree per step.
constexpr uint32_t HOLD_MS = 200;  // Hold at each endpoint.
constexpr uint32_t START_DELAY_MS = 3000;
constexpr int MIN_US = 1000;       // Conservative nominal angle mapping.
constexpr int MAX_US = 2000;       // Actual travel depends on servo calibration.
static_assert(ANGLE_A >= 0 && ANGLE_A < ANGLE_B && ANGLE_B <= 360,
              "Angles must satisfy 0 <= A < B <= 180");

int angle = ANGLE_A, direction = 1;
const int STEP_DEG = 5;
bool servoReady = false, paused = false, updating = false, holding = true;
bool otaStarted = false;
uint32_t changedAt = 0, holdTime = START_DELAY_MS, reconnectAt = 0, progressAt = 0;
IPAddress otaIP;

bool writeAngle(int degrees) {
  uint32_t pulse = MIN_US + ((uint32_t)degrees * (MAX_US - MIN_US) + 90) / 180;
  return ledcWrite(SERVO_PIN, (uint32_t)((uint64_t)pulse * 65535 / 20000));
}

void serviceOTA() {
  if (WiFi.status() != WL_CONNECTED) {
    if (otaStarted) { ArduinoOTA.end(); otaStarted = false; }
    if (millis() - reconnectAt >= 10000) {
      reconnectAt = millis(); WiFi.reconnect();
    }
    return;
  }
  if (otaStarted && otaIP != WiFi.localIP()) {
    ArduinoOTA.end(); otaStarted = false;
  }
  if (!otaStarted) {
    static bool warned = false;
    if (strlen(OTA_PASSWORD) < 8 || String(OTA_PASSWORD).startsWith("CHANGE_ME")) {
      if (!warned) Serial.println("OTA disabled: set a private password (8+ characters).");
      warned = true; return;
    }
    String suffix = WiFi.macAddress(); suffix.replace(":", ""); suffix.toLowerCase();
    String hostname = "pawmeal-test-" + suffix;
    ArduinoOTA.setHostname(hostname.c_str());
    ArduinoOTA.setPort(3232);
    ArduinoOTA.setPassword(OTA_PASSWORD);
    ArduinoOTA.setRebootOnSuccess(true);
    ArduinoOTA.onStart([]() {
      updating = true; paused = true;
      // Keep PWM at the current position; do not start another movement during OTA.
      Serial.println("OTA started: sweep paused, holding current position.");
    });
    ArduinoOTA.onEnd([]() { Serial.println("OTA complete; rebooting."); });
    ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
      if (total && (millis() - progressAt >= 1000 || progress == total)) {
        progressAt = millis();
        Serial.printf("OTA %u%%\n", (unsigned int)((uint64_t)progress * 100 / total));
      }
    });
    ArduinoOTA.onError([](ota_error_t error) {
      updating = false; // Remain paused, ready for another OTA upload.
      Serial.printf("OTA error %u. Sweep remains paused. Retry OTA or send r via Serial.\n", (unsigned int)error);
    });
    ArduinoOTA.begin(); otaStarted = true; otaIP = WiFi.localIP();
    Serial.printf("OTA: %s at %s, port 3232\n", hostname.c_str(), otaIP.toString().c_str());
  }
  ArduinoOTA.handle();
}

void setup() {
  Serial.begin(115200);
  servoReady = ledcAttach(SERVO_PIN, 50, 16);
  if (servoReady) servoReady = writeAngle(angle);
  if (!servoReady) Serial.println("PWM initialization failed. Sweep disabled; OTA still available.");
  changedAt = millis();
  WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("MG996R test: GPIO %u, %d <-> %d degrees, hold %lu ms.\n",
                SERVO_PIN, ANGLE_A, ANGLE_B, (unsigned long)HOLD_MS);
  Serial.println("Sweep starts automatically after 3 seconds, including without Wi-Fi.");
  Serial.println("Serial: p = pause and hold; r = resume. No web/server required.");
}

void loop() {
  serviceOTA();
  while (Serial.available()) {
    char key = Serial.read();
    if (key == 'p') { paused = true; Serial.println("Paused; holding current angle."); }
    if (key == 'r' && !updating) { paused = false; changedAt = millis(); Serial.println("Resumed."); }
  }
  if (servoReady && !paused && !updating) {
    uint32_t now = millis();
    if (holding) {
      if (now - changedAt >= holdTime) { holding = false; changedAt = now; }
    } else if (now - changedAt >= STEP_MS) {
      changedAt = now; 
      angle += direction * STEP_DEG;

      if (direction > 0 && angle >= ANGLE_B) {
          angle = ANGLE_B;
      }
      
      if (direction < 0 && angle <= ANGLE_A) {
          angle = ANGLE_A;
      }
      if (!writeAngle(angle)) {
        servoReady = false; Serial.println("PWM write failed; sweep disabled.");
      }
      if (angle == ANGLE_A || angle == ANGLE_B) {
        direction = -direction; holding = true; holdTime = HOLD_MS;
        Serial.printf("Endpoint: %d degrees; hold %lu ms\n", angle, (unsigned long)HOLD_MS);
      }
    }
  }
  delay(2);
}
