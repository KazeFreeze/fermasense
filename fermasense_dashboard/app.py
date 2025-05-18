from flask import Flask, render_template, request, jsonify, send_file
from flask_socketio import SocketIO, emit
import serial
import serial.tools.list_ports
import threading
import time
import csv
import os
from datetime import datetime
import sys  # Added for PyInstaller check

# --- PyInstaller Workaround for async_mode 'threading' ---
# When bundled by PyInstaller, python-engineio might not find its async drivers.
# Explicitly importing the 'threading' driver can help.
if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    # print("Running in a PyInstaller bundle, attempting to load threading async_driver.")
    try:
        import engineio.async_drivers.threading
    except ImportError:
        # print("Could not import engineio.async_drivers.threading")
        pass  # If it still fails, the original error will likely persist.

# --- Configuration ---
SERIAL_PORT = None  # Will be set by user or auto-detected
BAUD_RATE = 115200
DATA_DIR = "data"
MAIN_LOG_FILE = os.path.join(DATA_DIR, "fermentation_log.csv")
EQ_LOG_FILE = os.path.join(DATA_DIR, "equalization_log.csv")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")  # For saving selected port

# --- Flask App Setup ---
app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["SECRET_KEY"] = "fermasense_secret_!@#_v2"  # CHANGE THIS FOR PRODUCTION
socketio = SocketIO(
    app, async_mode="threading"
)  # This should now work better when bundled
ser = None  # Global serial object
serial_lock = threading.Lock()  # To protect serial operations
shutdown_event = threading.Event()


# --- Helper Functions ---
def ensure_dir_exists(directory):
    if not os.path.exists(directory):
        os.makedirs(directory)


def get_available_serial_ports():
    ports = serial.tools.list_ports.comports()
    return [port.device for port in ports]


def load_config():
    global SERIAL_PORT
    ensure_dir_exists(DATA_DIR)
    if os.path.exists(CONFIG_FILE):
        try:
            import json

            with open(CONFIG_FILE, "r") as f:
                config = json.load(f)
                SERIAL_PORT = config.get("serial_port", None)
                print(f"Loaded serial port from config: {SERIAL_PORT}")
        except Exception as e:
            print(f"Error loading config: {e}")
            SERIAL_PORT = None
    else:  # Try auto-detect if no config
        ports = get_available_serial_ports()
        if ports:
            SERIAL_PORT = ports[0]  # Default to first available
            print(f"No config file, auto-selected serial port: {SERIAL_PORT}")
            save_config()  # Save the auto-selected one
        else:
            SERIAL_PORT = None
            print("No config file and no serial ports detected on startup.")


def save_config():
    ensure_dir_exists(DATA_DIR)
    try:
        import json

        with open(CONFIG_FILE, "w") as f:
            json.dump({"serial_port": SERIAL_PORT}, f)
        print(f"Saved serial port to config: {SERIAL_PORT}")
    except Exception as e:
        print(f"Error saving config: {e}")


def log_to_csv(file_path, data_dict, fieldnames):
    ensure_dir_exists(DATA_DIR)
    file_exists = os.path.isfile(file_path)
    try:
        with open(file_path, "a", newline="", encoding="utf-8") as csvfile:
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            if not file_exists:
                writer.writeheader()
            writer.writerow(data_dict)
    except IOError as e:
        print(f"Error writing to CSV {file_path}: {e}")
        socketio.emit("mcu_log", {"type": "error", "message": f"CSV Write Error: {e}"})


