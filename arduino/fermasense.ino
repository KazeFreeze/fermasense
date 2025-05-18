#include <OneWire.h>
#include <DallasTemperature.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// --- Pin Definitions ---
#define ONE_WIRE_BUS_PIN 2
#define HEAT_PIN 3
#define COOL_PIN 4

// --- Temperature Sensor Setup ---
OneWire oneWire(ONE_WIRE_BUS_PIN);
DallasTemperature sensors(&oneWire);
DeviceAddress sensorDeviceAddress;

// --- LCD Setup ---
LiquidCrystal_I2C lcd(0x27, 16, 2); // Address 0x27, 16 chars, 2 lines

// --- Control Variables ---
float currentTemperature = -127.0;
float setTemperatureMin = 24.0;    // Default minimum desired temperature (Celsius)
float setTemperatureMax = 26.0;    // Default maximum desired temperature (Celsius)
const float TEMP_HYSTERESIS = 0.25; // Hysteresis for decision making relative to range boundaries

const float MIN_SETTABLE_TEMP = 4.0;
const float MAX_SETTABLE_TEMP = 50.0;

enum ControlState { IDLE, HEATING, COOLING };
ControlState currentControlState = IDLE;
ControlState manualOverrideState = IDLE;
bool manualModeActive = false;

unsigned long lastTempReadTime = 0;
unsigned long temperatureReadInterval = 5000; // ms

// For recording equalization time
unsigned long setpointChangedTimestamp = 0;
bool isEqualizing = false;
float lastSetpointMinBeforeChange = 0.0;
float lastSetpointMaxBeforeChange = 0.0;


// --- Function Prototypes ---
void readTemperatureSensor();
void updateControlLogic();
void applyControlState(ControlState targetState);
void updateLcdDisplay();
void processSerialCommands();
void startEqualizationTiming(float oldMin, float oldMax, float newMin, float newMax);
void checkAndLogEqualization();

void setup() {
    Serial.begin(115200);

    pinMode(HEAT_PIN, OUTPUT);
    pinMode(COOL_PIN, OUTPUT);
    applyControlState(IDLE);

    lcd.init();
    lcd.backlight();
    lcd.setCursor(0, 0);
    lcd.print("FermaSense Boot");
    delay(1000);

    sensors.begin();
    if (!sensors.getAddress(sensorDeviceAddress, 0)) {
        Serial.println("ERROR,DS18B20_NOT_FOUND");
        lcd.clear();
        lcd.print("Sensor Error!");
        while (true); // Halt
    }
    sensors.setResolution(sensorDeviceAddress, 12);
    sensors.setWaitForConversion(false);
    sensors.requestTemperaturesByIndex(0);
    lastTempReadTime = millis();
    setpointChangedTimestamp = millis();

    Serial.println("INFO,FermaSense Ready");
    Serial.println("INFO,Commands: SET_TEMP_RANGE=<min>,<max> | SET_FREQ=<ms> | MODE_AUTO | MODE_MANUAL | MANUAL_HEAT/COOL/IDLE | GET_STATUS");
    updateLcdDisplay();
}

void loop() {
    unsigned long currentTime = millis();

    processSerialCommands();

    if (currentTime - lastTempReadTime >= temperatureReadInterval) {
        readTemperatureSensor();
        lastTempReadTime = currentTime;

        updateControlLogic();
        updateLcdDisplay();

        // DATA,Timestamp_s,CurrentTemp,SetTempMin,SetTempMax,State,Mode
        Serial.print("DATA,");
        Serial.print(currentTime / 1000.0, 2);
        Serial.print(",");
        Serial.print(currentTemperature, 2);
        Serial.print(",");
        Serial.print(setTemperatureMin, 2);
        Serial.print(",");
        Serial.print(setTemperatureMax, 2);
        Serial.print(",");
        String stateStr = "IDLE";
        if (currentControlState == HEATING) stateStr = "HEATING";
        else if (currentControlState == COOLING) stateStr = "COOLING";
        Serial.print(stateStr);
        Serial.print(",");
        Serial.println(manualModeActive ? "MANUAL" : "AUTO");

        checkAndLogEqualization();
    }
}

