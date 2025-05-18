// static/js/main.js
const socket = io(); // Connect to the Socket.IO server

// DOM Elements
const mcuTimeEl = document.getElementById("mcuTime");
const currentTempEl = document.getElementById("currentTemp");
const setTempRangeEl = document.getElementById("setTempRange"); // Updated
const currentModeEl = document.getElementById("currentMode");
const currentStateEl = document.getElementById("currentState");
const stateIndicatorEl = document.getElementById("stateIndicator"); // Updated
const readIntervalEl = document.getElementById("readInterval");
const lastEqTimeEl = document.getElementById("lastEqTime");

const targetTempMinInput = document.getElementById("targetTempMinInput"); // New
const targetTempMaxInput = document.getElementById("targetTempMaxInput"); // New
const readIntervalInput = document.getElementById("readIntervalInput");
const manualControlsDiv = document.getElementById("manualControls");
const btnModeAuto = document.getElementById("btnModeAuto");
const btnModeManual = document.getElementById("btnModeManual");

const mcuLogOutputEl = document.getElementById("mcuLogOutput");

// Chart Elements
const chartTimeRangeSelect = document.getElementById("chartTimeRange");
const customDateRangePicker = document.getElementById("customDateRangePicker");
const chartStartDateInput = document.getElementById("chartStartDate");
const chartEndDateInput = document.getElementById("chartEndDate");

const eqChartTimeRangeSelect = document.getElementById("eqChartTimeRange");
const customEqDateRangePicker = document.getElementById(
  "customEqDateRangePicker"
);
const eqChartStartDateInput = document.getElementById("eqChartStartDate");
const eqChartEndDateInput = document.getElementById("eqChartEndDate");

// Serial Port Config
const serialPortSelect = document.getElementById("serialPortSelect");

document.getElementById("currentYear").textContent = new Date().getFullYear();

// Chart.js Setup
let temperatureChart, equalizationChart;
const chartDataStore = {
  currentTemp: [],
  setTempMin: [],
  setTempMax: [],
  equalizationEvents: [],
};

const MAX_LIVE_DATAPOINTS_DEFAULT = 360; // For 1 hour at 10s interval
let maxLiveDatapoints = MAX_LIVE_DATAPOINTS_DEFAULT;

function initializeCharts() {
  const tempCtx = document.getElementById("temperatureChart").getContext("2d");
  temperatureChart = new Chart(tempCtx, {
    type: "line",
    data: {
      datasets: [
        {
          label: "Current Temp (°C)",
          borderColor: "rgba(230, 126, 34, 1)", // Orange
          backgroundColor: "rgba(230, 126, 34, 0.1)",
          data: chartDataStore.currentTemp,
          tension: 0.2,
          fill: true,
          pointRadius: 1,
          borderWidth: 1.5,
        },
        {
          label: "Target Min (°C)",
          borderColor: "rgba(52, 152, 219, 0.8)", // Lighter Blue
          backgroundColor: "rgba(52, 152, 219, 0.05)",
          data: chartDataStore.setTempMin,
          stepped: true,
          fill: "+1", // Fill to next dataset (Target Max)
          pointRadius: 0,
          borderWidth: 1,
          borderDash: [5, 5],
        },
        {
          label: "Target Max (°C)",
          borderColor: "rgba(52, 152, 219, 1)", // Blue
          backgroundColor: "rgba(52, 152, 219, 0.1)", // Area between min and max
          data: chartDataStore.setTempMax,
          stepped: true,
          fill: false,
          pointRadius: 0,
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: "time",
          time: {
            unit: "minute",
            tooltipFormat: "MMM d, yyyy, h:mm:ss a",
            displayFormats: { minute: "h:mm a", hour: "h a" },
          },
          title: { display: true, text: "Time" },
        },
        y: {
          title: { display: true, text: "Temperature (°C)" },
          suggestedMin: 5,
          suggestedMax: 40,
        },
      },
      plugins: {
        legend: { position: "top" },
        tooltip: { mode: "index", intersect: false },
      },
      animation: { duration: 200 },
    },
  });

  const eqCtx = document.getElementById("equalizationChart").getContext("2d");
  equalizationChart = new Chart(eqCtx, {
    type: "bar", // Or 'line' if preferred for trend
    data: {
      datasets: [
        {
          label: "Equalization Time (seconds)",
          data: chartDataStore.equalizationEvents, // {x: timestamp, y: duration_s, target_temp: val}
          backgroundColor: "rgba(26, 188, 156, 0.6)", // Cool color
          borderColor: "rgba(26, 188, 156, 1)",
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: "time",
          time: { unit: "day", tooltipFormat: "MMM d, yyyy, h:mm a" },
          title: { display: true, text: "Time of Deviation" },
        },
        y: {
          title: { display: true, text: "Equalization Duration (s)" },
          beginAtZero: true,
        },
      },
      plugins: {
        legend: { position: "top" },
        tooltip: {
          callbacks: {
            label: function (context) {
              let label = context.dataset.label || "";
              if (label) {
                label += ": ";
              }
              if (context.parsed.y !== null) {
                label += `${context.parsed.y.toFixed(1)}s`;
              }
              const originalData =
                chartDataStore.equalizationEvents[context.dataIndex];
              if (originalData && originalData.target_temp) {
                label += ` (Target: ${originalData.target_temp.toFixed(1)}°C)`;
              }
              return label;
            },
          },
        },
      },
    },
  });
  loadHistoricalData();
  loadEqualizationData();
}