# --- Serial Communication Thread ---
def serial_reader_thread():
    global ser, SERIAL_PORT
    print("Serial reader thread started.")

    while not shutdown_event.is_set():
        if not SERIAL_PORT:
            # print("Serial port not configured. Waiting for selection.")
            socketio.emit(
                "mcu_log",
                {
                    "type": "error",
                    "message": "Serial port not configured. Please select one in Configuration.",
                },
            )
            socketio.emit(
                "serial_port_status",
                {"status": "error", "message": "Not configured", "port": None},
            )
            time.sleep(5)
            continue

        if ser is None or not ser.is_open:
            with serial_lock:  # Ensure exclusive access for opening
                if ser is not None and ser.is_open:  # Check again inside lock
                    pass
                else:
                    try:
                        print(
                            f"Attempting to connect to serial port: {SERIAL_PORT} at {BAUD_RATE} baud"
                        )
                        ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
                        print(f"Successfully connected to {SERIAL_PORT}.")
                        socketio.emit(
                            "mcu_log",
                            {
                                "type": "success",
                                "message": f"Connected to FermaSense on {SERIAL_PORT}",
                            },
                        )
                        socketio.emit(
                            "serial_port_status",
                            {
                                "status": "success",
                                "message": f"Connected to {SERIAL_PORT}",
                                "port": SERIAL_PORT,
                            },
                        )
                        send_command_to_mcu("GET_STATUS")  # Get initial status
                    except serial.SerialException as e:
                        ser = None
                        print(f"Serial connection error on {SERIAL_PORT}: {e}")
                        socketio.emit(
                            "mcu_log",
                            {
                                "type": "error",
                                "message": f"Serial connection to {SERIAL_PORT} failed: {e}. Retrying...",
                            },
                        )
                        socketio.emit(
                            "serial_port_status",
                            {
                                "status": "error",
                                "message": f"Failed: {e}",
                                "port": SERIAL_PORT,
                            },
                        )
                        time.sleep(5)
                        continue  # Retry connection
        try:
            if ser and ser.is_open and ser.in_waiting > 0:
                line = ser.readline().decode("utf-8", errors="ignore").strip()
                if line:
                    # print(f"MCU Raw: {line}") # For debugging
                    timestamp_iso = datetime.now().isoformat()
                    parts = line.split(",")

                    # Expected DATA: DATA,Timestamp_s,CurrentTemp,SetTempMin,SetTempMax,State,Mode
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
                            log_to_csv(
                                MAIN_LOG_FILE,
                                payload,
                                [
                                    "server_time_iso",
                                    "mcu_time_s",
                                    "current_temp",
                                    "set_temp_min",
                                    "set_temp_max",
                                    "state",
                                    "mode",
                                ],
                            )
                        except ValueError as e:
                            print(f"Error parsing DATA line: {line} - {e}")
                            socketio.emit(
                                "mcu_log",
                                {
                                    "type": "error",
                                    "message": f"Data parse error: {line}",
                                },
                            )

                    # Expected EQUALIZED: EQUALIZED,TargetTempMin,TargetTempMax,Duration_s
                    elif parts[0] == "EQUALIZED" and len(parts) == 4:
                        try:
                            eq_payload = {
                                "server_time_iso": timestamp_iso,
                                "target_temp_min": float(
                                    parts[1]
                                ),  # Assuming this is the target it was equalizing to
                                "target_temp_max": float(parts[2]),  # For context
                                "duration_s": float(parts[3]),
                            }
                            # For chart, we might just use the midpoint or min of the target range
                            eq_chart_event = {
                                "server_time_iso": timestamp_iso,
                                "target_temp": float(
                                    parts[1]
                                ),  # Using min as the representative target
                                "duration_s": float(parts[3]),
                            }
                            socketio.emit("equalization_update", eq_chart_event)
                            log_to_csv(
                                EQ_LOG_FILE,
                                eq_chart_event,
                                ["server_time_iso", "target_temp", "duration_s"],
                            )
                            socketio.emit(
                                "mcu_log",
                                {
                                    "type": "info",
                                    "message": f"Equalized to {parts[1]}-{parts[2]}°C in {parts[3]}s",
                                },
                            )
                        except ValueError as e:
                            print(f"Error parsing EQUALIZED line: {line} - {e}")
                            socketio.emit(
                                "mcu_log",
                                {
                                    "type": "error",
                                    "message": f"Equalization parse error: {line}",
                                },
                            )

                    # Expected STATUS: STATUS,mcu_time,currT,setT_min,setT_max,State,Mode,Freq,isEq,eqTimestamp
                    elif parts[0] == "STATUS" and len(parts) >= 10:
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
                            message = f"Status: Temp {parts[2]}C, Target {parts[3]}-{parts[4]}C, Mode {parts[6]}"
                            socketio.emit(
                                "mcu_log", {"type": "info", "message": message}
                            )
                        except Exception as e:
                            message = f"Error parsing STATUS: {e} (Line: {line})"
                            socketio.emit(
                                "mcu_log", {"type": "error", "message": message}
                            )

                    elif parts[0] in ["INFO", "ERROR", "CMD_RECV", "WARN"]:
                        log_type = "info"
                        if parts[0] == "ERROR":
                            log_type = "error"
                        elif parts[0] == "WARN":
                            log_type = "warn"
                        elif parts[0] == "CMD_RECV":
                            log_type = "cmd_recv"

                        message = ",".join(parts[1:]) if len(parts) > 1 else parts[0]
                        full_message = f"{parts[0]}: {message}"
                        socketio.emit(
                            "mcu_log", {"type": log_type, "message": full_message}
                        )
                    else:
                        socketio.emit(
                            "mcu_log",
                            {"type": "unknown", "message": f"MCU_UNKNOWN: {line}"},
                        )
            else:
                time.sleep(0.05)  # Small sleep if no data, to prevent busy loop

        except serial.SerialException as e:
            print(f"Serial communication error: {e}")
            socketio.emit(
                "mcu_log",
                {
                    "type": "error",
                    "message": f"Serial Port Error: {e}. Connection lost.",
                },
            )
            socketio.emit(
                "serial_port_status",
                {
                    "status": "error",
                    "message": f"Disconnected: {e}",
                    "port": SERIAL_PORT,
                },
            )
            with serial_lock:
                if ser:
                    ser.close()
                ser = None  # Trigger reconnection attempt
            time.sleep(5)
        except Exception as e:
            print(f"Unexpected error in serial_reader_thread: {e}")
            socketio.emit(
                "mcu_log", {"type": "error", "message": f"Backend error: {e}"}
            )
            time.sleep(1)

    print("Serial reader thread stopped.")
    with serial_lock:
        if ser and ser.is_open:
            ser.close()
            print("Serial port closed.")


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
        return jsonify(
            {"status": "success", "message": f'Command "{command_str}" sent.'}
        )
    else:
        return (
            jsonify(
                {
                    "status": "error",
                    "message": "Failed to send command. MCU not connected or error.",
                }
            ),
            500,
        )


