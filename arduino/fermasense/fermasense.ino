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
void reinitializeDevice(); // <-- New function prototype
void sendStatus(); // <-- New function prototype for sending status

void setup() {
    Serial.begin(115200);

    pinMode(HEAT_PIN, OUTPUT);
    pinMode(COOL_PIN, OUTPUT);
    
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
        // Consider not halting, but trying to reinit later or report error continuously
    } else {
        sensors.setResolution(sensorDeviceAddress, 12);
        sensors.setWaitForConversion(false); // Non-blocking
        sensors.requestTemperaturesByIndex(0); // Initial request
    }
    
    reinitializeDevice(); // Call reinitialize to set initial states

    Serial.println("INFO,FermaSense Ready");
    Serial.println("INFO,Commands: SET_TEMP_RANGE=<min>,<max> | SET_FREQ=<ms> | MODE_AUTO | MODE_MANUAL | MANUAL_HEAT/COOL/IDLE | GET_STATUS | REINIT");
    updateLcdDisplay(); // Initial display update
}

void loop() {
    unsigned long currentTime = millis();

    processSerialCommands();

    if (currentTime - lastTempReadTime >= temperatureReadInterval) {
        readTemperatureSensor(); // This also requests next temperature
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
        
        ControlState actualState = manualModeActive ? manualOverrideState : currentControlState;
        String stateStr = "IDLE";
        if (actualState == HEATING) stateStr = "HEATING";
        else if (actualState == COOLING) stateStr = "COOLING";
        Serial.print(stateStr);
        Serial.print(",");
        Serial.println(manualModeActive ? "MANUAL" : "AUTO");

        checkAndLogEqualization();
    }
}

void reinitializeDevice() {
    Serial.println("INFO,Reinitializing FermaSense device...");
    
    // Reset control variables to defaults
    // setTemperatureMin = 24.0; // Or keep current user settings? For now, keep.
    // setTemperatureMax = 26.0;
    currentControlState = IDLE;
    manualOverrideState = IDLE;
    manualModeActive = false; // Default to AUTO mode after reinit
    
    applyControlState(IDLE); // Ensure TEC is off

    // Re-initialize temperature sensor (optional, if begin() is robust)
    // sensors.begin(); // Might not be necessary if already called in setup
    if (sensors.getAddress(sensorDeviceAddress, 0)) { // Check if sensor is still there
        sensors.setResolution(sensorDeviceAddress, 12);
        sensors.setWaitForConversion(false);
        sensors.requestTemperaturesByIndex(0); // Request a new temperature reading
    } else {
        Serial.println("ERROR,DS18B20_NOT_FOUND_ON_REINIT");
        currentTemperature = -127.0; // Mark temperature as invalid
    }
    
    lastTempReadTime = millis(); // Reset read timer
    setpointChangedTimestamp = millis(); // Reset equalization timer
    isEqualizing = false;

    Serial.println("INFO,Device reinitialized.");
    updateLcdDisplay();
    // sendStatus(); // Optionally send new status immediately
}

void readTemperatureSensor() {
    if (sensors.isConversionComplete()) {
        float tempC = sensors.getTempCByIndex(0);
        if (tempC == DEVICE_DISCONNECTED_C || tempC < -50 || tempC > 120) {
            Serial.println("ERROR,TEMP_SENSOR_READ_FAILED");
            currentTemperature = -127.0; // Indicate error
        } else {
            currentTemperature = tempC;
        }
        // Request next conversion
        sensors.requestTemperaturesByIndex(0); 
    }
    // If conversion is not complete, currentTemperature retains its previous value.
    // This is fine for non-blocking reads.
}

void updateControlLogic() {
    if (currentTemperature == -127.0) { // If temp sensor error
        applyControlState(IDLE); // Go to safe state
        return;
    }

    if (manualModeActive) {
        applyControlState(manualOverrideState);
    } else { // Automatic mode
        if (currentTemperature < setTemperatureMin - TEMP_HYSTERESIS) {
            applyControlState(HEATING);
        } else if (currentTemperature > setTemperatureMax + TEMP_HYSTERESIS) {
            applyControlState(COOLING);
        } else if (currentTemperature >= setTemperatureMin && currentTemperature <= setTemperatureMax) {
             applyControlState(IDLE);
        }
        // If within hysteresis but not yet in range, maintain current state (heating/cooling)
        // This is implicitly handled by only changing state when crossing outer hysteresis bounds
        // or entering the IDLE zone.
    }
}

void applyControlState(ControlState targetState) {
    ControlState stateToApply = targetState; // In auto mode, targetState is currentControlState
                                          // In manual mode, updateControlLogic passes manualOverrideState

    // If in manual mode, the state to apply *is* the manualOverrideState
    if (manualModeActive) {
        stateToApply = manualOverrideState;
    }

    // Only change pins if the new stateToApply is different from what's currently active
    // This requires knowing the *actual current hardware state*, not just currentControlState (which might be auto logic)
    bool needsChange = false;
    if (stateToApply == IDLE && (digitalRead(HEAT_PIN) == HIGH || digitalRead(COOL_PIN) == HIGH)) needsChange = true;
    if (stateToApply == HEATING && digitalRead(HEAT_PIN) == LOW) needsChange = true; // Also ensure cool is off
    if (stateToApply == COOLING && digitalRead(COOL_PIN) == LOW) needsChange = true; // Also ensure heat is off

    if (currentControlState != stateToApply || needsChange) { // Update internal state tracker and pins
        currentControlState = stateToApply; // Update the primary state variable

        switch (stateToApply) {
            case IDLE:
                if (digitalRead(HEAT_PIN) == HIGH || digitalRead(COOL_PIN) == HIGH) Serial.println("INFO,TEC switched to IDLE");
                digitalWrite(HEAT_PIN, LOW);
                digitalWrite(COOL_PIN, LOW);
                break;
            case HEATING:
                if (digitalRead(HEAT_PIN) == LOW || digitalRead(COOL_PIN) == HIGH) Serial.println("INFO,TEC switched to HEATING");
                digitalWrite(COOL_PIN, LOW);
                digitalWrite(HEAT_PIN, HIGH);
                break;
            case COOLING:
                if (digitalRead(COOL_PIN) == LOW || digitalRead(HEAT_PIN) == HIGH) Serial.println("INFO,TEC switched to COOLING");
                digitalWrite(HEAT_PIN, LOW);
                digitalWrite(COOL_PIN, HIGH);
                break;
        }
    }
}