void readTemperatureSensor() {
    if (sensors.isConversionComplete()) {
        float tempC = sensors.getTempCByIndex(0);
        if (tempC == DEVICE_DISCONNECTED_C || tempC < -50 || tempC > 120) {
            Serial.println("ERROR,TEMP_SENSOR_READ_FAILED");
            currentTemperature = -127.0;
        } else {
            currentTemperature = tempC;
        }
        sensors.requestTemperaturesByIndex(0);
    }
}

void updateControlLogic() {
    if (currentTemperature == -127.0) {
        applyControlState(IDLE);
        return;
    }

    if (manualModeActive) {
        applyControlState(manualOverrideState);
    } else { // Automatic mode
        // If temp is below the lower bound of the range (minus hysteresis), heat.
        if (currentTemperature < setTemperatureMin - TEMP_HYSTERESIS) {
            applyControlState(HEATING);
        // If temp is above the upper bound of the range (plus hysteresis), cool.
        } else if (currentTemperature > setTemperatureMax + TEMP_HYSTERESIS) {
            applyControlState(COOLING);
        // If temp is within the desired range (inclusive of hysteresis boundaries for stability)
        } else if (currentTemperature >= setTemperatureMin && currentTemperature <= setTemperatureMax) {
             applyControlState(IDLE);
        }
        // If outside the range but within hysteresis, do nothing to prevent rapid switching
        // e.g. if range is 24-26, hysteresis 0.25.
        // Heat if < 23.75. Cool if > 26.25. Idle if 24.00 - 26.00.
        // If 23.80 and was heating, continue heating until >= 24.00.
        // If 26.20 and was cooling, continue cooling until <= 26.00.
        // This logic is handled by only changing state if crossing the outer hysteresis boundaries.
        // And then changing to IDLE once *inside* the setpoint range.
    }
}

void applyControlState(ControlState targetState) {
    // Only change if the target state is different from current state
    // OR if in manual mode and the manual override state is different from current applied state.
    if (currentControlState == targetState && !(manualModeActive && targetState != manualOverrideState && currentControlState != manualOverrideState)) {
        // If manual mode is active and the target state (from auto logic) is different from the manual override,
        // but the current *applied* state IS the manual override, then no change is needed from this call.
        // The manual override takes precedence.
        // However, if manual mode is active and a new manual command comes (manualOverrideState changes),
        // then currentControlState should be updated to manualOverrideState.
        if(manualModeActive && currentControlState != manualOverrideState) {
             // This case handles when switching to manual or changing manual command
        } else {
            return; // No change needed
        }
    }


    currentControlState = targetState; // This will be overridden by manualOverrideState if manualModeActive in updateControlLogic

    // Actual application of state to pins
    ControlState stateToApply = manualModeActive ? manualOverrideState : currentControlState;

    // Re-check if actual pin state needs to change based on stateToApply
    // This is a bit redundant if applyControlState is only called from updateControlLogic
    // but good for direct calls if any.
    // Let's simplify: assume updateControlLogic sets currentControlState (or manualOverrideState) correctly.
    // This function just applies that.

    switch (stateToApply) {
        case IDLE:
            if (digitalRead(HEAT_PIN) == HIGH || digitalRead(COOL_PIN) == HIGH) { // Only print if changing
                Serial.println("INFO,TEC switched to IDLE");
            }
            digitalWrite(HEAT_PIN, LOW);
            digitalWrite(COOL_PIN, LOW);
            break;
        case HEATING:
            if (digitalRead(HEAT_PIN) == LOW) { // Only print if changing
                 Serial.println("INFO,TEC switched to HEATING");
            }
            digitalWrite(COOL_PIN, LOW);
            digitalWrite(HEAT_PIN, HIGH);
            break;
        case COOLING:
            if (digitalRead(COOL_PIN) == LOW) { // Only print if changing
                 Serial.println("INFO,TEC switched to COOLING");
            }
            digitalWrite(HEAT_PIN, LOW);
            digitalWrite(COOL_PIN, HIGH);
            break;
    }
    // After applying, ensure currentControlState reflects the applied state
    // This is tricky because currentControlState is used for auto logic.
    // Let's keep currentControlState as what the *auto* logic would do,
    // and use stateToApply for actual pin setting.
    // The LCD and serial DATA should report the *actual* state (stateToApply).
    // For simplicity, let's assume currentControlState reflects the *actual* applied state.
    // If manualModeActive, currentControlState will be set to manualOverrideState by updateControlLogic.
}