def send_command_to_mcu(command_string):
    global ser
    if ser and ser.is_open:
        with serial_lock:  # Ensure serial access is synchronized
            try:
                ser.write((command_string + "\n").encode("utf-8"))
                print(f"Sent to MCU: {command_string}")
                socketio.emit(
                    "mcu_log",
                    {"type": "cmd_sent", "message": f"CMD > {command_string}"},
                )
                return True
            except Exception as e:
                print(f"Error writing to serial port: {e}")
                socketio.emit(
                    "mcu_log",
                    {"type": "error", "message": f"Error sending command: {e}"},
                )
                return False
    else:
        print("Serial port not available or not open for sending command.")
        socketio.emit(
            "mcu_log",
            {
                "type": "error",
                "message": "Cannot send command: Serial port unavailable.",
            },
        )
        return False


@app.route("/get_historical_data", methods=["GET"])
def get_historical_data_route():
    try:
        ensure_dir_exists(DATA_DIR)
        data_points = []
        if os.path.exists(MAIN_LOG_FILE):
            with open(MAIN_LOG_FILE, "r", newline="", encoding="utf-8") as csvfile:
                reader = csv.DictReader(csvfile)
                # Fieldnames: ['server_time_iso', 'mcu_time_s', 'current_temp', 'set_temp_min', 'set_temp_max', 'state', 'mode']
                for row in reader:
                    try:
                        dt_obj = datetime.fromisoformat(row["server_time_iso"])
                        data_points.append(
                            {
                                "x": dt_obj.timestamp() * 1000,  # Chart.js wants ms
                                "current_temp": float(row["current_temp"]),
                                "set_temp_min": float(row["set_temp_min"]),
                                "set_temp_max": float(row["set_temp_max"]),
                            }
                        )
                    except (ValueError, KeyError) as e:
                        print(f"Skipping malformed row in main CSV: {row} - {e}")
        return jsonify(data_points)
    except Exception as e:
        print(f"Error reading historical data: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/get_equalization_log", methods=["GET"])