// --- SocketIO Event Handlers ---
socket.on("connect", () =>
  addLogMessage("Connected to FermaSense server.", "success")
);
socket.on("disconnect", () =>
  addLogMessage("Disconnected from FermaSense server.", "error")
);

socket.on("new_data", (data) => {
  mcuTimeEl.textContent = parseFloat(data.mcu_time_s).toFixed(2);
  currentTempEl.textContent = `${parseFloat(data.current_temp).toFixed(1)} °C`;
  setTempRangeEl.textContent = `${parseFloat(data.set_temp_min).toFixed(
    1
  )} / ${parseFloat(data.set_temp_max).toFixed(1)} °C`;
  currentModeEl.textContent = data.mode;
  currentStateEl.textContent = data.state;
  updateStateIndicator(data.state);

  const timestamp = new Date(data.server_time_iso).getTime();
  if (temperatureChart) {
    addDataToTemperatureChart(
      timestamp,
      data.current_temp,
      data.set_temp_min,
      data.set_temp_max
    );
    pruneChartData(
      chartDataStore.currentTemp,
      chartDataStore.setTempMin,
      chartDataStore.setTempMax
    );
    temperatureChart.update("none");
  }
});

socket.on("initial_status", (status) => {
  mcuTimeEl.textContent = parseFloat(status.mcu_time_s).toFixed(2);
  currentTempEl.textContent = `${parseFloat(status.current_temp).toFixed(
    1
  )} °C`;
  setTempRangeEl.textContent = `${parseFloat(status.set_temp_min).toFixed(
    1
  )} / ${parseFloat(status.set_temp_max).toFixed(1)} °C`;
  targetTempMinInput.value = parseFloat(status.set_temp_min).toFixed(1);
  targetTempMaxInput.value = parseFloat(status.set_temp_max).toFixed(1);
  currentModeEl.textContent = status.mode;
  currentStateEl.textContent = status.state;
  readIntervalEl.textContent = `${status.frequency_ms} ms`;
  readIntervalInput.value = status.frequency_ms;
  updateUIMode(status.mode);
  updateStateIndicator(status.state);
});

socket.on("equalization_update", (data) => {
  lastEqTimeEl.textContent = `To ${parseFloat(data.target_temp).toFixed(
    1
  )}°C in ${parseFloat(data.duration_s).toFixed(1)}s (${new Date(
    data.server_time_iso
  ).toLocaleTimeString()})`;
  if (equalizationChart) {
    const timestamp = new Date(data.server_time_iso).getTime();
    chartDataStore.equalizationEvents.push({
      x: timestamp,
      y: parseFloat(data.duration_s),
      target_temp: parseFloat(data.target_temp),
    });
    // Sort and prune if necessary for live view, though less critical for event-based chart
    chartDataStore.equalizationEvents.sort((a, b) => a.x - b.x);
    filterAndApplyDataToChart(
      equalizationChart,
      chartDataStore.equalizationEvents,
      eqChartTimeRangeSelect.value,
      eqChartStartDateInput.value,
      eqChartEndDateInput.value
    );
  }
});

