#include <OneWire.h>
#include <DallasTemperature.h> // Preferred library for DS18B20
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// --- Pin Definitions ---
#define ONE_WIRE_BUS_PIN 2 // DS18B20 Data Pin
#define HEAT_PIN 3         // Digital pin for Heating (e.g., controls a relay/MOSFET for TEC)
#define COOL_PIN 4         // Digital pin for Cooling (e.g., controls a relay/MOSFET for TEC)
                           // For TEC1-12706:
                           // Heating: HEAT_PIN=HIGH, COOL_PIN=LOW (if polarity is set for this)
                           // Cooling: HEAT_PIN=LOW, COOL_PIN=HIGH (if polarity is set for this)
                           // Idle:    HEAT_PIN=LOW, COOL_PIN=LOW

// --- Temperature Sensor Setup ---
OneWire oneWire(ONE_WIRE_BUS_PIN);
DallasTemperature sensors(&oneWire);
DeviceAddress sensorDeviceAddress; // Stores sensor address

// --- LCD Setup ---
// Note: If your LCD address is different, change 0x27. Common addresses are 0x27 or 0x3F.
LiquidCrystal_I2C lcd(0x27, 16, 2);

// --- Control Variables ---
float currentTemperature = -127.0; // Initial invalid value, DS18B20 returns -127 on error
float setTemperature = 25.0;       // Default desired temperature (Celsius)
const float TEMP_HYSTERESIS = 0.5; // Hysteresis in Celsius to prevent rapid switching
                                   // (e.g., if setTemp is 25, heat below 24.5, cool above 25.5)

// TEC1-12706 Safe Operating Range for Fermentation (adjust as needed)
// These are for the *target fermentation temperature*, not the absolute limits of the TEC.
const float MIN_SETTABLE_TEMP = 4.0;  // Minimum safe settable temperature for product
const float MAX_SETTABLE_TEMP = 50.0; // Maximum safe settable temperature for product

enum ControlState { IDLE, HEATING, COOLING };
ControlState currentControlState = IDLE;
ControlState manualOverrideState = IDLE; // Used when in manual mode
bool manualModeActive = false;

unsigned long lastTempReadTime = 0;
unsigned long temperatureReadInterval = 5000; // Default: check temperature every 5 seconds (ms)

// For recording equalization time
unsigned long setpointChangedTimestamp = 0;
bool isEqualizing = false;
float lastSetpointBeforeChange = 0.0;

// --- Function Prototypes ---
void readTemperatureSensor();
void updateControlLogic();
void applyControlState(ControlState targetState);
void updateLcdDisplay();
void processSerialCommands();
void startEqualizationTiming();
void checkAndLogEqualization();

void setup() {
    Serial.begin(115200); // Use a higher baud rate for faster data transfer

    pinMode(HEAT_PIN, OUTPUT);
    pinMode(COOL_PIN, OUTPUT);
    applyControlState(IDLE); // Start with TEC off

    // Initialize LCD
    lcd.init();
    lcd.backlight();
    lcd.setCursor(0, 0);
    lcd.print("FermaSense Boot");
    delay(1000);

    // Initialize Temperature Sensor
    sensors.begin();
    if (!sensors.getAddress(sensorDeviceAddress, 0)) {
        Serial.println("ERROR,DS18B20_NOT_FOUND");
        lcd.clear();
        lcd.print("Sensor Error!");
        while (true); // Halt execution
    }
    sensors.setResolution(sensorDeviceAddress, 12); // Set resolution (9, 10, 11, or 12 bits)
    sensors.setWaitForConversion(false); // Use non-blocking mode
    sensors.requestTemperaturesByIndex(0); // Initial request
    lastTempReadTime = millis();
    setpointChangedTimestamp = millis(); // Initialize

    Serial.println("INFO,FermaSense Ready");
    Serial.println("INFO,Commands: SET_TEMP=<value>, SET_FREQ=<ms>, MODE_AUTO, MODE_MANUAL, MANUAL_HEAT, MANUAL_COOL, MANUAL_IDLE, GET_STATUS");
    updateLcdDisplay();
}

