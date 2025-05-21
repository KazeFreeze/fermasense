from flask import Flask, render_template, request, jsonify, send_file
from flask_socketio import SocketIO, emit
import serial
import serial.tools.list_ports
import threading
import time
import csv
import os
from datetime import datetime
import sys
import json

# --- PyInstaller Workaround for async_mode 'threading' ---
if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    try:
        import engineio.async_drivers.threading
    except ImportError:
        print("DEBUG: Could not import engineio.async_drivers.threading for PyInstaller.")
        pass

# --- Configuration ---
SERIAL_PORT = None
BAUD_RATE = 115200
DATA_DIR = "data"
MAIN_LOG_FILE = os.path.join(DATA_DIR, "fermentation_log.csv")
EQ_LOG_FILE = os.path.join(DATA_DIR, "equalization_log.csv")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
COMMAND_SEND_DELAY = 0.1 # Seconds to wait after sending a command

# --- Flask App Setup ---
app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["SECRET_KEY"] = "fermasense_secret_!@#_v2"
socketio = SocketIO(app, async_mode="threading")
ser = None # Global serial object
serial_lock = threading.Lock() # To protect serial operations (opening, closing, writing)
shutdown_event = threading.Event()

# --- Helper Functions ---
def ensure_dir_exists(directory):
    if not os.path.exists(directory):
        print(f"DEBUG: Creating directory: {directory}")
        os.makedirs(directory)

def get_available_serial_ports():
    ports = serial.tools.list_ports.comports()
    port_devices = [port.device for port in ports]
    print(f"DEBUG: Available serial ports: {port_devices}")
    return port_devices

def load_config():
    global SERIAL_PORT
    ensure_dir_exists(DATA_DIR)
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r") as f:
                config = json.load(f)
                SERIAL_PORT = config.get("serial_port", None)
                print(f"DEBUG: Loaded serial port from config: {SERIAL_PORT}")
        except Exception as e:
            print(f"ERROR: Error loading config: {e}")
            SERIAL_PORT = None
    else:
        print("DEBUG: No config file found. Attempting auto-detection.")
        ports = get_available_serial_ports()
        if ports:
            SERIAL_PORT = ports[0]
            print(f"DEBUG: No config file, auto-selected serial port: {SERIAL_PORT}")
            save_config()
        else:
            SERIAL_PORT = None
            print("DEBUG: No config file and no serial ports detected on startup.")

def save_config():
    ensure_dir_exists(DATA_DIR)
    try:
        with open(CONFIG_FILE, "w") as f:
            json.dump({"serial_port": SERIAL_PORT}, f)
        print(f"DEBUG: Saved serial port to config: {SERIAL_PORT}")
    except Exception as e:
        print(f"ERROR: Error saving config: {e}")

def log_to_csv(file_path, data_dict, fieldnames):
    ensure_dir_exists(DATA_DIR)
    file_exists = os.path.isfile(file_path)
    try:
        with open(file_path, "a", newline="", encoding="utf-8") as csvfile:
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            # Write header if the file is new OR if it exists but is empty
            if not (file_exists and os.path.getsize(file_path) > 0):
                writer.writeheader()
            writer.writerow(data_dict)
    except IOError as e:
        print(f"ERROR: Error writing to CSV {file_path}: {e}")
        socketio.emit("mcu_log", {"type": "error", "message": f"CSV Write Error: {e}"})