socket.on("mcu_log", (log) => addLogMessage(log.message, log.type));

socket.on("available_serial_ports", (ports) => {
  const currentSelected = serialPortSelect.value;
  serialPortSelect.innerHTML = '<option value="">Auto-detect</option>'; // Reset
  ports.forEach((port) => {
    const option = document.createElement("option");
    option.value = port;
    option.textContent = port;
    if (port === currentSelected) {
      option.selected = true;
    }
    serialPortSelect.appendChild(option);
  });
  if (
    ports.length > 0 &&
    !currentSelected &&
    serialPortSelect.options.length > 1 &&
    ports.includes(ports[0])
  ) {
    // If auto was selected and we got a list, maybe pre-select the first one or the one server is using.
    // For now, let user re-select or rely on backend's current port.
  }
});

socket.on("serial_port_status", (status) => {
  addLogMessage(
    `Serial Port: ${status.message}`,
    status.status === "success" ? "success" : "error"
  );
  if (status.port) {
    serialPortSelect.value = status.port; // Update dropdown if backend confirms a port
  }
});

// --- UI Update Functions ---
function updateStateIndicator(state) {
  stateIndicatorEl.className = "state-indicator-icon"; // Reset
  if (state === "HEATING")
    stateIndicatorEl.classList.add("state-indicator-heating");
  else if (state === "COOLING")
    stateIndicatorEl.classList.add("state-indicator-cooling");
  else stateIndicatorEl.classList.add("state-indicator-idle"); // IDLE
}

