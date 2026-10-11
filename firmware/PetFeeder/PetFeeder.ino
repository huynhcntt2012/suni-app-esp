// Timed MG996R sweep; user-tested pulse mapping, protocol 4.
// Command indices are not measured shaft angles. ESP32 core 3.x, ArduinoJson 7.x.
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <ArduinoOTA.h>
#include <time.h>
#include <esp_system.h>
#include "config.h"
#include "TimedSweep.h"

// Older config.h files still compile; OTA stays off until a password is set.
#ifndef OTA_PASSWORD
#define OTA_PASSWORD ""
#endif
#ifndef OTA_HOSTNAME_PREFIX
#define OTA_HOSTNAME_PREFIX "pawmeal"
#endif

constexpr const char* FIRMWARE_BUILD = "ackfix-20261011";
Preferences prefs;
uint64_t lastCommand = 0, pendingAck = 0;
String ackStatus, ackError;
uint64_t receivedCommand = 0;
String commandError;
bool diagnosticsDirty = true;
uint32_t diagnosticsAt = 0;
uint32_t nextPoll = 0, lastReconnect = 0;

bool ready = false;
bool otaStarted = false, otaUpdating = false;
IPAddress otaIP;
uint32_t lastOtaProgress = 0;
uint32_t configVersion = 0;
int portionCount = 1, portionMs = 1500, closedAngle = 0, openAngle = 360, moveMs = 500;
String configError;
TimedSweep sweep;
int activeClosed = 0;
uint32_t motionStarted = 0;

bool setAngle(int index) {
  if (index < 0 || index > 360) return false;
  return ledcWrite(SERVO_PIN, (uint32_t)((uint64_t)sweepPulse(index) * 65535 / 20000));
}

bool validPositionSettings(JsonObject c) {
  if (String(c["servo_mode"] | "") != "timed_sweep" || !c["portions"].is<int>() || !c["portion_ms"].is<int>() ||
      !c["run_ms"].is<int>() || !c["closed_angle"].is<int>() || !c["open_angle"].is<int>() || !c["move_ms"].is<int>()) return false;
  int count=c["portions"], hold=c["portion_ms"], move=c["move_ms"], closed=c["closed_angle"], open=c["open_angle"];
  if(count<1 || count>20 || hold<200 || hold>10000 || move<200 || move>3000 ||
     closed<0 || closed>360 || open<0 || open>360 || abs(closed-open)<5) return false;
  int total=count*hold;
  return total<=60000 && c["run_ms"].as<int>()==total;
}

bool validFeedConfig(JsonObject c) {
  return c["version"].is<uint32_t>() && c["version"].as<uint32_t>()>0 && validPositionSettings(c);
}

void readFeedConfig(JsonObject c) {
  configVersion=c["version"].as<uint32_t>(); portionCount=c["portions"]; portionMs=c["portion_ms"];
  closedAngle=c["closed_angle"]; openAngle=c["open_angle"]; moveMs=c["move_ms"];
}

void writeFeedConfig(JsonObject c) {
  c["version"]=configVersion; c["servo_mode"]="timed_sweep"; c["portions"]=portionCount; c["portion_ms"]=portionMs;
  c["closed_angle"]=closedAngle; c["open_angle"]=openAngle; c["move_ms"]=moveMs;
  c["run_ms"]=portionCount*portionMs;
}

bool applyFeedConfig(JsonObject c) {
  if(!validFeedConfig(c)){configError="invalid";return false;}
  if(configVersion==c["version"].as<uint32_t>() && portionCount==c["portions"].as<int>() && portionMs==c["portion_ms"].as<int>() &&
     closedAngle==c["closed_angle"].as<int>() && openAngle==c["open_angle"].as<int>() && moveMs==c["move_ms"].as<int>()){
    configError="";return true;
  }
  // One NVS value prevents a partially updated configuration. No motion on save.
  JsonDocument stored;
  stored["version"]=c["version"].as<uint32_t>(); stored["servo_mode"]="timed_sweep";
  stored["portions"]=c["portions"].as<int>(); stored["portion_ms"]=c["portion_ms"].as<int>();
  stored["run_ms"]=c["run_ms"].as<int>(); stored["closed_angle"]=c["closed_angle"].as<int>();
  stored["open_angle"]=c["open_angle"].as<int>(); stored["move_ms"]=c["move_ms"].as<int>();
  String json;serializeJson(stored,json);
  if(prefs.putString("sweepcfg",json)!=json.length()){configError="storage";return false;}
  readFeedConfig(stored.as<JsonObject>());configError="";
  Serial.printf("Sweep config v%lu: %d portions, A=%d, B=%d, runtime/portion=%d ms, endpoint hold=%d ms\n",(unsigned long)configVersion,portionCount,closedAngle,openAngle,portionMs,moveMs);
  return true;
}