# --- Serial Communication Thread ---
def serial_reader_thread():
    global ser, SERIAL_PORT
    print("INFO: Serial reader thread started.")

    connection_attempt_interval = 5 # seconds
    last_connection_status_update = 0

    while not shutdown_event.is_set():
        if not SERIAL_PORT:
            if time.time() - last_connection_status_update > 10:
                socketio.emit("mcu_log", {"type": "error", "message": "Serial port not configured. Please select one."})
                socketio.emit("serial_port_status", {"status": "error", "message": "Not configured", "port": None})
                last_connection_status_update = time.time()
            time.sleep(connection_attempt_interval)
            continue

        if ser is None or not ser.is_open:
            with serial_lock:
                if ser is not None and ser.is_open: # Double check
                    pass
                else:
                    if ser is not None:
                        try:
                            ser.close()
                            print(f"DEBUG: Closed existing non-open serial port object for {SERIAL_PORT}.")
                        except Exception as e_close:
                            print(f"ERROR: Error trying to close non-open serial port {SERIAL_PORT}: {e_close}")
                        ser = None

                    try:
                        print(f"INFO: Attempting to connect to serial port: {SERIAL_PORT} at {BAUD_RATE} baud")
                        if not SERIAL_PORT: # Guard against empty port name
                            print(f"ERROR: Serial port name is empty or None. Cannot connect.")
                            raise serial.SerialException("Serial port name is empty or None.")
                        ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
                        print(f"INFO: Successfully connected to {SERIAL_PORT}.")
                        socketio.emit("mcu_log", {"type": "success", "message": f"Connected to FermaSense on {SERIAL_PORT}"})
                        socketio.emit("serial_port_status", {"status": "success", "message": f"Connected to {SERIAL_PORT}", "port": SERIAL_PORT})
                        send_command_to_mcu("GET_STATUS") # Send GET_STATUS after successful connection
                        last_connection_status_update = time.time()
                    except serial.SerialException as e:
                        ser = None
                        print(f"ERROR: Serial connection error on {SERIAL_PORT}: {e}")
                        socketio.emit("mcu_log", {"type": "error", "message": f"Serial connection to {SERIAL_PORT} failed: {e}. Retrying..."})
                        socketio.emit("serial_port_status", {"status": "error", "message": f"Failed: {e}", "port": SERIAL_PORT})
                        last_connection_status_update = time.time()
                    except Exception as e_generic:
                        ser = None
                        print(f"ERROR: Generic error during serial connection attempt on {SERIAL_PORT}: {e_generic}")
                        socketio.emit("mcu_log", {"type": "error", "message": f"Unexpected error connecting to {SERIAL_PORT}: {e_generic}. Retrying..."})
                        last_connection_status_update = time.time()

            if ser is None or not ser.is_open:
                time.sleep(connection_attempt_interval)
                continue

        try:
            if ser.in_waiting > 0:
                line_bytes = ser.readline()
                line = line_bytes.decode("utf-8", errors="ignore").strip()
                print(f"DEBUG: MCU RAW >> {line}")
                if line:
                    timestamp_iso = datetime.now().isoformat()
                    parts = line.split(",")

                    if parts[0] == "DATA" and len(parts) == 7:
                        try:
                            payload = {
                                "server_time_iso": timestamp_iso,
                                "mcu_time_s": float(parts[1]),
                                "current_temp": float(parts[2]),
                                "set_temp_min": float(parts[3]),
                                "set_temp_max": float(parts[4]),
                                "state": parts[5],
                                "mode": parts[6],
                            }
                            socketio.emit("new_data", payload)
                            log_to_csv(MAIN_LOG_FILE, payload, ["server_time_iso", "mcu_time_s", "current_temp", "set_temp_min", "set_temp_max", "state", "mode"])
                        except ValueError as e:
                            print(f"ERROR: Parsing DATA line: {line} - {e}")
                            socketio.emit("mcu_log", {"type": "error", "message": f"Data parse error: {line}"})
                    elif parts[0] == "EQUALIZED" and len(parts) == 4:
                        try:
                            eq_chart_event = {
                                "server_time_iso": timestamp_iso,
                                "target_temp": float(parts[1]), # This is target_temp_min from Arduino
                                "duration_s": float(parts[3]),
                            }
                            socketio.emit("equalization_update", eq_chart_event)
                            log_to_csv(EQ_LOG_FILE, eq_chart_event, ["server_time_iso", "target_temp", "duration_s"])
                            socketio.emit("mcu_log", {"type": "info", "message": f"Equalized to {parts[1]}-{parts[2]}°C in {parts[3]}s"})
                        except ValueError as e:
                            print(f"ERROR: Parsing EQUALIZED line: {line} - {e}")
                            socketio.emit("mcu_log", {"type": "error", "message": f"Equalization parse error: {line}"})
                    elif parts[0] == "STATUS" and len(parts) >= 10: # Ensure enough parts for all fields
                        try:
                            status_payload = {
                                "mcu_time_s": float(parts[1]),
                                "current_temp": float(parts[2]),
                                "set_temp_min": float(parts[3]),
                                "set_temp_max": float(parts[4]),
                                "state": parts[5],
                                "mode": parts[6],
                                "frequency_ms": int(parts[7]),
                                "is_equalizing": parts[8] == "TIMING_EQ",
                                "setpoint_change_time_s": float(parts[9]),
                            }
                            socketio.emit("initial_status", status_payload)
                        except Exception as e:
                            message = f"Error parsing STATUS: {e} (Line: {line})"
                            print(f"ERROR: {message}")
                            socketio.emit("mcu_log", {"type": "error", "message": message})
                    elif parts[0] in ["INFO", "ERROR", "CMD_RECV", "WARN"]:
                        log_type = parts[0].lower()
                        socketio.emit("mcu_log", {"type": log_type, "message": line})
                    else:
                        socketio.emit("mcu_log", {"type": "unknown", "message": f"MCU_UNKNOWN: {line}"})
            else:
                time.sleep(0.05)
        except serial.SerialException as e:
            print(f"ERROR: Serial communication error during read on {SERIAL_PORT}: {e}")
            socketio.emit("mcu_log", {"type": "error", "message": f"Serial Port Error: {e}. Connection lost."})
            socketio.emit("serial_port_status", {"status": "error", "message": f"Disconnected: {e}", "port": SERIAL_PORT})
            with serial_lock:
                if ser:
                    try:
                        ser.close()
                    except Exception as e_close:
                        print(f"ERROR: Error closing serial port on read error: {e_close}")
                ser = None
            last_connection_status_update = time.time()
            time.sleep(connection_attempt_interval / 2)
        except Exception as e: # Catch other unexpected errors during read loop
            print(f"ERROR: Unexpected error in serial_reader_thread loop: {e.__class__.__name__}: {e}")
            socketio.emit("mcu_log", {"type": "error", "message": f"Backend processing error: {e}"})
            time.sleep(1)

    print("INFO: Serial reader thread stopping...")
    with serial_lock:
        if ser and ser.is_open:
            try:
                ser.close()
                print("INFO: Serial port closed by shutdown.")
            except Exception as e_close_shutdown:
                print(f"ERROR: Error closing serial port during shutdown: {e_close_shutdown}")
        ser = None
    print("INFO: Serial reader thread stopped.")


