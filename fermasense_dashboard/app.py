from flask import Flask, render_template, request, jsonify, send_file
from flask_socketio import SocketIO, emit
import serial
import threading
import time
import csv
import os
from datetime import datetime

# --- Configuration ---
SERIAL_PORT = None # Will attempt to auto-detect, or set manually e.g., 'COM3' or '/dev/ttyUSB0'
BAUD_RATE = 115200
DATA_DIR = 'data'
MAIN_LOG_FILE = os.path.join(DATA_DIR, 'fermentation_log.csv')
EQ_LOG_FILE = os.path.join(DATA_DIR, 'equalization_log.csv')

# --- Flask App Setup ---
app = Flask(__name__)
app.config['SECRET_KEY'] = 'fermasense_secret_!@#' # CHANGE THIS FOR PRODUCTION
socketio = SocketIO(app, async_mode='threading')
ser = None # Global serial object

# --- Helper Functions ---
def ensure_dir_exists(directory):
    if not os.path.exists(directory):
        os.makedirs(directory)

def find_serial_port():
    global SERIAL_PORT
    if SERIAL_PORT: # If manually set, try it first
        try:
            s_test = serial.Serial(SERIAL_PORT)
            s_test.close()
            print(f"Using manually set serial port: {SERIAL_PORT}")
            return SERIAL_PORT
        except serial.SerialException:
            print(f"Manually set port {SERIAL_PORT} not available. Attempting auto-detect.")

    if os.name == 'nt': # Windows
        ports = [f'COM{i}' for i in range(1, 257)]
    elif os.name == 'posix': # Linux/macOS
        ports = [f'/dev/ttyUSB{i}' for i in range(10)] + \
                [f'/dev/ttyACM{i}' for i in range(10)] + \
                [f'/dev/cu.usbserial-{i}' for i in range(10)] + \
                [f'/dev/cu.usbmodem{i}' for i in range(10)]
    else:
        return None

    for port_name in ports:
        try:
            s_test = serial.Serial(port_name)
            s_test.close()
            print(f"Auto-detected serial port: {port_name}")
            SERIAL_PORT = port_name
            return port_name
        except (OSError, serial.SerialException):
            continue
    print("No serial port detected automatically.")
    return None

def log_to_csv(file_path, data_dict, fieldnames):
    ensure_dir_exists(DATA_DIR)
    file_exists = os.path.isfile(file_path)
    try:
        with open(file_path, 'a', newline='', encoding='utf-8') as csvfile:
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            if not file_exists:
                writer.writeheader()
            writer.writerow(data_dict)
    except IOError as e:
        print(f"Error writing to CSV {file_path}: {e}")
        socketio.emit('mcu_log', {'type': 'error', 'message': f"CSV Write Error: {e}"})


# --- Serial Communication Thread ---
def serial_reader_thread():
    global ser
    print("Serial reader thread started.")
    while True:
        if not SERIAL_PORT:
            print("Serial port not configured. Retrying detection in 10s.")
            socketio.emit('mcu_log', {'type': 'error', 'message': 'Serial port not configured. Retrying detection...'})
            time.sleep(10)
            find_serial_port() # Attempt to find port again
            continue

        if ser is None or not ser.is_open:
            try:
                print(f"Attempting to connect to serial port: {SERIAL_PORT}")
                ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
                print(f"Successfully connected to {SERIAL_PORT}.")
                socketio.emit('mcu_log', {'type': 'info', 'message': f'Connected to FermaSense device on {SERIAL_PORT}'})
                send_command_to_mcu("GET_STATUS") # Get initial status
            except serial.SerialException as e:
                ser = None
                print(f"Serial connection error on {SERIAL_PORT}: {e}")
                socketio.emit('mcu_log', {'type': 'error', 'message': f'Serial connection failed: {e}. Retrying...'})
                time.sleep(5) # Wait before retrying
                find_serial_port() # Maybe the port changed
                continue
        try:
            if ser and ser.in_waiting > 0:
                line = ser.readline().decode('utf-8', errors='ignore').strip()
                if line:
                    # print(f"MCU Raw: {line}") # For debugging
                    timestamp_iso = datetime.now().isoformat()
                    parts = line.split(',')

                    if parts[0] == "DATA" and len(parts) == 6:
                        # Format: DATA,Timestamp_s,CurrentTemp,SetTemp,State,Mode
                        try:
                            payload = {
                                'server_time_iso': timestamp_iso,
                                'mcu_time_s': float(parts[1]),
                                'current_temp': float(parts[2]),
                                'set_temp': float(parts[3]),
                                'state': parts[4],
                                'mode': parts[5]
                            }
                            socketio.emit('new_data', payload)
                            log_to_csv(MAIN_LOG_FILE, payload,
                                       ['server_time_iso', 'mcu_time_s', 'current_temp', 'set_temp', 'state', 'mode'])
                        except ValueError as e:
                            print(f"Error parsing DATA line: {line} - {e}")
                            socketio.emit('mcu_log', {'type': 'error', 'message': f'Data parse error: {line}'})

                    elif parts[0] == "EQUALIZED" and len(parts) == 3:
                        # Format: EQUALIZED,TargetTemp,Duration_s
                        try:
                            eq_payload = {
                                'server_time_iso': timestamp_iso,
                                'target_temp': float(parts[1]),
                                'duration_s': float(parts[2])
                            }
                            socketio.emit('equalization_update', eq_payload)
                            log_to_csv(EQ_LOG_FILE, eq_payload, ['server_time_iso', 'target_temp', 'duration_s'])
                            socketio.emit('mcu_log', {'type': 'info', 'message': f"Equalized to {parts[1]}°C in {parts[2]}s"})
                        except ValueError as e:
                            print(f"Error parsing EQUALIZED line: {line} - {e}")
                            socketio.emit('mcu_log', {'type': 'error', 'message': f'Equalization parse error: {line}'})

                    elif parts[0] in ["INFO", "ERROR", "CMD_RECV", "STATUS"]:
                        log_type = 'info' if parts[0] != "ERROR" else 'error'
                        message = line # Send the whole line
                        if parts[0] == "STATUS" and len(parts) >= 8: # Update UI with initial status
                             # STATUS,mcu_time,currT,setT,State,Mode,Freq,isEq,eqTimestamp
                             try:
                                status_payload = {
                                    'mcu_time_s': float(parts[1]),
                                    'current_temp': float(parts[2]),
                                    'set_temp': float(parts[3]),
                                    'state': parts[4],
                                    'mode': parts[5],
                                    'frequency_ms': int(parts[6]),
                                    'is_equalizing': parts[7] == "TIMING_EQ",
                                    'setpoint_change_time_s': float(parts[8])
                                }
                                socketio.emit('initial_status', status_payload)
                                message = f"Initial Status Received: Temp {parts[2]}C, Set {parts[3]}C, Mode {parts[5]}"
                             except Exception as e:
                                message = f"Error parsing STATUS: {e}"
                                log_type = 'error'

                        socketio.emit('mcu_log', {'type': log_type, 'message': message})
                    else:
                        socketio.emit('mcu_log', {'type': 'unknown', 'message': f"MCU_UNKNOWN: {line}"})

        except serial.SerialException as e:
            print(f"Serial communication error: {e}")
            socketio.emit('mcu_log', {'type': 'error', 'message': f'Serial Port Error: {e}. Connection lost.'})
            if ser:
                ser.close()
            ser = None # Trigger reconnection attempt
            time.sleep(5)
        except Exception as e:
            print(f"Unexpected error in serial_reader_thread: {e}")
            socketio.emit('mcu_log', {'type': 'error', 'message': f'Backend error: {e}'})
            time.sleep(1) # Prevent rapid error loops