void updateLcdDisplay() {
    lcd.clear();
    // Row 0: Mode and Current State
    lcd.setCursor(0, 0);
    if (manualModeActive) {
        lcd.print("Manual:");
    } else {
        lcd.print("Auto:  "); // Extra space for alignment
    }
    
    ControlState displayedState = manualModeActive ? manualOverrideState : currentControlState;
    lcd.setCursor(7, 0);
    switch (displayedState) {
        case IDLE:    lcd.print("Idle   "); break;
        case HEATING: lcd.print("Heating"); break;
        case COOLING: lcd.print("Cooling"); break;
    }

    // Row 1: Temperatures T:curr S:min-max
    lcd.setCursor(0, 1);
    lcd.print("T:");
    if (currentTemperature == -127.0) {
        lcd.print("ERR");
    } else {
        lcd.print(currentTemperature, 1);
    }
    lcd.print((char)223); // Degree symbol
    
    lcd.print(" S:");
    lcd.print(setTemperatureMin, 0); // Show min int
    lcd.print("-");
    lcd.print(setTemperatureMax, 0); // Show max int
    // lcd.print((char)223); // Degree symbol for range might be too much
}

void startEqualizationTiming(float oldMin, float oldMax, float newMin, float newMax) {
    // Start timing if current temp is outside the new range, or if the range itself significantly changed
    bool rangeChangedSignificantly = abs(oldMin - newMin) > 0.1 || abs(oldMax - newMax) > 0.1;
    bool outsideNewRange = (currentTemperature < newMin - TEMP_HYSTERESIS || currentTemperature > newMax + TEMP_HYSTERESIS);

    if ((rangeChangedSignificantly || outsideNewRange) && currentTemperature != -127.0) {
        setpointChangedTimestamp = millis();
        isEqualizing = true;
        lastSetpointMinBeforeChange = newMin;
        lastSetpointMaxBeforeChange = newMax;
        Serial.print("INFO,Equalization timer started for setpoint range: ");
        Serial.print(newMin, 1); Serial.print("-"); Serial.println(newMax, 1);
    } else {
        isEqualizing = false; // Already within or very close to new setpoint range
    }
}

void checkAndLogEqualization() {
    if (isEqualizing) {
        // Check if temperature is now within the target range
        bool withinTargetRange = (currentTemperature >= lastSetpointMinBeforeChange && currentTemperature <= lastSetpointMaxBeforeChange);
        
        // System settled: in auto mode and IDLE, or manual mode and manual state is IDLE
        ControlState actualCurrentState = manualModeActive ? manualOverrideState : currentControlState;
        bool systemSettled = (!manualModeActive && actualCurrentState == IDLE) ||
                             (manualModeActive && actualCurrentState == IDLE);


        if (withinTargetRange && systemSettled && currentTemperature != -127.0) {
            unsigned long equalizationDurationMs = millis() - setpointChangedTimestamp;
            // EQUALIZED,TargetTempMin,TargetTempMax,Duration_s
            Serial.print("EQUALIZED,");
            Serial.print(lastSetpointMinBeforeChange, 2);
            Serial.print(",");
            Serial.print(lastSetpointMaxBeforeChange, 2);
            Serial.print(",");
            Serial.println(equalizationDurationMs / 1000.0, 2); // Duration in seconds
            isEqualizing = false;
        }
    }
}