# --- Flask Routes ---
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/send_command_to_mcu", methods=["POST"])
def send_command_route():
    command_str = request.form.get("command")
    if not command_str:
        return jsonify({"status": "error", "message": "No command provided."}), 400

    if send_command_to_mcu(command_str):
        return jsonify({"status": "success", "message": f'Command "{command_str}" sent.'})
    else:
        return jsonify({"status": "error", "message": "Failed to send command. MCU not connected or error."}), 500

def send_command_to_mcu(command_string):
    global ser
    print(f"DEBUG: send_command_to_mcu CALLED with command: {command_string}")
    acquired_lock = False
    success = False 
    try:
        print(f"DEBUG: send_command_to_mcu '{command_string}' attempting to acquire serial_lock...")
        acquired_lock = serial_lock.acquire(timeout=2) 
        if not acquired_lock:
            print(f"ERROR: send_command_to_mcu '{command_string}' FAILED to acquire serial_lock within 2s timeout.")
            socketio.emit("mcu_log", {"type": "error", "message": f"Internal server error: Lock timeout sending {command_string}"})
            return False

        print(f"DEBUG: send_command_to_mcu '{command_string}' acquired serial_lock.")

        if ser and ser.is_open:
            print(f"DEBUG: send_command_to_mcu '{command_string}' - ser object exists and is_open (Port: {ser.port}).")
            try:
                ser.write((command_string + "\n").encode("utf-8"))
                print(f"INFO: Successfully sent to MCU: {command_string}")
                socketio.emit("mcu_log", {"type": "cmd_sent", "message": f"CMD > {command_string}"})
                success = True
                return True
            except serial.SerialException as e:
                print(f"ERROR: SerialException while writing to MCU '{command_string}': {e}")
                socketio.emit("mcu_log", {"type": "error", "message": f"Error sending command (SerialException): {e}"})
                return False
            except Exception as e:
                print(f"ERROR: Generic error writing to MCU '{command_string}': {e}")
                socketio.emit("mcu_log", {"type": "error", "message": f"Error sending command (Exception): {e}"})
                return False
        else:
            if ser:
                 print(f"ERROR: Cannot send command '{command_string}'. Serial port {ser.port} exists but is NOT OPEN.")
            else:
                 print(f"ERROR: Cannot send command '{command_string}'. Serial port object (ser) is None.")
            socketio.emit("mcu_log", {"type": "error", "message": "Cannot send command: Serial port unavailable."})
            return False
    finally:
        if acquired_lock:
            serial_lock.release()
            print(f"DEBUG: send_command_to_mcu '{command_string}' released serial_lock.")
        if success: 
            time.sleep(COMMAND_SEND_DELAY)


