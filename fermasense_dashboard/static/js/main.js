// static/js/main.js
const socket = io(); // Connect to the Socket.IO server

// DOM Elements
const mcuTimeEl = document.getElementById("mcuTime");
const currentTempEl = document.getElementById("currentTemp");
const setTempEl = document.getElementById("setTemp");
const currentModeEl = document.getElementById("currentMode");
const currentStateEl = document.getElementById("currentState");
const stateAnimationEl = document.getElementById("stateAnimation");
const readIntervalEl = document.getElementById("readInterval");
const lastEqTimeEl = document.getElementById("lastEqTime");

const targetTempInput = document.getElementById("targetTempInput");
const readIntervalInput = document.getElementById("readIntervalInput");
const manualControlsDiv = document.getElementById("manualControls");
const btnModeAuto = document.getElementById("btnModeAuto");
const btnModeManual = document.getElementById("btnModeManual");

const mcuLogOutputEl = document.getElementById("mcuLogOutput");
const chartTimeRangeSelect = document.getElementById("chartTimeRange");

document.getElementById("currentYear").textContent = new Date().getFullYear();

// Chart.js Setup
let temperatureChart;
const chartDataPoints = {
  currentTemp: [],
  setTemp: [],
};
const MAX_LIVE_DATAPOINTS_DEFAULT = 360; // For 1 hour at 10s interval (approx)
let maxLiveDatapoints = MAX_LIVE_DATAPOINTS_DEFAULT;

function initializeChart() {
  const ctx = document.getElementById("temperatureChart").getContext("2d");
  temperatureChart = new Chart(ctx, {
    type: "line",
    data: {
      datasets: [
        {
          label: "Current Temp (°C)",
          borderColor: "rgba(230, 126, 34, 1)", // Orange
          backgroundColor: "rgba(230, 126, 34, 0.1)",
          data: chartDataPoints.currentTemp,
          tension: 0.2,
          fill: true,
          pointRadius: 1,
          borderWidth: 2,
        },
        {
          label: "Set Temp (°C)",
          borderColor: "rgba(52, 152, 219, 1)", // Blue
          backgroundColor: "rgba(52, 152, 219, 0.1)",
          data: chartDataPoints.setTemp,
          stepped: true,
          fill: false,
          pointRadius: 0,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: "time",
          adapters: {
            date: { locale: "en-US" }, // if using luxon
          },
          time: {
            unit: "minute", // Default, will be updated
            tooltipFormat: "MMM d, yyyy, h:mm:ss a",
            displayFormats: {
              millisecond: "h:mm:ss.SSS a",
              second: "h:mm:ss a",
              minute: "h:mm a",
              hour: "h a",
              day: "MMM d",
              week: "MMM d, yyyy",
              month: "MMM yyyy",
            },
          },
          title: { display: true, text: "Time" },
        },
        y: {
          title: { display: true, text: "Temperature (°C)" },
          beginAtZero: false, // Or true if temps are always positive
          suggestedMin: 5,
          suggestedMax: 40,
        },
      },
      plugins: {
        legend: { position: "top" },
        tooltip: { mode: "index", intersect: false },
      },
      animation: { duration: 300 }, // Smoother updates
    },
  });
  loadHistoricalData(); // Load initial data
}

// --- SocketIO Event Handlers ---
socket.on("connect", () => {
  addLogMessage("Connected to FermaSense server.", "info");
});

socket.on("disconnect", () => {
  addLogMessage("Disconnected from FermaSense server.", "error");
});

socket.on("new_data", (data) => {
  // console.log('New data:', data);
  mcuTimeEl.textContent = parseFloat(data.mcu_time_s).toFixed(2);
  currentTempEl.textContent = `${parseFloat(data.current_temp).toFixed(1)} °C`;
  setTempEl.textContent = `${parseFloat(data.set_temp).toFixed(1)} °C`;
  currentModeEl.textContent = data.mode;
  currentStateEl.textContent = data.state;
  updateStateAnimation(data.state);

  const timestamp = new Date(data.server_time_iso).getTime(); // Use server time for chart consistency

  if (temperatureChart) {
    addDataToChart(timestamp, data.current_temp, data.set_temp);
    pruneChartData();
    temperatureChart.update("none"); // 'none' for no animation on frequent live updates
  }
});