# --- Flask Routes ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/send_command_to_mcu', methods=['POST'])
def send_command_route():
    command_str = request.form.get('command')
    if not command_str:
        return jsonify({'status': 'error', 'message': 'No command provided.'}), 400

    if send_command_to_mcu(command_str):
        return jsonify({'status': 'success', 'message': f'Command "{command_str}" sent.'})
    else:
        return jsonify({'status': 'error', 'message': 'Failed to send command. MCU not connected or error.'}), 500

def send_command_to_mcu(command_string):
    global ser
    if ser and ser.is_open:
        try:
            ser.write((command_string + '\n').encode('utf-8'))
            print(f"Sent to MCU: {command_string}")
            socketio.emit('mcu_log', {'type': 'cmd_sent', 'message': f'CMD > {command_string}'})
            return True
        except Exception as e:
            print(f"Error writing to serial port: {e}")
            socketio.emit('mcu_log', {'type': 'error', 'message': f'Error sending command: {e}'})
            return False
    else:
        print("Serial port not available or not open.")
        socketio.emit('mcu_log', {'type': 'error', 'message': 'Cannot send command: Serial port unavailable.'})
        return False

@app.route('/get_historical_data', methods=['GET'])
def get_historical_data_route():
    try:
        ensure_dir_exists(DATA_DIR)
        data_points = []
        if os.path.exists(MAIN_LOG_FILE):
            with open(MAIN_LOG_FILE, 'r', newline='', encoding='utf-8') as csvfile:
                reader = csv.DictReader(csvfile)
                for row in reader:
                    try:
                        # Convert to structure Chart.js expects {x: timestamp, y: value}
                        # server_time_iso,mcu_time_s,current_temp,set_temp,state,mode
                        dt_obj = datetime.fromisoformat(row['server_time_iso'])
                        data_points.append({
                            'x': dt_obj.timestamp() * 1000, # Chart.js wants ms
                            'current_temp': float(row['current_temp']),
                            'set_temp': float(row['set_temp'])
                        })
                    except (ValueError, KeyError) as e:
                        print(f"Skipping malformed row in CSV: {row} - {e}")
        return jsonify(data_points)
    except Exception as e:
        print(f"Error reading historical data: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/download_log/<log_type>')
def download_log_route(log_type):
    ensure_dir_exists(DATA_DIR)
    file_path = ""
    download_name = ""
    if log_type == 'main':
        file_path = MAIN_LOG_FILE
        download_name = 'fermasense_main_log.csv'
    elif log_type == 'equalization':
        file_path = EQ_LOG_FILE
        download_name = 'fermasense_equalization_log.csv'
    else:
        return "Invalid log type", 404

    if os.path.exists(file_path):
        return send_file(file_path, as_attachment=True, download_name=download_name, mimetype='text/csv')
    else:
        return f"{log_type.capitalize()} log file not found.", 404

# --- SocketIO Events ---
@socketio.on('connect')
def on_connect():
    client_sid = request.sid
    print(f'Client connected: {client_sid}')
    emit('mcu_log', {'type': 'info', 'message': 'Web client connected. Initializing...'})
    # Request current status from MCU when a new client connects
    send_command_to_mcu("GET_STATUS")

@socketio.on('disconnect')
def on_disconnect():
    client_sid = request.sid
    print(f'Client disconnected: {client_sid}')

if __name__ == '__main__':
    ensure_dir_exists(DATA_DIR)
    find_serial_port() # Initial attempt to find port

    # Start the serial reading thread as a daemon
    serial_thread = threading.Thread(target=serial_reader_thread, daemon=True)
    serial_thread.start()

    print(f"Starting FermaSense Web Dashboard on http://localhost:5000")
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, allow_unsafe_werkzeug=True)