@app.route("/get_historical_data", methods=["GET"])
def get_historical_data_route():
    try:
        ensure_dir_exists(DATA_DIR)
        data_points = []
        if os.path.exists(MAIN_LOG_FILE):
            # Check if file is empty, if so, return empty list to avoid DictReader error on empty file
            if os.path.getsize(MAIN_LOG_FILE) == 0:
                return jsonify(data_points)
                
            with open(MAIN_LOG_FILE, "r", newline="", encoding="utf-8") as csvfile:
                reader = csv.DictReader(csvfile)
                # Basic check for expected fieldnames if reader.fieldnames is not None
                expected_main_fieldnames = ["server_time_iso", "mcu_time_s", "current_temp", "set_temp_min", "set_temp_max", "state", "mode"]
                if reader.fieldnames is None or not all(f in reader.fieldnames for f in expected_main_fieldnames[:3]): # Check a few core fields
                    print(f"WARNING: Main log CSV ({MAIN_LOG_FILE}) header mismatch or missing. Fields: {reader.fieldnames}")
                    # Potentially return empty or log an error to frontend
                    return jsonify(data_points) # Return empty if headers are bad

                for row in reader:
                    try:
                        dt_obj = datetime.fromisoformat(row["server_time_iso"])
                        data_points.append({
                            "x": dt_obj.timestamp() * 1000,
                            "current_temp": float(row["current_temp"]),
                            "set_temp_min": float(row["set_temp_min"]),
                            "set_temp_max": float(row["set_temp_max"]),
                        })
                    except (ValueError, KeyError) as e:
                        print(f"DEBUG: Skipping malformed row in main CSV: {row} - {e}")
        return jsonify(data_points)
    except Exception as e:
        print(f"ERROR: Error reading historical data: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/get_equalization_log", methods=["GET"])
def get_equalization_log_route():
    try:
        ensure_dir_exists(DATA_DIR)
        eq_events = []
        if os.path.exists(EQ_LOG_FILE):
            # Check if file is empty
            if os.path.getsize(EQ_LOG_FILE) == 0:
                return jsonify(eq_events)

            with open(EQ_LOG_FILE, "r", newline="", encoding="utf-8") as csvfile:
                reader = csv.DictReader(csvfile)
                expected_eq_fieldnames = ["server_time_iso", "target_temp", "duration_s"]
                if reader.fieldnames is None or not all(f in reader.fieldnames for f in expected_eq_fieldnames):
                    print(f"WARNING: Equalization log CSV ({EQ_LOG_FILE}) header mismatch or missing. Fields: {reader.fieldnames}")
                    return jsonify(eq_events)

                for row in reader:
                    try:
                        eq_events.append({
                            "server_time_iso": row["server_time_iso"],
                            "target_temp": float(row["target_temp"]),
                            "duration_s": float(row["duration_s"]),
                        })
                    except (ValueError, KeyError) as e:
                        print(f"DEBUG: Skipping malformed row in equalization CSV: {row} - {e}")
        return jsonify(eq_events)
    except Exception as e:
        print(f"ERROR: Error reading equalization log: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/download_log/<log_type>")
def download_log_route(log_type):
    ensure_dir_exists(DATA_DIR)
    file_path = ""
    download_name = ""
    if log_type == "main":
        file_path = MAIN_LOG_FILE
        download_name = "fermasense_main_log.csv"
    elif log_type == "equalization":
        file_path = EQ_LOG_FILE
        download_name = "fermasense_equalization_log.csv"
    else:
        return "Invalid log type", 404

    if os.path.exists(file_path):
        return send_file(file_path, as_attachment=True, download_name=download_name, mimetype="text/csv")
    else:
        socketio.emit("mcu_log", {"type": "error", "message": f"{log_type.capitalize()} log file not found."})
        return f"{log_type.capitalize()} log file not found.", 404