void serviceOTA() {
  if (WiFi.status() != WL_CONNECTED) {
    if (otaStarted) { ArduinoOTA.end(); otaStarted = false; }
    return;
  }
  // Restart mDNS/UDP after reconnection or a DHCP address change.
  if (otaStarted && otaIP != WiFi.localIP()) {
    ArduinoOTA.end(); otaStarted = false;
  }
  if (!otaStarted) {
    static bool passwordWarning = false;
    if (strlen(OTA_PASSWORD) < 8 || String(OTA_PASSWORD).startsWith("CHANGE_ME")) {
      if (!passwordWarning) Serial.println("OTA disabled: set a private OTA_PASSWORD (8+ characters) in config.h.");
      passwordWarning = true;
      return;
    }
    String suffix = WiFi.macAddress(); suffix.replace(":", ""); suffix.toLowerCase();
    String hostname = String(OTA_HOSTNAME_PREFIX) + "-" + suffix;
    ArduinoOTA.setHostname(hostname.c_str());
    ArduinoOTA.setPort(3232);
    // Allow brief Wi-Fi stalls while receiving each OTA data block.
    ArduinoOTA.setTimeout(10000);
    ArduinoOTA.setPassword(OTA_PASSWORD);
    ArduinoOTA.setRebootOnSuccess(true);
    ArduinoOTA.onStart([]() {
      otaUpdating = true;
      // OTA runs only after returning to A; retain holding PWM.
      Serial.println("OTA started. Feeding paused; holding endpoint A.");
    });
    ArduinoOTA.onEnd([]() {
      Serial.println("OTA complete. Rebooting...");
    });
    ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
      if (total && (millis() - lastOtaProgress >= 500 || progress == total)) {
        lastOtaProgress = millis();
        Serial.printf("OTA: %u%%\n", (unsigned int)((uint64_t)progress * 100 / total));
      }
    });
    ArduinoOTA.onError([](ota_error_t error) {
      otaUpdating = false;
      nextPoll = millis() + 5000;
      Serial.printf("OTA error %u (0=auth, 1=begin, 2=connect, 3=receive, 4=end). Retry upload.\n", (unsigned int)error);
    });
    ArduinoOTA.begin();
    otaStarted = true; otaIP = WiFi.localIP();
    Serial.printf("OTA: %s at %s, port 3232\n", hostname.c_str(), otaIP.toString().c_str());
  }
  ArduinoOTA.handle();
  // An authenticated request can schedule the update for the next handle().
  // Service it before doing a potentially blocking feeder API request.
  ArduinoOTA.handle();
}

bool request(const char* endpoint, const String& body, JsonDocument& output) {
  if (WiFi.status() != WL_CONNECTED) return false;
  const String base(SERVER_URL);
  const bool tls = base.startsWith("https://");
  if (!tls && (!ALLOW_LAN_HTTP || !base.startsWith("http://"))) {
    Serial.println("API blocked: use HTTPS, or explicitly enable LAN HTTP.");return false;
  }
  // Wait for NTP before validating HTTPS certificate dates.
  if (tls && strlen(ROOT_CA) < 100) {
    Serial.println("HTTPS blocked: ROOT_CA is missing. Configure the server root CA and reflash.");return false;
  }
  if (tls && time(nullptr) < 1700000000) {
    Serial.println("HTTPS waiting for NTP clock sync. Check Internet/NTP access.");return false;
  }
  WiFiClient plain;
  WiFiClientSecure secureClient;
  HTTPClient http;
  if (tls) secureClient.setCACert(ROOT_CA);
  bool started = tls ? http.begin(secureClient, base + endpoint) : http.begin(plain, base + endpoint);
  if (!started) return false;
  http.setConnectTimeout(3000);
  http.setTimeout(4000);
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  bool ok = false;
  if (code == 200) {
    DeserializationError error=deserializeJson(output, http.getString());
    ok=!error;
    if(error)Serial.printf("API %s: HTTP 200 but invalid JSON: %s\n",endpoint,error.c_str());
  }
  else {
    Serial.printf("API %s status: %d\n",endpoint,code);
    if(code<0)Serial.printf("Connection error: %s\n",HTTPClient::errorToString(code).c_str());
    if(code==401)Serial.println("Device token rejected: check DEVICE_TOKEN and the server database.");
    if(code==403)Serial.println("Access forbidden: inspect proxy/Cloudflare rules for /api/device/*.");
    if(code>=300 && code<400)Serial.println("Redirect received: use the final HTTPS URL without an access/login redirect.");
  }
  http.end();
  return ok;
}