void updateLcdDisplay() {
    lcd.clear();
    // Row 0: Mode and Current State
    lcd.setCursor(0, 0);
    if (manualModeActive) {
        lcd.print("Manual:");
    } else {
        lcd.print("Auto:  "); 
    }

    ControlState displayedState = manualModeActive ? manualOverrideState : currentControlState;
    lcd.setCursor(7, 0); // Position for state text
    switch (displayedState) {
        case IDLE:    lcd.print("Idle   "); break; // Pad with spaces for consistent width
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
    lcd.print(setTemperatureMin, 0); 
    lcd.print("-");
    lcd.print(setTemperatureMax, 0); 
}

void startEqualizationTiming(float oldMin, float oldMax, float newMin, float newMax) {
    bool rangeChangedSignificantly = abs(oldMin - newMin) > 0.05 || abs(oldMax - newMax) > 0.05; // Small tolerance
    bool outsideNewRange = (currentTemperature < newMin - TEMP_HYSTERESIS || currentTemperature > newMax + TEMP_HYSTERESIS);

    if ((rangeChangedSignificantly || outsideNewRange) && currentTemperature != -127.0 && !manualModeActive) {
        setpointChangedTimestamp = millis();
        isEqualizing = true;
        lastSetpointMinBeforeChange = newMin;
        lastSetpointMaxBeforeChange = newMax;
        Serial.print("INFO,Equalization timer started for setpoint range: ");
        Serial.print(newMin, 1); Serial.print("-"); Serial.println(newMax, 1);
    } else {
        isEqualizing = false; 
    }
}

void checkAndLogEqualization() {
    if (isEqualizing && !manualModeActive) { // Only log equalization in AUTO mode
        bool withinTargetRange = (currentTemperature >= lastSetpointMinBeforeChange && currentTemperature <= lastSetpointMaxBeforeChange);
        bool systemSettled = (currentControlState == IDLE); // In auto mode, currentControlState reflects actual state

        if (withinTargetRange && systemSettled && currentTemperature != -127.0) {
            unsigned long equalizationDurationMs = millis() - setpointChangedTimestamp;
            Serial.print("EQUALIZED,");
            Serial.print(lastSetpointMinBeforeChange, 2);
            Serial.print(",");
            Serial.print(lastSetpointMaxBeforeChange, 2);
            Serial.print(",");
            Serial.println(equalizationDurationMs / 1000.0, 2); 
            isEqualizing = false;
        }
    }
}

void sendStatus() {
    // STATUS,mcu_time_s,currT,setT_min,setT_max,State,Mode,Freq_ms,isEq,eq_change_time_s
    Serial.print("STATUS,");
    Serial.print(millis() / 1000.0, 2); 
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
    Serial.println(setpointChangedTimestamp / 1000.0, 2); // Time of last setpoint change or reinit
}


void processSerialCommands() {
    if (Serial.available() > 0) {
        String command = Serial.readStringUntil('\n');
        command.trim();
        Serial.print("CMD_RECV,"); Serial.println(command);

        if (command.startsWith("SET_TEMP_RANGE=")) {
            String params = command.substring(15); 
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
                        startEqualizationTiming(oldMin, oldMax, newSetMin, newSetMax);
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
            if (newFreq >= 1000 && newFreq <= 600000) { // Min 1s, Max 10min
                temperatureReadInterval = newFreq;
                Serial.print("INFO,Temp. read interval set to: "); Serial.print(temperatureReadInterval); Serial.println(" ms");
            } else {
                Serial.println("ERROR,SET_FREQ_OUT_OF_RANGE (1000-600000ms)");
            }
        } else if (command.equals("MODE_AUTO")) {
            if (manualModeActive) {
                manualModeActive = false;
                Serial.println("INFO,Mode changed to AUTO");
                // When switching to AUTO, re-evaluate if equalization timing is needed based on current temp and setpoints
                startEqualizationTiming(setTemperatureMin, setTemperatureMax, setTemperatureMin, setTemperatureMax); 
            }
        } else if (command.equals("MODE_MANUAL")) {
            if (!manualModeActive) {
                manualModeActive = true;
                manualOverrideState = IDLE; // Default to IDLE when switching to manual
                isEqualizing = false; // Stop any equalization timing
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
            sendStatus();
        } else if (command.equals("REINIT")) { // <-- New command handler
            reinitializeDevice();
            sendStatus(); // Send status after reinitialization
        }
        else {
            Serial.print("ERROR,UNKNOWN_COMMAND: "); Serial.println(command);
        }

        // After processing any command that might change state or mode:
        updateControlLogic(); // Re-evaluate control logic
        updateLcdDisplay();   // Update LCD display
    }
}