# --- SocketIO Events ---
@socketio.on("connect")
def on_connect():
    client_sid = request.sid
    print(f"INFO: Web client connected: {client_sid}")
    emit("mcu_log", {"type": "info", "message": "Web client connected. Initializing..."})

    print(f"DEBUG: on_connect for SID {client_sid} - Checking ser status before GET_STATUS.")
    if ser and ser.is_open:
         print(f"DEBUG: on_connect for SID {client_sid} - ser is open (Port: {ser.port}), calling send_command_to_mcu('GET_STATUS').")
         send_command_to_mcu("GET_STATUS")
    else:
        if not ser:
            print(f"DEBUG: on_connect for SID {client_sid} - ser is None. Not sending GET_STATUS from on_connect.")
        elif not ser.is_open: 
            print(f"DEBUG: on_connect for SID {client_sid} - ser is not open (Port: {ser.port if hasattr(ser, 'port') else 'N/A'}). Not sending GET_STATUS from on_connect.")

    emit("available_serial_ports", get_available_serial_ports())

    if SERIAL_PORT:
        current_port_status = "unknown"
        current_port_message = f"Port {SERIAL_PORT} selected."
        if ser and ser.is_open:
            current_port_status = "success"
            current_port_message = f"Currently connected to {SERIAL_PORT}"
        elif ser is None :
            current_port_status = "info" 
            current_port_message = f"Attempting to connect to {SERIAL_PORT}..."
        else: 
            current_port_status = "error"
            current_port_message = f"Port {SERIAL_PORT} selected, but not connected (ser exists but not open)."
        emit("serial_port_status", {"status": current_port_status, "message": current_port_message, "port": SERIAL_PORT})
    else:
        emit("serial_port_status", {"status": "error", "message": "No serial port configured.", "port": None})


@socketio.on("disconnect")
def on_disconnect():
    client_sid = request.sid
    print(f"INFO: Web client disconnected: {client_sid}")

@socketio.on("request_serial_ports")
def handle_request_serial_ports():
    print("DEBUG: Received request_serial_ports event.")
    emit("available_serial_ports", get_available_serial_ports())

@socketio.on("set_serial_port")
def handle_set_serial_port(data):
    global SERIAL_PORT, ser
    new_port_selection = data.get("port")
    print(f"DEBUG: Received set_serial_port event with port: {new_port_selection}")

    with serial_lock:
        previous_port = SERIAL_PORT

        if new_port_selection == "":
            ports = get_available_serial_ports()
            SERIAL_PORT = ports[0] if ports else None
            message = f"Auto-detecting. Selected: {SERIAL_PORT}" if SERIAL_PORT else "Auto-detect: No ports found."
        else:
            SERIAL_PORT = new_port_selection
            message = f"Serial port explicitly set to: {SERIAL_PORT}"

        print(f"INFO: {message}")
        socketio.emit("mcu_log", {"type": "info", "message": message})

        needs_reset = False
        if SERIAL_PORT != previous_port:
            needs_reset = True
        elif SERIAL_PORT is not None and (ser is None or (hasattr(ser, 'port') and ser.port != SERIAL_PORT)):
            needs_reset = True

        if needs_reset:
            print(f"DEBUG: Port change or need for reset detected. Old: {previous_port}, New: {SERIAL_PORT}. Resetting serial connection.")
            if ser and ser.is_open:
                print(f"DEBUG: Closing current serial connection to {ser.port if hasattr(ser, 'port') else 'N/A'} due to port change/reset.")
                try:
                    ser.close()
                except Exception as e_close:
                    print(f"ERROR: Error closing serial port {ser.port if hasattr(ser, 'port') else 'N/A'} during port change: {e_close}")
            ser = None 

        save_config()

        if SERIAL_PORT:
            if ser and ser.is_open and ser.port == SERIAL_PORT:
                 emit("serial_port_status", {"status": "success", "message": f"Connected to {SERIAL_PORT}", "port": SERIAL_PORT})
            else:
                 emit("serial_port_status", {"status": "info", "message": f"Attempting to use {SERIAL_PORT}", "port": SERIAL_PORT})
        else: 
            emit("serial_port_status", {"status": "error", "message": "No port selected/available", "port": None})


if __name__ == "__main__":
    ensure_dir_exists(DATA_DIR)
    load_config()

    serial_thread = threading.Thread(target=serial_reader_thread, daemon=True)
    serial_thread.start()

    print(f"INFO: Starting FermaSense Web Dashboard on http://localhost:5000")
    try:
        socketio.run(app, host="0.0.0.0", port=5000, debug=False, allow_unsafe_werkzeug=True)
    finally:
        print("INFO: Shutting down FermaSense server...")
        shutdown_event.set()
        if serial_thread.is_alive():
            print("INFO: Waiting for serial_reader_thread to finish...")
            serial_thread.join(timeout=5)
            if serial_thread.is_alive():
                print("WARNING: Serial reader thread did not finish in time.")
            else:
                print("INFO: Serial reader thread finished.")
        print("INFO: Shutdown complete.")