function updateUIMode(mode) {
  currentModeEl.textContent = mode;
  if (mode === "MANUAL") {
    manualControlsDiv.style.display = "flex"; // or 'block'
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
  const typeClass = type.toLowerCase().split("_")[0]; // e.g. 'info', 'error', 'cmd'
  logEntry.classList.add(`log-${typeClass}`);
  logEntry.innerHTML = `[${new Date().toLocaleTimeString()}] ${message
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}`;
  mcuLogOutputEl.appendChild(logEntry);
  mcuLogOutputEl.scrollTop = mcuLogOutputEl.scrollHeight;
}

// --- Chart Functions ---
function addDataToTemperatureChart(
  timestamp,
  currentTemp,
  setTempMin,
  setTempMax
) {
  chartDataStore.currentTemp.push({ x: timestamp, y: parseFloat(currentTemp) });
  chartDataStore.setTempMin.push({ x: timestamp, y: parseFloat(setTempMin) });
  chartDataStore.setTempMax.push({ x: timestamp, y: parseFloat(setTempMax) });
}

function pruneChartData(...datasets) {
  const range = chartTimeRangeSelect.value;
  if (range.startsWith("live_")) {
    datasets.forEach((dataset) => {
      while (dataset.length > maxLiveDatapoints) {
        dataset.shift();
      }
    });
  }
}

function getChartTimeWindow(rangeValue, startDateVal, endDateVal) {
  const now = new Date().getTime();
  let minTime,
    maxTime = now + 5 * 60 * 1000; // Add padding for live
  let unit = "minute";

  if (rangeValue.startsWith("live_")) {
    const hours = parseInt(rangeValue.split("_")[1].replace("h", ""));
    minTime = now - hours * 60 * 60 * 1000;
    maxLiveDatapoints =
      hours * 60 * (60 / (parseInt(readIntervalInput.value) / 1000 || 5));
    if (hours <= 1) unit = "minute";
    else if (hours <= 24) unit = "hour";
    else unit = "day";
  } else if (rangeValue.startsWith("day_")) {
    const days = parseInt(rangeValue.split("_")[1]);
    minTime =
      new Date().setHours(0, 0, 0, 0) - (days - 1) * 24 * 60 * 60 * 1000;
    unit = days <= 3 ? "hour" : "day";
  } else if (rangeValue === "all") {
    minTime = null; // Load all
    unit = "day";
  } else if (rangeValue === "custom" || rangeValue === "custom_eq") {
    minTime = startDateVal ? new Date(startDateVal).getTime() : null;
    maxTime = endDateVal ? new Date(endDateVal).getTime() : now; // Default end to now if not set
    // Determine unit based on range duration
    const duration = maxTime - minTime;
    if (duration <= 2 * 60 * 60 * 1000) unit = "minute"; // <= 2 hours
    else if (duration <= 2 * 24 * 60 * 60 * 1000) unit = "hour"; // <= 2 days
    else unit = "day";
  }
  return { minTime, maxTime, unit };
}

function filterAndApplyDataToChart(
  chart,
  sourceDataArray,
  rangeValue,
  startDateVal,
  endDateVal
) {
  const { minTime, maxTime, unit } = getChartTimeWindow(
    rangeValue,
    startDateVal,
    endDateVal
  );

  let filteredData = sourceDataArray;
  if (minTime || maxTime) {
    filteredData = sourceDataArray.filter(
      (point) =>
        (!minTime || point.x >= minTime) && (!maxTime || point.x <= maxTime)
    );
  }

  chart.data.datasets[0].data = filteredData; // Assuming single dataset for eq chart
  if (chart === temperatureChart) {
    // Special handling for multi-dataset temp chart
    chart.data.datasets[0].data = chartDataStore.currentTemp.filter(
      (p) => (!minTime || p.x >= minTime) && (!maxTime || p.x <= maxTime)
    );
    chart.data.datasets[1].data = chartDataStore.setTempMin.filter(
      (p) => (!minTime || p.x >= minTime) && (!maxTime || p.x <= maxTime)
    );
    chart.data.datasets[2].data = chartDataStore.setTempMax.filter(
      (p) => (!minTime || p.x >= minTime) && (!maxTime || p.x <= maxTime)
    );
  }

  chart.options.scales.x.min = minTime;
  chart.options.scales.x.max = maxTime;
  chart.options.scales.x.time.unit = unit;
  chart.update();
}

function updateChartDisplayRange() {
  if (!temperatureChart) return;
  const range = chartTimeRangeSelect.value;
  customDateRangePicker.style.display = range === "custom" ? "flex" : "none";
  if (range !== "custom") {
    loadHistoricalData(true); // Force reload and filter
  }
}

function applyCustomDateRange() {
  loadHistoricalData(true);
}

async function loadHistoricalData(forceFilter = false) {
  try {
    addLogMessage("Loading temperature chart data...", "info");
    const response = await fetch("/get_historical_data");
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();

    chartDataStore.currentTemp = [];
    chartDataStore.setTempMin = [];
    chartDataStore.setTempMax = [];

    data.forEach((point) => {
      chartDataStore.currentTemp.push({ x: point.x, y: point.current_temp });
      chartDataStore.setTempMin.push({ x: point.x, y: point.set_temp_min });
      chartDataStore.setTempMax.push({ x: point.x, y: point.set_temp_max });
    });

    chartDataStore.currentTemp.sort((a, b) => a.x - b.x);
    chartDataStore.setTempMin.sort((a, b) => a.x - b.x);
    chartDataStore.setTempMax.sort((a, b) => a.x - b.x);

    filterAndApplyDataToChart(
      temperatureChart,
      [],
      chartTimeRangeSelect.value,
      chartStartDateInput.value,
      chartEndDateInput.value
    ); // Pass empty array as sourceData is handled by chartDataStore
    addLogMessage(
      `Temp chart data updated: ${chartDataStore.currentTemp.length} points.`,
      "info"
    );
  } catch (error) {
    console.error("Could not load historical temp data:", error);
    addLogMessage(`Error loading temp chart: ${error}`, "error");
  }
}

// Equalization Chart Specific Functions
function updateEqualizationChartDisplayRange() {
  if (!equalizationChart) return;
  const range = eqChartTimeRangeSelect.value;
  customEqDateRangePicker.style.display =
    range === "custom_eq" ? "flex" : "none";
  if (range !== "custom_eq") {
    loadEqualizationData(true); // Force reload and filter
  }
}

function applyCustomEqDateRange() {
  loadEqualizationData(true);
}

async function loadEqualizationData(forceFilter = false) {
  try {
    addLogMessage("Loading equalization chart data...", "info");
    const response = await fetch("/get_equalization_log"); // New endpoint needed
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json(); // Expecting {x: timestamp, y: duration_s, target_temp: val}

    chartDataStore.equalizationEvents = data
      .map((d) => ({
        x: new Date(d.server_time_iso).getTime(),
        y: parseFloat(d.duration_s),
        target_temp: parseFloat(d.target_temp),
      }))
      .sort((a, b) => a.x - b.x);

    filterAndApplyDataToChart(
      equalizationChart,
      chartDataStore.equalizationEvents,
      eqChartTimeRangeSelect.value,
      eqChartStartDateInput.value,
      eqChartEndDateInput.value
    );
    addLogMessage(
      `Equalization chart data updated: ${chartDataStore.equalizationEvents.length} points.`,
      "info"
    );
  } catch (error) {
    console.error("Could not load equalization data:", error);
    addLogMessage(`Error loading equalization chart: ${error}`, "error");
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
      if (data.status === "success") {
        if (command === "MODE_AUTO") updateUIMode("AUTO");
        if (command === "MODE_MANUAL") updateUIMode("MANUAL");
      } else {
        addLogMessage(
          `Command failed: ${data.message || "Unknown error"}`,
          "error"
        );
      }
    })
    .catch((error) => {
      console.error("Error sending command:", error);
      addLogMessage(`WEB UI Error sending command: ${error}`, "error");
    });
}