socket.on("initial_status", (status) => {
  // console.log('Initial status:', status);
  mcuTimeEl.textContent = parseFloat(status.mcu_time_s).toFixed(2);
  currentTempEl.textContent = `${parseFloat(status.current_temp).toFixed(
    1
  )} °C`;
  setTempEl.textContent = `${parseFloat(status.set_temp).toFixed(1)} °C`;
  targetTempInput.value = parseFloat(status.set_temp).toFixed(1);
  currentModeEl.textContent = status.mode;
  currentStateEl.textContent = status.state;
  readIntervalEl.textContent = `${status.frequency_ms} ms`;
  readIntervalInput.value = status.frequency_ms;
  updateUIMode(status.mode);
  updateStateAnimation(status.state);
});

socket.on("equalization_update", (data) => {
  // console.log('Equalization:', data);
  lastEqTimeEl.textContent = `To ${parseFloat(data.target_temp).toFixed(
    1
  )}°C in ${parseFloat(data.duration_s).toFixed(1)}s (${new Date(
    data.server_time_iso
  ).toLocaleTimeString()})`;
});

socket.on("mcu_log", (log) => {
  // console.log('MCU Log:', log);
  addLogMessage(log.message, log.type);
});

// --- UI Update Functions ---
function updateStateAnimation(state) {
  const stateClass = `state-${state.toLowerCase()}`;
  stateAnimationEl.className = "animation-icon"; // Reset
  stateAnimationEl.classList.add(stateClass);

  if (state === "HEATING") stateAnimationEl.textContent = "🔥";
  else if (state === "COOLING") stateAnimationEl.textContent = "❄️";
  else stateAnimationEl.textContent = "💤"; // IDLE
}

function updateUIMode(mode) {
  currentModeEl.textContent = mode;
  if (mode === "MANUAL") {
    manualControlsDiv.style.display = "block";
    btnModeManual.classList.add("active");
    btnModeAuto.classList.remove("active");
  } else {
    // AUTO
    manualControlsDiv.style.display = "none";
    btnModeAuto.classList.add("active");
    btnModeManual.classList.remove("active");
  }
}

function addLogMessage(message, type = "info") {
  const logEntry = document.createElement("div");
  logEntry.classList.add(`log-${type.toLowerCase().split("_")[0]}`); // Use base type e.g. 'info', 'error', 'cmd'
  logEntry.innerHTML = `[${new Date().toLocaleTimeString()}] ${message
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}`; // Sanitize basic HTML
  mcuLogOutputEl.appendChild(logEntry);
  mcuLogOutputEl.scrollTop = mcuLogOutputEl.scrollHeight; // Auto-scroll
}

// --- Chart Functions ---
function addDataToChart(timestamp, currentTemp, setTemp) {
  chartDataPoints.currentTemp.push({
    x: timestamp,
    y: parseFloat(currentTemp),
  });
  chartDataPoints.setTemp.push({ x: timestamp, y: parseFloat(setTemp) });
}

function pruneChartData() {
  const range = chartTimeRangeSelect.value;
  if (range.startsWith("live_")) {
    // Only prune for live views
    while (chartDataPoints.currentTemp.length > maxLiveDatapoints) {
      chartDataPoints.currentTemp.shift();
    }
    while (chartDataPoints.setTemp.length > maxLiveDatapoints) {
      chartDataPoints.setTemp.shift();
    }
  }
}

function updateChartDisplayRange() {
  if (!temperatureChart) return;
  const range = chartTimeRangeSelect.value;
  const now = new Date().getTime();
  let minTime,
    unit = "minute";

  temperatureChart.data.datasets[0].data = []; // Clear existing points before loading/filtering
  temperatureChart.data.datasets[1].data = [];
  chartDataPoints.currentTemp = []; // Also clear our master list for live data
  chartDataPoints.setTemp = [];

  if (range.startsWith("live_")) {
    const hours = parseInt(range.split("_")[1].replace("h", ""));
    minTime = now - hours * 60 * 60 * 1000;
    maxLiveDatapoints =
      hours * 60 * (60 / (readIntervalInput.value / 1000 || 5)); // Estimate based on interval
    if (hours <= 1) unit = "minute";
    else if (hours <= 12) unit = "hour";
    else unit = "day";
    loadHistoricalData(minTime, now); // Reload data for this live window
  } else {
    maxLiveDatapoints = Infinity; // Don't prune historical views
    switch (range) {
      case "day":
        minTime = new Date().setHours(0, 0, 0, 0);
        unit = "hour";
        break;
      case "3days":
        minTime = now - 3 * 24 * 60 * 60 * 1000;
        unit = "day";
        break;
      case "week":
        minTime = now - 7 * 24 * 60 * 60 * 1000;
        unit = "day";
        break;
      case "all":
      default:
        minTime = null;
        unit = "day";
        break; // Load all
    }
    loadHistoricalData(minTime, now); // Load historical data up to now for these ranges
  }
  temperatureChart.options.scales.x.min = minTime;
  temperatureChart.options.scales.x.max = now + 5 * 60 * 1000; // Add a bit of future padding for live
  temperatureChart.options.scales.x.time.unit = unit;
  temperatureChart.update();
}

