const DEFAULT_SETTINGS = {
  likes: { enabled: true, min: 1000, op: "ge" },
  reposts: { enabled: true, min: 200, op: "ge" },
  replies: { enabled: false, min: 50, op: "le" },
  views: { enabled: false, min: 50000, op: "ge" },
  time: { enabled: false, value: 24, unit: "h", op: "le" }
};

let currentSettings = { ...DEFAULT_SETTINGS };

function normalizeSettings(raw) {
  const normalized = {};
  const base = DEFAULT_SETTINGS;
  const src = raw || {};

  const normalizeMetric = (key) => {
    const value = src[key] || base[key];
    const minValue = Number(value.min);
    const op = value.op === "le" || value.op === "ge" ? value.op : base[key].op;
    normalized[key] = {
      enabled: Boolean(value.enabled),
      min: Number.isFinite(minValue) ? minValue : base[key].min,
      op
    };
  };

  normalizeMetric("likes");
  normalizeMetric("reposts");
  normalizeMetric("replies");
  normalizeMetric("views");

  const timeSrc = src.time || base.time;
  const timeValue = Number(timeSrc.value);
  const unit = timeSrc.unit === "min" || timeSrc.unit === "h" ? timeSrc.unit : base.time.unit;
  const timeOp = timeSrc.op === "le" || timeSrc.op === "ge" ? timeSrc.op : base.time.op;
  normalized.time = {
    enabled: Boolean(timeSrc.enabled),
    value: Number.isFinite(timeValue) ? timeValue : base.time.value,
    unit,
    op: timeOp
  };

  return normalized;
}

function sanitizeMin(value) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

function sanitizeTimeValue(value) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

function loadSettings() {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.sync) {
      resolve(normalizeSettings(DEFAULT_SETTINGS));
      return;
    }
    chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
      resolve(normalizeSettings(items));
    });
  });
}

function saveSettings() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.sync) {
    return;
  }
  chrome.storage.sync.set(currentSettings);
}

function bindMetricRow(row) {
  const key = row.dataset.metric;
  const toggle = row.querySelector(".metric-enabled");
  const minInput = row.querySelector(".metric-min");

  if (!key || !toggle || !minInput) return;

  if (key === "time") {
    const unitSelect = row.querySelector(".metric-unit-select");
    toggle.checked = currentSettings.time.enabled;
    minInput.value = currentSettings.time.value;
    if (unitSelect) unitSelect.value = currentSettings.time.unit;

    toggle.addEventListener("change", () => {
      currentSettings.time.enabled = toggle.checked;
      saveSettings();
    });

    minInput.addEventListener("change", () => {
      const value = sanitizeTimeValue(minInput.value);
      minInput.value = value;
      currentSettings.time.value = value;
      saveSettings();
    });

    if (unitSelect) {
      unitSelect.addEventListener("change", () => {
        const unit = unitSelect.value === "min" ? "min" : "h";
        unitSelect.value = unit;
        currentSettings.time.unit = unit;
        saveSettings();
      });
    }

    return;
  }

  toggle.checked = currentSettings[key].enabled;
  minInput.value = currentSettings[key].min;

  toggle.addEventListener("change", () => {
    currentSettings[key].enabled = toggle.checked;
    saveSettings();
  });

  minInput.addEventListener("change", () => {
    const value = sanitizeMin(minInput.value);
    minInput.value = value;
    currentSettings[key].min = value;
    saveSettings();
  });
}

async function init() {
  currentSettings = await loadSettings();
  const rows = document.querySelectorAll(".metric");
  rows.forEach((row) => bindMetricRow(row));
}

init();
