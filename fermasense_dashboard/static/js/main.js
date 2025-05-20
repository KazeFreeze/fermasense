// static/js/main.js
const socket = io(); // Connect to the Socket.IO server

// DOM Elements
const mcuTimeEl = document.getElementById("mcuTime");
const currentTempEl = document.getElementById("currentTemp");
const setTempRangeEl = document.getElementById("setTempRange");
const currentModeEl = document.getElementById("currentMode");
const currentStateEl = document.getElementById("currentState");
const stateIndicatorEl = document.getElementById("stateIndicator");
const readIntervalEl = document.getElementById("readInterval");
const lastEqTimeEl = document.getElementById("lastEqTime");

const targetTempMinInput = document.getElementById("targetTempMinInput");
const targetTempMaxInput = document.getElementById("targetTempMaxInput");
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

const MAX_LIVE_DATAPOINTS_DEFAULT = 360; // Default for 1 hour at 10s interval, will be dynamically calculated
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
          data: [], // Will reference chartDataStore.currentTemp after filtering
          tension: 0.2,
          fill: true,
          pointRadius: 1,
          borderWidth: 1.5,
        },
        {
          label: "Target Min (°C)",
          borderColor: "rgba(52, 152, 219, 0.8)", // Lighter Blue
          backgroundColor: "rgba(52, 152, 219, 0.05)",
          data: [], // Will reference chartDataStore.setTempMin after filtering
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
          data: [], // Will reference chartDataStore.setTempMax after filtering
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
            displayFormats: {
              second: "h:mm:ss a",
              minute: "h:mm a",
              hour: "h a",
            },
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
      animation: { duration: 200 }, // Shorter animation for quicker updates
    },
  });

  const eqCtx = document.getElementById("equalizationChart").getContext("2d");
  equalizationChart = new Chart(eqCtx, {
    type: "bar",
    data: {
      datasets: [
        {
          label: "Equalization Time (seconds)",
          data: [], // Will reference chartDataStore.equalizationEvents after filtering
          backgroundColor: "rgba(26, 188, 156, 0.6)",
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
              // Find the original data point in chartDataStore.equalizationEvents
              // This is a bit tricky as context.dataIndex refers to the filtered data.
              // For simplicity, we'll rely on the parsed value.
              // A more robust way would be to pass the full item to the tooltip or search by x value.
              const originalDataPoint =
                equalizationChart.data.datasets[context.datasetIndex].data[
                  context.dataIndex
                ];
              if (originalDataPoint && originalDataPoint.target_temp) {
                label += ` (Target: ${originalDataPoint.target_temp.toFixed(
                  1
                )}°C)`;
              }
              return label;
            },
          },
        },
      },
    },
  });
  loadHistoricalData(); // Load initial data for temp chart
  loadEqualizationData(); // Load initial data for eq chart
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
    addDataToTemperatureChartStore(
      // Add to store first
      timestamp,
      data.current_temp,
      data.set_temp_min,
      data.set_temp_max
    );
    // Pruning and updating is now handled by filterAndApplyDataToChart if it's a live view
    // or simply by re-filtering if not live.
    // For live views, we need to ensure the chart updates immediately.
    if (chartTimeRangeSelect.value.startsWith("live_")) {
      pruneChartDataStore(); // Prune the main store based on current live view settings
      filterAndApplyDataToChart(
        // Re-filter and update chart
        temperatureChart,
        null, // Source data array is not used for temp chart, it uses chartDataStore
        chartTimeRangeSelect.value,
        chartStartDateInput.value,
        chartEndDateInput.value
      );
    }
    // No explicit temperatureChart.update() here, filterAndApplyDataToChart handles it.
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

  const oldReadInterval = readIntervalInput.value;
  readIntervalInput.value = status.frequency_ms;

  updateUIMode(status.mode);
  updateStateIndicator(status.state);

  // If read interval changed and current view is live, refresh chart
  if (
    temperatureChart &&
    chartTimeRangeSelect.value.startsWith("live_") &&
    oldReadInterval !== readIntervalInput.value
  ) {
    addLogMessage(
      `Read interval updated to ${status.frequency_ms}ms. Refreshing live chart.`,
      "info"
    );
    updateChartDisplayRange(); // This will recalculate maxLiveDatapoints and re-filter
  }
});