async function loadHistoricalData(startTime = null, endTime = null) {
  try {
    addLogMessage("Loading chart data...", "info");
    const response = await fetch("/get_historical_data");
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();

    // Clear current points before loading historical
    chartDataPoints.currentTemp = [];
    chartDataPoints.setTemp = [];

    data.forEach((point) => {
      const pointTime = point.x; // Already in ms from server
      if (
        (!startTime || pointTime >= startTime) &&
        (!endTime || pointTime <= endTime)
      ) {
        chartDataPoints.currentTemp.push({
          x: pointTime,
          y: point.current_temp,
        });
        chartDataPoints.setTemp.push({ x: pointTime, y: point.set_temp });
      }
    });

    if (temperatureChart) {
      // Sort data just in case it's not perfectly ordered from CSV
      chartDataPoints.currentTemp.sort((a, b) => a.x - b.x);
      chartDataPoints.setTemp.sort((a, b) => a.x - b.x);

      temperatureChart.data.datasets[0].data = chartDataPoints.currentTemp;
      temperatureChart.data.datasets[1].data = chartDataPoints.setTemp;
      temperatureChart.update();
      addLogMessage(
        `Chart data loaded: ${chartDataPoints.currentTemp.length} points.`,
        "info"
      );
    }
  } catch (error) {
    console.error("Could not load historical data:", error);
    addLogMessage(`Error loading chart data: ${error}`, "error");
  }
}

// --- Command Functions ---
function sendCommandToMCU(command) {
  fetch("/send_command_to_mcu", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `command=${encodeURIComponent(command)}`,
  })
    .then((response) => response.json())
    .then((data) => {
      // Log is already handled by server emitting 'mcu_log' after sending.
      // console.log('Command sent response:', data);
      if (command === "MODE_AUTO") updateUIMode("AUTO");
      if (command === "MODE_MANUAL") updateUIMode("MANUAL");
    })
    .catch((error) => {
      console.error("Error sending command:", error);
      addLogMessage(`WEB UI Error sending command: ${error}`, "error");
    });
}

function setTargetTemperature() {
  const temp = parseFloat(targetTempInput.value);
  if (
    !isNaN(temp) &&
    temp >= parseFloat(targetTempInput.min) &&
    temp <= parseFloat(targetTempInput.max)
  ) {
    sendCommandToMCU(`SET_TEMP=${temp.toFixed(1)}`);
  } else {
    addLogMessage(
      `Invalid target temperature: ${targetTempInput.value}. Must be between ${targetTempInput.min}-${targetTempInput.max}.`,
      "error"
    );
  }
}

function setReadInterval() {
  const interval = parseInt(readIntervalInput.value);
  if (
    !isNaN(interval) &&
    interval >= parseInt(readIntervalInput.min) &&
    interval <= parseInt(readIntervalInput.max)
  ) {
    sendCommandToMCU(`SET_FREQ=${interval}`);
    // Update readIntervalEl immediately for responsiveness, MCU will confirm
    readIntervalEl.textContent = `${interval} ms`;
  } else {
    addLogMessage(
      `Invalid read interval: ${readIntervalInput.value}. Must be between ${readIntervalInput.min}-${readIntervalInput.max}.`,
      "error"
    );
  }
}

function downloadLog(logType) {
  window.location.href = `/download_log/${logType}`;
}

// --- Initialization ---
window.onload = () => {
  initializeChart();
  // Set initial range (will trigger loadHistoricalData)
  updateChartDisplayRange();
  // Request initial status again in case of reconnect
  setTimeout(() => sendCommandToMCU("GET_STATUS"), 1000);
};