// One NVS record prevents IDs and result from different commands being mixed after reset.
bool persistCommand(uint64_t last, uint64_t pending, const String& status, const String& error) {
  JsonDocument record;
  record["last"]=last;record["pending"]=pending;record["status"]=status;record["error"]=error;
  String raw;serializeJson(record,raw);
  if(prefs.putString("exec4",raw)!=raw.length())return false;
  lastCommand=last;pendingAck=pending;ackStatus=status;ackError=error;
  return true;
}

bool loadCommand() {
  if(!prefs.isKey("exec4")) {
    uint64_t oldLast=prefs.getULong64("last",0), oldPending=prefs.getULong64("pending",0);
    // A legacy interrupted write could have saved pending before last.
    if(oldPending>oldLast)oldLast=oldPending;
    return persistCommand(oldLast,oldPending,prefs.getString("result","interrupted"),prefs.getString("ackerr",""));
  }
  JsonDocument r;
  if(deserializeJson(r,prefs.getString("exec4","")) || !r["last"].is<uint64_t>() || !r["pending"].is<uint64_t>() ||
     !r["status"].is<String>() || !r["error"].is<String>())return false;
  String status=r["status"].as<String>();
  uint64_t last=r["last"].as<uint64_t>(),pending=r["pending"].as<uint64_t>();
  if((status!="completed"&&status!="interrupted") || pending>last)return false;
  lastCommand=last;pendingAck=pending;ackStatus=status;ackError=r["error"].as<String>();
  return true;
}

void finishFeeding(bool success) {
  if(!setAngle(activeClosed)){ledcWrite(SERVO_PIN,0);success=false;}
  sweep.running=false;
  String result=success?"completed":"interrupted";
  String reason=success?"":"pwm";
  if(!persistCommand(lastCommand,pendingAck,result,reason)){
    // Motion may have finished, but its durable result is unknown. Do not claim success.
    ackStatus="interrupted";ackError="storage";commandError="storage";ready=false;
  }else if(!success){commandError="pwm";ready=false;}
  diagnosticsDirty=true;
  Serial.printf("Command %llu END: elapsed=%lu ms including return to A, result=%s. Shaft position is not measured.\n",(unsigned long long)lastCommand,(unsigned long)(millis()-motionStarted),ackStatus.c_str());
}

void execute(JsonObject c) {
  diagnosticsDirty=true;
  if(sweep.running){commandError="busy";Serial.println("Command rejected: motor busy.");return;}
  if(!c["id"].is<uint64_t>()){commandError="invalid_id";Serial.println("Command rejected: invalid/missing numeric id.");return;}
  uint64_t id=c["id"].as<uint64_t>();
  receivedCommand=id;
  Serial.printf("Command received: id=%llu, last saved id=%llu\n",(unsigned long long)id,(unsigned long long)lastCommand);
  if(!validPositionSettings(c)){
    commandError="invalid_command";
    Serial.println("Command rejected: mode, endpoints, duration or total do not match protocol 4.");return;
  }
  if(!id || id<=lastCommand){
    commandError="old_id";
    Serial.println("Command rejected: duplicate/older id. If the server database was replaced, reconcile its command IDs; do not replay old feeding commands.");return;
  }
  // Persist before motion. An interrupted or duplicate command must never replay.
  if(!persistCommand(id,id,"interrupted","")){
    commandError="storage";
    ready=false;Serial.println("NVS error; feeding disabled until restart.");return;
  }
  commandError="";lastCommand=id;activeClosed=c["closed_angle"];
  motionStarted=millis();
  sweep.start(activeClosed,c["open_angle"].as<int>(),c["move_ms"].as<uint32_t>(),c["run_ms"].as<uint32_t>(),motionStarted);
  Serial.printf("Command %llu START: timed sweep A=%d B=%d, 5 units/5 ms, hold=%d ms, runtime=%d ms\n",(unsigned long long)id,activeClosed,c["open_angle"].as<int>(),c["move_ms"].as<int>(),c["run_ms"].as<int>());
  if(!setAngle(activeClosed))finishFeeding(false);
}

void tickFeeding() {
  int previous=sweep.position;
  bool wasReturning=sweep.returning;
  sweep.tick(millis());
  if(sweep.position!=previous && !setAngle(sweep.position)){finishFeeding(false);return;}
  if(!wasReturning && sweep.returning)Serial.println("Runtime finished; returning to A.");
  if(!sweep.running)finishFeeding(true);
}