void loop() {
    unsigned long currentTime = millis();

    // Process any incoming serial commands
    processSerialCommands();

    // Read temperature at the specified interval
    if (currentTime - lastTempReadTime >= temperatureReadInterval) {
        readTemperatureSensor(); // This also requests the next reading
        lastTempReadTime = currentTime;

        // After a new temperature reading, update control logic and LCD
        updateControlLogic();
        updateLcdDisplay();

        // Send data packet to the web dashboard via Serial
        Serial.print("DATA,");
        Serial.print(currentTime / 1000.0, 2); // Timestamp in seconds
        Serial.print(",");
        Serial.print(currentTemperature, 2);
        Serial.print(",");
        Serial.print(setTemperature, 2);
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
    if (sensors.isConversionComplete()) { // Check if conversion is done
        float tempC = sensors.getTempCByIndex(0);
        if (tempC == DEVICE_DISCONNECTED_C || tempC < -50 || tempC > 120) { // Basic validity check
            Serial.println("ERROR,TEMP_SENSOR_READ_FAILED");
            currentTemperature = -127.0; // Indicate error
        } else {
            currentTemperature = tempC;
        }
        sensors.requestTemperaturesByIndex(0); // Request next conversion
    }
    // If not complete, we'll get it on the next cycle where it is complete.
}

void updateControlLogic() {
    if (currentTemperature == -127.0) { // If temperature reading is invalid
        applyControlState(IDLE); // Go to IDLE for safety
        return;
    }

    if (manualModeActive) {
        applyControlState(manualOverrideState);
    } else { // Automatic mode
        if (currentTemperature < setTemperature - TEMP_HYSTERESIS) {
            applyControlState(HEATING);
        } else if (currentTemperature > setTemperature + TEMP_HYSTERESIS) {
            applyControlState(COOLING);
        } else {
            applyControlState(IDLE);
        }
    }
}

void applyControlState(ControlState targetState) {
    if (currentControlState == targetState && !(manualModeActive && targetState != manualOverrideState) ) return; // No change needed unless manual override changes

    currentControlState = targetState;
    switch (currentControlState) {
        case IDLE:
            digitalWrite(HEAT_PIN, LOW);
            digitalWrite(COOL_PIN, LOW);
            break;
        case HEATING:
            digitalWrite(COOL_PIN, LOW); // Ensure cooling is off
            digitalWrite(HEAT_PIN, HIGH);
            break;
        case COOLING:
            digitalWrite(HEAT_PIN, LOW);   // Ensure heating is off
            digitalWrite(COOL_PIN, HIGH);
            break;
    }
}

void updateLcdDisplay() {
    lcd.clear();
    // Row 0: Mode and Current State
    lcd.setCursor(0, 0);
    if (manualModeActive) {
        lcd.print("Manual:");
    } else {
        lcd.print("Auto:");
    }
    lcd.setCursor(7, 0); // Position for state
    switch (currentControlState) {
        case IDLE:    lcd.print("Idle   "); break; // Extra spaces to clear previous text
        case HEATING: lcd.print("Heating"); break;
        case COOLING: lcd.print("Cooling"); break;
    }

    // Row 1: Temperatures
    lcd.setCursor(0, 1);
    lcd.print("T:");
    if (currentTemperature == -127.0) {
        lcd.print("ERR");
    } else {
        lcd.print(currentTemperature, 1);
    }
    lcd.print((char)223); // Degree symbol
    lcd.print("C S:");
    lcd.print(setTemperature, 1);
    lcd.print((char)223);
    lcd.print("C");
}

void startEqualizationTiming() {
    // Start timing if the current temperature is meaningfully different from the new setpoint
    if (abs(currentTemperature - setTemperature) > TEMP_HYSTERESIS && currentTemperature != -127.0) {
        setpointChangedTimestamp = millis();
        isEqualizing = true;
        lastSetpointBeforeChange = setTemperature; // Record what we are trying to achieve
        Serial.print("INFO,Equalization timer started for setpoint: ");
        Serial.println(setTemperature);
    } else {
        isEqualizing = false; // Already at or very close to setpoint
    }
}

void checkAndLogEqualization() {
    if (isEqualizing) {
        // Check if temperature is now within the hysteresis band of the target setpoint
        // and the system has settled (is IDLE in auto mode, or matching manual state)
        bool conditionsMet = (abs(currentTemperature - lastSetpointBeforeChange) <= TEMP_HYSTERESIS);
        bool systemSettled = (!manualModeActive && currentControlState == IDLE) ||
                             (manualModeActive && currentControlState == manualOverrideState && manualOverrideState == IDLE);


        if (conditionsMet && systemSettled && currentTemperature != -127.0) {
            unsigned long equalizationDurationMs = millis() - setpointChangedTimestamp;
            Serial.print("EQUALIZED,");
            Serial.print(lastSetpointBeforeChange, 2); // The setpoint we were aiming for
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

        if (command.startsWith("SET_TEMP=")) {
            float newSetTemp = command.substring(9).toFloat();
            if (newSetTemp >= MIN_SETTABLE_TEMP && newSetTemp <= MAX_SETTABLE_TEMP) {
                if (abs(setTemperature - newSetTemp) > 0.01) { // Check if it's a real change
                    setTemperature = newSetTemp;
                    Serial.print("INFO,Setpoint changed to: "); Serial.println(setTemperature);
                    if (!manualModeActive) { // Only start auto-equalization timer if in auto mode
                        startEqualizationTiming();
                    } else {
                        isEqualizing = false; // If in manual, setpoint change doesn't trigger timed equalization
                    }
                }
            } else {
                Serial.print("ERROR,SET_TEMP_OUT_OF_RANGE (");
                Serial.print(MIN_SETTABLE_TEMP); Serial.print("-"); Serial.print(MAX_SETTABLE_TEMP);
                Serial.println(")");
            }
        } else if (command.startsWith("SET_FREQ=")) {
            long newFreq = command.substring(9).toInt(); // Use long for safety
            if (newFreq >= 1000 && newFreq <= 600000) { // Min 1s, Max 10min
                temperatureReadInterval = newFreq;
                Serial.print("INFO,Temp. read interval set to: "); Serial.print(temperatureReadInterval); Serial.println(" ms");
            } else {
                Serial.println("ERROR,SET_FREQ_OUT_OF_RANGE (1000-600000ms)");
            }
        } else if (command.equals("MODE_AUTO")) {
            if (manualModeActive) { // Only act if changing mode
                manualModeActive = false;
                isEqualizing = false; // Reset equalization state
                startEqualizationTiming(); // See if we need to equalize to current setpoint
                Serial.println("INFO,Mode changed to AUTO");
            }
        } else if (command.equals("MODE_MANUAL")) {
            if (!manualModeActive) { // Only act if changing mode
                manualModeActive = true;
                manualOverrideState = IDLE; // Default to IDLE when entering manual
                isEqualizing = false; // Stop any auto equalization timing
                Serial.println("INFO,Mode changed to MANUAL. System IDLE. Use MANUAL_HEAT/COOL/IDLE.");
            }
        } else if (command.equals("MANUAL_HEAT")) {
            if (manualModeActive) {
                manualOverrideState = HEATING;
                Serial.println("INFO,Manual control: HEATING");
            } else {
                Serial.println("ERROR,Command only valid in MANUAL mode.");
            }
        } else if (command.equals("MANUAL_COOL")) {
            if (manualModeActive) {
                manualOverrideState = COOLING;
                Serial.println("INFO,Manual control: COOLING");
            } else {
                Serial.println("ERROR,Command only valid in MANUAL mode.");
            }
        } else if (command.equals("MANUAL_IDLE")) {
            if (manualModeActive) {
                manualOverrideState = IDLE;
                Serial.println("INFO,Manual control: IDLE");
            } else {
                Serial.println("ERROR,Command only valid in MANUAL mode.");
            }
        } else if (command.equals("GET_STATUS")) {
            Serial.print("STATUS,");
            Serial.print(millis() / 1000.0, 2);
            Serial.print(",");
            Serial.print(currentTemperature, 2);
            Serial.print(",");
            Serial.print(setTemperature, 2);
            Serial.print(",");
            String stateStr = "IDLE";
            if (currentControlState == HEATING) stateStr = "HEATING";
            else if (currentControlState == COOLING) stateStr = "COOLING";
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

        // Immediately update logic and display after a command that might change state
        updateControlLogic();
        updateLcdDisplay();
    }
}