socket.on("equalization_update", (data) => {
  lastEqTimeEl.textContent = `To ${parseFloat(data.target_temp).toFixed(
    1
  )}°C in ${parseFloat(data.duration_s).toFixed(1)}s (${new Date(
    data.server_time_iso
  ).toLocaleTimeString()})`;
  if (equalizationChart) {
    const timestamp = new Date(data.server_time_iso).getTime();
    const newDataPoint = {
      x: timestamp,
      y: parseFloat(data.duration_s),
      target_temp: parseFloat(data.target_temp),
    };
    chartDataStore.equalizationEvents.push(newDataPoint);
    chartDataStore.equalizationEvents.sort((a, b) => a.x - b.x); // Keep sorted

    // Re-filter and apply to chart
    filterAndApplyDataToChart(
      equalizationChart,
      chartDataStore.equalizationEvents, // Pass the full sorted store
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
});

socket.on("serial_port_status", (status) => {
  addLogMessage(
    `Serial Port: ${status.message}`,
    status.status === "success" ? "success" : "error"
  );
  if (status.port && serialPortSelect.value !== status.port) {
    // Update dropdown if backend confirms a port and it's different
    serialPortSelect.value = status.port;
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
    manualControlsDiv.style.display = "flex";
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
  const typeClass = type.toLowerCase().split("_")[0];
  logEntry.classList.add(`log-${typeClass}`);
  logEntry.innerHTML = `[${new Date().toLocaleTimeString()}] ${message
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}`;
  mcuLogOutputEl.appendChild(logEntry);
  mcuLogOutputEl.scrollTop = mcuLogOutputEl.scrollHeight;
}

// --- Chart Data Store Functions ---
function addDataToTemperatureChartStore(
  timestamp,
  currentTemp,
  setTempMin,
  setTempMax
) {
  chartDataStore.currentTemp.push({ x: timestamp, y: parseFloat(currentTemp) });
  chartDataStore.setTempMin.push({ x: timestamp, y: parseFloat(setTempMin) });
  chartDataStore.setTempMax.push({ x: timestamp, y: parseFloat(setTempMax) });
  // No sorting here, assume data comes in order or sort after batch load. Live data is appended.
}

function pruneChartDataStore() {
  const range = chartTimeRangeSelect.value;
  if (range.startsWith("live_")) {
    // maxLiveDatapoints should be up-to-date via getChartTimeWindow
    // This prunes the global chartDataStore arrays.
    [
      chartDataStore.currentTemp,
      chartDataStore.setTempMin,
      chartDataStore.setTempMax,
    ].forEach((dataset) => {
      while (dataset.length > maxLiveDatapoints) {
        dataset.shift();
      }
    });
  }
}

// --- Chart Display and Filtering Functions ---
function getChartTimeWindow(rangeValue, startDateVal, endDateVal) {
  const now = new Date().getTime();
  let minTime,
    maxTime = now + 1 * 60 * 1000; // Add a small future padding for live views
  let unit = "minute"; // Default unit

  const currentReadIntervalMs = parseInt(readIntervalInput.value) || 5000;
  const readIntervalSeconds = currentReadIntervalMs / 1000;

  if (rangeValue.startsWith("live_")) {
    const specifier = rangeValue.split("_")[1]; // e.g., "1m", "5m", "30m", "1h", "6h", "12h"
    let durationMs;
    const value = parseInt(specifier);

    if (specifier.endsWith("m")) {
      // Minutes
      durationMs = value * 60 * 1000;
      minTime = now - durationMs;
      if (value <= 1) {
        // 1m
        unit = "second"; // More granular for very short times
        maxTime = now + 10 * 1000; // Shorter future padding for 1m
      } else if (value <= 5) {
        // 5m
        unit = "minute"; // Can be 'second' too if desired
      } else {
        // 30m
        unit = "minute";
      }
    } else if (specifier.endsWith("h")) {
      // Hours
      durationMs = value * 60 * 60 * 1000;
      minTime = now - durationMs;
      if (value <= 1) unit = "minute"; // 1h
      else if (value <= 12) unit = "hour"; // 6h, 12h
      else unit = "day"; // For longer hypothetical live views
    } else {
      // Fallback for unknown live specifier, e.g. default to 1 hour
      durationMs = 1 * 60 * 60 * 1000;
      minTime = now - durationMs;
      unit = "minute";
    }
    // Calculate maxLiveDatapoints based on the duration of the live window and read interval
    maxLiveDatapoints = Math.max(
      20,
      Math.ceil(durationMs / 1000 / readIntervalSeconds)
    ); // Ensure a minimum number of points
  } else if (rangeValue.startsWith("day_")) {
    const days = parseInt(rangeValue.split("_")[1]);
    minTime = new Date(
      new Date().setHours(0, 0, 0, 0) - (days - 1) * 24 * 60 * 60 * 1000
    ).getTime();
    maxTime = new Date(new Date().setHours(23, 59, 59, 999)).getTime(); // End of today
    unit = days <= 1 ? "hour" : "day"; // For "Today", show hours. For multiple days, show days.
  } else if (rangeValue === "all") {
    minTime = null;
    maxTime = null; // Chart.js will auto-fit if min/max are null
    unit = "day"; // Sensible default unit for all data
  } else if (rangeValue === "custom" || rangeValue === "custom_eq") {
    minTime = startDateVal ? new Date(startDateVal).getTime() : null;
    maxTime = endDateVal ? new Date(endDateVal).getTime() : now;
    const duration =
      maxTime && minTime ? maxTime - minTime : 2 * 24 * 60 * 60 * 1000; // Default to 2 days if one is null
    if (duration <= 2 * 60 * 60 * 1000) unit = "minute";
    else if (duration <= 2 * 24 * 60 * 60 * 1000) unit = "hour";
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
  if (!chart) return;

  const { minTime, maxTime, unit } = getChartTimeWindow(
    rangeValue,
    startDateVal,
    endDateVal
  );

  if (chart === temperatureChart) {
    // Temperature chart uses global chartDataStore arrays directly
    chart.data.datasets[0].data = chartDataStore.currentTemp.filter(
      (p) => (!minTime || p.x >= minTime) && (!maxTime || p.x <= maxTime)
    );
    chart.data.datasets[1].data = chartDataStore.setTempMin.filter(
      (p) => (!minTime || p.x >= minTime) && (!maxTime || p.x <= maxTime)
    );
    chart.data.datasets[2].data = chartDataStore.setTempMax.filter(
      (p) => (!minTime || p.x >= minTime) && (!maxTime || p.x <= maxTime)
    );
  } else if (chart === equalizationChart && sourceDataArray) {
    // Equalization chart uses the provided sourceDataArray (which should be chartDataStore.equalizationEvents)
    const filteredData = sourceDataArray.filter(
      (p) => (!minTime || p.x >= minTime) && (!maxTime || p.x <= maxTime)
    );
    chart.data.datasets[0].data = filteredData.map((d) => ({ ...d })); // Pass copy to chart
  }

  chart.options.scales.x.min = minTime;
  chart.options.scales.x.max = maxTime;
  chart.options.scales.x.time.unit = unit;

  // Adjust display formats for x-axis ticks based on the unit
  if (unit === "second") {
    chart.options.scales.x.time.displayFormats = { second: "HH:mm:ss" };
  } else if (unit === "minute") {
    chart.options.scales.x.time.displayFormats = {
      minute: "HH:mm",
      hour: "HH:mm",
    }; // Show hour if span is large
  } else if (unit === "hour") {
    chart.options.scales.x.time.displayFormats = {
      hour: "MMM d, HH:mm",
      day: "MMM d",
    };
  } else {
    // day or other
    chart.options.scales.x.time.displayFormats = {
      day: "MMM d",
      month: "MMM yyyy",
    };
  }

  chart.update("none"); // Use "none" to avoid jerky updates when live data comes in fast
}

function updateChartDisplayRange() {
  if (!temperatureChart) return;
  const range = chartTimeRangeSelect.value;
  customDateRangePicker.style.display = range === "custom" ? "flex" : "none";

  // For live ranges, we might not need to call loadHistoricalData if data is already flowing.
  // However, loadHistoricalData also ensures the chartDataStore is populated if it was empty.
  // And filterAndApplyDataToChart will correctly filter it.
  // If switching TO a live view, or between live views, this ensures correct maxLiveDatapoints and filtering.
  if (range.startsWith("live_")) {
    // Calculate new window parameters (maxLiveDatapoints is updated in getChartTimeWindow)
    const { minTime, maxTime, unit } = getChartTimeWindow(
      range,
      chartStartDateInput.value,
      chartEndDateInput.value
    );
    // Prune existing data in store if necessary
    pruneChartDataStore();
    // Re-filter and apply to chart
    filterAndApplyDataToChart(
      temperatureChart,
      null,
      range,
      chartStartDateInput.value,
      chartEndDateInput.value
    );
  } else {
    // For non-live ranges (day_X, all, custom), always reload/re-filter from full historical data.
    loadHistoricalData(true); // true to force re-filter from chartDataStore
  }
}

function applyCustomDateRange() {
  loadHistoricalData(true); // Reload and filter with custom dates
}

async function loadHistoricalData(forceFilter = false) {
  try {
    // Only fetch if chartDataStore is empty or if not forcing a filter from existing data
    // This check is removed to ensure data is always fresh when this function is explicitly called.
    addLogMessage("Loading temperature chart data from server...", "info");
    const response = await fetch("/get_historical_data");
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();

    // Clear and repopulate the chartDataStore
    chartDataStore.currentTemp = [];
    chartDataStore.setTempMin = [];
    chartDataStore.setTempMax = [];

    data.forEach((point) => {
      // addDataToTemperatureChartStore ensures floats are parsed
      addDataToTemperatureChartStore(
        point.x,
        point.current_temp,
        point.set_temp_min,
        point.set_temp_max
      );
    });

    // Sort data after loading all of it
    chartDataStore.currentTemp.sort((a, b) => a.x - b.x);
    chartDataStore.setTempMin.sort((a, b) => a.x - b.x);
    chartDataStore.setTempMax.sort((a, b) => a.x - b.x);

    addLogMessage(
      `Temp chart data store updated: ${chartDataStore.currentTemp.length} points.`,
      "info"
    );
  } catch (error) {
    console.error("Could not load historical temp data:", error);
    addLogMessage(`Error loading temp chart data: ${error}`, "error");
  } finally {
    // Always filter and apply, even if fetch failed (to clear chart or use existing data if forceFilter is true)
    filterAndApplyDataToChart(
      temperatureChart,
      null, // Not used for temp chart
      chartTimeRangeSelect.value,
      chartStartDateInput.value,
      chartEndDateInput.value
    );
  }
}

// Equalization Chart Specific Functions
function updateEqualizationChartDisplayRange() {
  if (!equalizationChart) return;
  const range = eqChartTimeRangeSelect.value;
  customEqDateRangePicker.style.display =
    range === "custom_eq" ? "flex" : "none";
  if (range !== "custom_eq") {
    loadEqualizationData(true);
  }
}

function applyCustomEqDateRange() {
  loadEqualizationData(true);
}

async function loadEqualizationData(forceFilter = false) {
  try {
    addLogMessage("Loading equalization chart data from server...", "info");
    const response = await fetch("/get_equalization_log");
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();

    chartDataStore.equalizationEvents = data
      .map((d) => ({
        x: new Date(d.server_time_iso).getTime(),
        y: parseFloat(d.duration_s),
        target_temp: parseFloat(d.target_temp),
      }))
      .sort((a, b) => a.x - b.x);

    addLogMessage(
      `Equalization chart data store updated: ${chartDataStore.equalizationEvents.length} events.`,
      "info"
    );
  } catch (error) {
    console.error("Could not load equalization data:", error);
    addLogMessage(`Error loading equalization chart data: ${error}`, "error");
  } finally {
    filterAndApplyDataToChart(
      equalizationChart,
      chartDataStore.equalizationEvents, // Pass the full sorted store
      eqChartTimeRangeSelect.value,
      eqChartStartDateInput.value, // These are for main chart, but getChartTimeWindow will handle custom_eq
      eqChartEndDateInput.value
    );
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
        // MCU will send back its new status via 'initial_status' or 'new_data'
        // UI mode updates (like manualControls visibility) are handled by 'initial_status' or 'new_data'
        // addLogMessage(`Command "${command}" sent successfully.`, "cmd_sent"); // Already logged by backend
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
  if (tempMin >= tempMax) {
    // Allow min == max for a specific setpoint
    addLogMessage(
      "Target Min must be less than Target Max for a range.",
      "error"
    );
    // Or, if min === max is allowed, adjust message. Assuming range for now.
    // If you want to allow min === max, change to: if (tempMin > tempMax)
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
  const minInterval = parseInt(readIntervalInput.min);
  const maxInterval = parseInt(readIntervalInput.max);

  if (!isNaN(interval) && interval >= minInterval && interval <= maxInterval) {
    sendCommandToMCU(`SET_FREQ=${interval}`);
    // Optimistic UI update for the display field; actual value confirmed by 'initial_status'
    // readIntervalEl.textContent = `${interval} ms`;
    // The 'initial_status' event will update the chart if needed.
  } else {
    addLogMessage(
      `Invalid read interval: ${readIntervalInput.value}. Must be between ${minInterval}-${maxInterval}ms.`,
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
  initializeCharts(); // This now calls loadHistoricalData and loadEqualizationData internally
  updateChartDisplayRange(); // Set initial chart view based on default selection
  updateEqualizationChartDisplayRange(); // Set initial EQ chart view
  refreshSerialPorts();

  // Request initial status after a short delay to ensure socket is fully ready
  // and charts are initialized.
  setTimeout(() => {
    sendCommandToMCU("GET_STATUS");
    addLogMessage("Requested initial device status.", "info");
  }, 1000);

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
  }
});