void processSerialCommands() {
    if (Serial.available() > 0) {
        String command = Serial.readStringUntil('\n');
        command.trim();
        Serial.print("CMD_RECV,"); Serial.println(command);

        if (command.startsWith("SET_TEMP_RANGE=")) {
            String params = command.substring(15); // Length of "SET_TEMP_RANGE="
            int commaIndex = params.indexOf(',');
            if (commaIndex != -1) {
                float newSetMin = params.substring(0, commaIndex).toFloat();
                float newSetMax = params.substring(commaIndex + 1).toFloat();

                if (newSetMin >= MIN_SETTABLE_TEMP && newSetMax <= MAX_SETTABLE_TEMP && newSetMin <= newSetMax) {
                    if (abs(setTemperatureMin - newSetMin) > 0.01 || abs(setTemperatureMax - newSetMax) > 0.01) {
                        float oldMin = setTemperatureMin;
                        float oldMax = setTemperatureMax;
                        setTemperatureMin = newSetMin;
                        setTemperatureMax = newSetMax;
                        Serial.print("INFO,Setpoint range changed to: ");
                        Serial.print(setTemperatureMin, 1); Serial.print("-"); Serial.println(setTemperatureMax, 1);
                        if (!manualModeActive) {
                            startEqualizationTiming(oldMin, oldMax, newSetMin, newSetMax);
                        } else {
                            isEqualizing = false;
                        }
                    }
                } else {
                    Serial.print("ERROR,SET_TEMP_RANGE_INVALID. Min: "); Serial.print(MIN_SETTABLE_TEMP);
                    Serial.print(", Max: "); Serial.print(MAX_SETTABLE_TEMP);
                    Serial.println(", Min <= Max required.");
                }
            } else {
                 Serial.println("ERROR,SET_TEMP_RANGE_FORMAT. Use: <min>,<max>");
            }
        } else if (command.startsWith("SET_FREQ=")) {
            long newFreq = command.substring(9).toInt();
            if (newFreq >= 1000 && newFreq <= 600000) {
                temperatureReadInterval = newFreq;
                Serial.print("INFO,Temp. read interval set to: "); Serial.print(temperatureReadInterval); Serial.println(" ms");
            } else {
                Serial.println("ERROR,SET_FREQ_OUT_OF_RANGE (1000-600000ms)");
            }
        } else if (command.equals("MODE_AUTO")) {
            if (manualModeActive) {
                manualModeActive = false;
                isEqualizing = false; 
                startEqualizationTiming(setTemperatureMin, setTemperatureMax, setTemperatureMin, setTemperatureMax); // Check if equalization needed for current range
                Serial.println("INFO,Mode changed to AUTO");
            }
        } else if (command.equals("MODE_MANUAL")) {
            if (!manualModeActive) {
                manualModeActive = true;
                manualOverrideState = IDLE; // Default to IDLE
                isEqualizing = false;
                Serial.println("INFO,Mode changed to MANUAL. System IDLE. Use MANUAL_HEAT/COOL/IDLE.");
            }
        } else if (command.equals("MANUAL_HEAT")) {
            if (manualModeActive) {
                manualOverrideState = HEATING;
                Serial.println("INFO,Manual control: HEATING");
            } else { Serial.println("ERROR,Command only valid in MANUAL mode."); }
        } else if (command.equals("MANUAL_COOL")) {
            if (manualModeActive) {
                manualOverrideState = COOLING;
                Serial.println("INFO,Manual control: COOLING");
            } else { Serial.println("ERROR,Command only valid in MANUAL mode."); }
        } else if (command.equals("MANUAL_IDLE")) {
            if (manualModeActive) {
                manualOverrideState = IDLE;
                Serial.println("INFO,Manual control: IDLE");
            } else { Serial.println("ERROR,Command only valid in MANUAL mode."); }
        } else if (command.equals("GET_STATUS")) {
            // STATUS,mcu_time,currT,setT_min,setT_max,State,Mode,Freq,isEq,eqTimestamp
            Serial.print("STATUS,");
            Serial.print(millis() / 1000.0, 2); // MCU Uptime
            Serial.print(",");
            Serial.print(currentTemperature, 2);
            Serial.print(",");
            Serial.print(setTemperatureMin, 2);
            Serial.print(",");
            Serial.print(setTemperatureMax, 2);
            Serial.print(",");
            ControlState actualState = manualModeActive ? manualOverrideState : currentControlState;
            String stateStr = "IDLE";
            if (actualState == HEATING) stateStr = "HEATING";
            else if (actualState == COOLING) stateStr = "COOLING";
            Serial.print(stateStr);
            Serial.print(",");
            Serial.print(manualModeActive ? "MANUAL" : "AUTO");
            Serial.print(",");
            Serial.print(temperatureReadInterval);
            Serial.print(",");
            Serial.print(isEqualizing ? "TIMING_EQ" : "NOT_TIMING_EQ");
            Serial.print(",");
            Serial.println(setpointChangedTimestamp / 1000.0, 2);
        }
        else {
            Serial.print("ERROR,UNKNOWN_COMMAND: "); Serial.println(command);
        }

        updateControlLogic(); // Re-evaluate control after command
        updateLcdDisplay();   // Update LCD
    }
}