def get_equalization_log_route():
    try:
        ensure_dir_exists(DATA_DIR)
        eq_events = []
        if os.path.exists(EQ_LOG_FILE):
            with open(EQ_LOG_FILE, "r", newline="", encoding="utf-8") as csvfile:
                reader = csv.DictReader(csvfile)
                # Fieldnames: ['server_time_iso', 'target_temp', 'duration_s']
                for row in reader:
                    try:
                        eq_events.append(
                            {
                                "server_time_iso": row["server_time_iso"],
                                "target_temp": float(row["target_temp"]),
                                "duration_s": float(row["duration_s"]),
                            }
                        )
                    except (ValueError, KeyError) as e:
                        print(
                            f"Skipping malformed row in equalization CSV: {row} - {e}"
                        )
        return jsonify(eq_events)
    except Exception as e:
        print(f"Error reading equalization log: {e}")
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
        return send_file(
            file_path,
            as_attachment=True,
            download_name=download_name,
            mimetype="text/csv",
        )
    else:
        socketio.emit(
            "mcu_log",
            {
                "type": "error",
                "message": f"{log_type.capitalize()} log file not found.",
            },
        )
        return f"{log_type.capitalize()} log file not found.", 404


# --- SocketIO Events ---
@socketio.on("connect")
def on_connect():
    client_sid = request.sid
    print(f"Client connected: {client_sid}")
    emit(
        "mcu_log", {"type": "info", "message": "Web client connected. Initializing..."}
    )
    send_command_to_mcu("GET_STATUS")
    emit(
        "available_serial_ports", get_available_serial_ports()
    )  # Send current ports on connect
    if SERIAL_PORT:
        emit(
            "serial_port_status",
            {
                "status": "info",
                "message": f"Currently using {SERIAL_PORT}",
                "port": SERIAL_PORT,
            },
        )


@socketio.on("disconnect")
def on_disconnect():
    client_sid = request.sid
    print(f"Client disconnected: {client_sid}")


@socketio.on("request_serial_ports")
def handle_request_serial_ports():
    emit("available_serial_ports", get_available_serial_ports())


@socketio.on("set_serial_port")
def handle_set_serial_port(data):
    global SERIAL_PORT, ser
    new_port = data.get("port")

    with serial_lock:  # Ensure thread-safe modification of SERIAL_PORT and ser
        if new_port == "":  # Auto-detect
            ports = get_available_serial_ports()
            SERIAL_PORT = ports[0] if ports else None
            message = (
                f"Auto-detecting. Selected: {SERIAL_PORT}"
                if SERIAL_PORT
                else "Auto-detect: No ports found."
            )
        else:
            SERIAL_PORT = new_port
            message = f"Serial port set to: {SERIAL_PORT}"

        print(message)
        socketio.emit("mcu_log", {"type": "info", "message": message})

        if ser and ser.is_open:  # Close existing connection if open
            print(f"Closing current serial connection to {ser.port} before switching.")
            ser.close()
            ser = None  # This will trigger reconnection attempt in serial_reader_thread with new port

        save_config()  # Save the new port selection

        # The serial_reader_thread will pick up the new SERIAL_PORT value and attempt to reconnect.
        # We can emit a status update, the thread will emit more detailed connect/fail status.
        if SERIAL_PORT:
            emit(
                "serial_port_status",
                {
                    "status": "info",
                    "message": f"Attempting to use {SERIAL_PORT}",
                    "port": SERIAL_PORT,
                },
            )
        else:
            emit(
                "serial_port_status",
                {
                    "status": "error",
                    "message": "No port selected/available",
                    "port": None,
                },
            )


if __name__ == "__main__":
    ensure_dir_exists(DATA_DIR)
    load_config()  # Load config, which might set SERIAL_PORT

    # Start the serial reading thread as a daemon
    serial_thread = threading.Thread(target=serial_reader_thread, daemon=True)
    serial_thread.start()

    print(f"Starting FermaSense Web Dashboard on http://localhost:5000")
    try:
        # For PyInstaller, ensure that the 'threading' mode is properly supported
        # The explicit import at the top of the file should help.
        socketio.run(
            app, host="0.0.0.0", port=5000, debug=False, allow_unsafe_werkzeug=True
        )
    finally:
        print("Shutting down FermaSense server...")
        shutdown_event.set()
        if serial_thread.is_alive():
            serial_thread.join(timeout=5)  # Wait for thread to finish
        print("Shutdown complete.")
