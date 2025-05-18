#include <OneWire.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

#define ONE_WIRE_BUS 2  // Pin where DS18B20 is connected

OneWire ds(ONE_WIRE_BUS); // temp sensor
LiquidCrystal_I2C lcd(0x27, 16, 2); //LCD with i2c

void setup() {
  Serial.begin(19200);
  pinMode(3, OUTPUT);
  pinMode(4, OUTPUT);
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Mode: ");
  lcd.setCursor(0, 1);
  lcd.print("Temp: ");
}

void loop() {
  byte data[9];
  byte addr[8];
  float setTemp=40;

  if (!ds.search(addr)) {
    ds.reset_search();
    delay(250);
    return;
  }

  if (OneWire::crc8(addr, 7) != addr[7]) {
    Serial.println("CRC is not valid!");
    return;
  }

  if (addr[0] != 0x28) {
    Serial.println("Not a DS18B20 sensor.");
    return;
  }

  ds.reset();
  ds.select(addr);
  ds.write(0x44, 1);  // Start temperature conversion (with parasite power on)

  delay(750);  // Wait for conversion (750ms is max for 12-bit)

  ds.reset();
  ds.select(addr);
  ds.write(0xBE);  // Read scratchpad

  for (int i = 0; i < 9; i++) {
    data[i] = ds.read();
  }

  int16_t rawTemp = (data[1] << 8) | data[0];
  float celsius = (float)rawTemp / 16.0;
  
  if (celsius<setTemp-0.5){ // lagyan nalnag natin error
    digitalWrite(3,HIGH); 
    digitalWrite(4,LOW); 
    lcd.setCursor(6, 0);
    lcd.print("Heat");
  }
  else if (celsius>setTemp+0.5){ // lagyan nalnag natin error
    digitalWrite(3,LOW);
    digitalWrite(4,HIGH); 
    lcd.setCursor(6, 0);
    lcd.print("Cool");
  }
  else{
    digitalWrite(3,LOW);
    digitalWrite(4,LOW); 
    lcd.setCursor(6, 0);
    lcd.print("Idle");
  }


  Serial.print("Temperature: ");
  Serial.print(celsius);
  Serial.println(" °C");
  lcd.setCursor(6, 1);
  lcd.print(celsius, 1);
  lcd.setCursor (11, 1);
  lcd.print(" °C");


  delay(2000);  // Wait 2 seconds
}
