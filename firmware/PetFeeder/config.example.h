#pragma once
// Copy this file to config.h. Never commit real credentials.
const char* WIFI_SSID = "Huynh";
const char* WIFI_PASSWORD = "0353744710";
// No trailing slash. Use your computer LAN IP, NOT localhost.
const char* SERVER_URL = "http://192.168.1.20:3000";
const char* DEVICE_TOKEN = "13ae24f7f68f90f99fbff2b6f572a330b53344a1bb3ebbedf996fc196c4e4be3";
// HTTP is permitted only for a trusted private LAN during setup.
constexpr bool ALLOW_LAN_HTTP = true;
// For HTTPS, paste the server certificate issuer's PEM root CA here.
const char* ROOT_CA = R"PEM(
)PEM";
constexpr int SERVO_PIN = 18;
// Calibrate this neutral pulse before attaching the dispensing mechanism.
constexpr int INITIAL_STOP_US = 1500;

// Arduino IDE network upload. Replace this placeholder in your private config.h.
// OTA remains disabled while the password is empty, short, or CHANGE_ME*.
#define OTA_PASSWORD "CHANGE_ME_USE_A_PRIVATE_PASSWORD"
// Lowercase letters/digits/hyphens only. Firmware appends the board MAC address.
#define OTA_HOSTNAME_PREFIX "pawmeal"
// MG996R: nominal angle pulse endpoints; calibrate with the linkage detached.
#ifndef SERVO_MIN_US
#define SERVO_MIN_US 1000
#endif
#ifndef SERVO_MAX_US
#define SERVO_MAX_US 2000
#endif
// INITIAL_STOP_US above is legacy and unused by position180 firmware.