void setup() {
  Serial.begin(115200);
  if (!ledcAttach(SERVO_PIN, 50, 16)) { Serial.println("PWM init failed"); return; }
  ledcWrite(SERVO_PIN,0);
  if(!prefs.begin("pawmeal",false)){Serial.println("NVS init failed");return;}
  JsonDocument stored;
  String saved=prefs.getString("sweepcfg","");
  if(saved.length() && !deserializeJson(stored,saved) && validFeedConfig(stored.as<JsonObject>()))readFeedConfig(stored.as<JsonObject>());
  // After reboot close the gate, even if the previous cycle was interrupted.
  // Old continuous config is deliberately not interpreted as position settings.
  if(!setAngle(closedAngle)){Serial.println("Initial close PWM failed");return;}
  delay(moveMs);
  bool commandStateOk=loadCommand();
  if(!commandStateOk){commandError="storage";Serial.println("Invalid command storage; feeding disabled.");}
  if(pendingAck && ackStatus=="interrupted" && !ackError.length()){
    switch(esp_reset_reason()){
      case ESP_RST_BROWNOUT: ackError="reset_brownout";break;
      case ESP_RST_INT_WDT: case ESP_RST_TASK_WDT: case ESP_RST_WDT: ackError="reset_watchdog";break;
      case ESP_RST_PANIC: ackError="reset_panic";break;
      case ESP_RST_POWERON: ackError="reset_power_on";break;
      default: ackError="reset_other";
    }
    if(!persistCommand(lastCommand,pendingAck,ackStatus,ackError)){commandStateOk=false;commandError="storage";}
  }
  Serial.printf("Saved command state: last=%llu, pending ACK=%llu, result=%s\n",(unsigned long long)lastCommand,(unsigned long long)pendingAck,ackStatus.c_str());
  WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  WiFi.setSleep(false); // Prefer responsive OTA/network traffic on this mains-powered device.
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  ready = commandStateOk;
  Serial.println("PawMeal ready. Waiting for Wi-Fi...");
}

void loop() {
  // Motor deadlines run without HTTP/flash/OTA work, even if Wi-Fi drops.
  if(sweep.running){tickFeeding();delay(2);return;}
  // OTA is handled only with the gate closed.
  serviceOTA();
  if (otaUpdating) { delay(100); return; }
  if (WiFi.status() != WL_CONNECTED) {
    if (millis()-lastReconnect > 15000) { lastReconnect = millis(); WiFi.reconnect(); }
    delay(50); return;
  }
  if ((int32_t)(millis()-nextPoll) < 0) { delay(10); return; }
  nextPoll = millis()+2000;
  JsonDocument reply;
  // Read-only telemetry endpoint: cannot deliver a feeding command or alter NVS.
  // Send even when feeding was disabled after a storage failure.
  if(diagnosticsDirty || millis()-diagnosticsAt>=10000){
    JsonDocument report;
    report["last_command_id"]=lastCommand;report["received_command_id"]=receivedCommand;
    report["pending_ack_id"]=pendingAck;report["error_code"]=commandError;
    report["ready"]=ready;report["result"]=ackStatus;
    String json;serializeJson(report,json);
    diagnosticsAt=millis();
    if(request("/api/device/diagnostics",json,reply))diagnosticsDirty=false;
  }
  // Retry acknowledgements even when motion is disabled by a fault.
  // Retry acknowledgements only, never repeat motor operation.
  if (pendingAck) {
    Serial.printf("Sending ACK: id=%llu, status=%s\n",(unsigned long long)pendingAck,ackStatus.c_str());
    JsonDocument ack; ack["id"] = pendingAck; ack["status"] = ackStatus; ack["error_code"] = ackError; ack["firmware_build"] = FIRMWARE_BUILD;
    String body; serializeJson(ack, body);
    if (request("/api/device/ack", body, reply)) {
      if (persistCommand(lastCommand,0,ackStatus,ackError)) { diagnosticsDirty=true;Serial.println("ACK accepted by API."); }
      else {ready=false;commandError="storage";diagnosticsDirty=true;Serial.println("ACK accepted, but clearing local NVS pending state failed.");}
    }
    return;
  }
  if(!ready)return;
  JsonDocument heartbeat;
  heartbeat["protocol"] = 4;
  if (configVersion) writeFeedConfig(heartbeat["applied_config"].to<JsonObject>());
  if (configError.length()) heartbeat["config_error"] = configError;
  String body; serializeJson(heartbeat, body);
  if (request("/api/device/poll", body, reply)) {
    // Only a valid persisted config permits execution.
    if (!reply["config"].is<JsonObject>()) { Serial.println("Poll rejected: missing config object.");return; }
    if (!applyFeedConfig(reply["config"].as<JsonObject>())) { Serial.printf("Poll rejected: config error=%s\n",configError.c_str());return; }
    if (reply["command"].is<JsonObject>()) execute(reply["command"].as<JsonObject>());
  }
}