function setTargetTemperatureRange() {
  const tempMin = parseFloat(targetTempMinInput.value);
  const tempMax = parseFloat(targetTempMaxInput.value);

  if (isNaN(tempMin) || isNaN(tempMax)) {
    addLogMessage(
      "Invalid temperature input. Min and Max must be numbers.",
      "error"
    );
    return;
  }
  if (tempMin > tempMax) {
    addLogMessage("Target Min cannot be greater than Target Max.", "error");
    return;
  }
  if (
    tempMin < parseFloat(targetTempMinInput.min) ||
    tempMin > parseFloat(targetTempMinInput.max) ||
    tempMax < parseFloat(targetTempMaxInput.min) ||
    tempMax > parseFloat(targetTempMaxInput.max)
  ) {
    addLogMessage(
      `Temperatures out of allowed range (${targetTempMinInput.min}-${targetTempMinInput.max}°C).`,
      "error"
    );
    return;
  }
  sendCommandToMCU(
    `SET_TEMP_RANGE=${tempMin.toFixed(1)},${tempMax.toFixed(1)}`
  );
}

function setReadInterval() {
  const interval = parseInt(readIntervalInput.value);
  if (
    !isNaN(interval) &&
    interval >= parseInt(readIntervalInput.min) &&
    interval <= parseInt(readIntervalInput.max)
  ) {
    sendCommandToMCU(`SET_FREQ=${interval}`);
    readIntervalEl.textContent = `${interval} ms`; // Optimistic update
  } else {
    addLogMessage(
      `Invalid read interval: ${readIntervalInput.value}. Must be between ${readIntervalInput.min}-${readIntervalInput.max}ms.`,
      "error"
    );
  }
}

function downloadLog(logType) {
  window.location.href = `/download_log/${logType}`;
}

// Serial Port Configuration
function refreshSerialPorts() {
  addLogMessage("Requesting serial port list...", "info");
  socket.emit("request_serial_ports");
}

function setSerialPort() {
  const selectedPort = serialPortSelect.value;
  addLogMessage(
    `Attempting to set serial port to: ${selectedPort || "Auto-detect"}`,
    "info"
  );
  socket.emit("set_serial_port", { port: selectedPort });
}

// --- Initialization ---
window.onload = () => {
  initializeCharts();
  updateChartDisplayRange();
  updateEqualizationChartDisplayRange();
  refreshSerialPorts(); // Get initial list of ports
  setTimeout(() => sendCommandToMCU("GET_STATUS"), 1000); // Request initial status

  // Event listeners for custom date range selectors
  chartTimeRangeSelect.addEventListener("change", updateChartDisplayRange);
  eqChartTimeRangeSelect.addEventListener(
    "change",
    updateEqualizationChartDisplayRange
  );
};

// Add simple tooltips (can be enhanced)
document.addEventListener("mouseover", function (e) {
  const target = e.target.closest("[title]");
  if (target) {
    // Basic browser tooltip is usually sufficient.
    // For custom tooltips, you'd create and position an element here.
  }
});
