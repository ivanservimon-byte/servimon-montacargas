const STORAGE_KEY = "servimon_montacargas_registros_v2";
const PENDING_KEY = "servimon_montacargas_pendientes_v1";
const INCLUDED_MINUTES = 63 * 60;
const EVENTS = ["entrada", "salidaComida", "regresoComida", "salida"];
const LABELS = {
  entrada: "Entrada",
  salidaComida: "Salida a comida",
  regresoComida: "Regreso de comida",
  salida: "Salida"
};

const $ = (id) => document.getElementById(id);

function apiUrl() {
  const value = window.SERVIMON_CONFIG && window.SERVIMON_CONFIG.GOOGLE_SCRIPT_URL;
  if (!value || value.includes("PEGAR_AQUI")) return "";
  return value.trim();
}

function todayKey(date = new Date()) {
  const copy = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return copy.toISOString().slice(0, 10);
}

function currentTime() {
  return new Date().toTimeString().slice(0, 5);
}

function formatDate(value) {
  if (!value) return "-";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function minutesFromTime(value) {
  if (!value) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatMinutes(total) {
  const safe = Math.max(0, Math.round(total || 0));
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function loadRecords() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveRecords(records) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

function mergeRecords(localRecords, remoteRecords) {
  const map = new Map();
  for (const record of [...localRecords, ...remoteRecords]) {
    const key = `${record.date}|${record.operator}|${record.forklift}`;
    const current = map.get(key) || {};
    map.set(key, { ...current, ...record });
  }
  const merged = [...map.values()];
  saveRecords(merged);
  return merged;
}

function queuePending(payload) {
  const pending = loadPending();
  pending.push({ ...payload, queuedAt: new Date().toISOString() });
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
}

function loadPending() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY)) || [];
  } catch {
    return [];
  }
}

function removePending(index) {
  const pending = loadPending();
  pending.splice(index, 1);
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
}

function getRecord(records, date, operator, forklift) {
  return records.find((item) => item.date === date && item.operator === operator && item.forklift === forklift);
}

function getOrCreateRecord(records, date, operator, forklift) {
  let record = getRecord(records, date, operator, forklift);
  if (!record) {
    record = {
      date,
      operator,
      forklift,
      entrada: "",
      salidaComida: "",
      regresoComida: "",
      salida: "",
      operatorSignature: "",
      bossSignature: ""
    };
    records.push(record);
  }
  return record;
}

function upsertLocalEvent(payload) {
  const records = loadRecords();
  const record = getOrCreateRecord(records, payload.date, payload.operator, payload.forklift);
  record[payload.event] = payload.time;
  if (payload.event === "salida") {
    record.operatorSignature = payload.operatorSignature || record.operatorSignature || "";
    record.bossSignature = payload.bossSignature || record.bossSignature || "";
  }
  saveRecords(records);
  return record;
}

function nextEvent(record) {
  return EVENTS.find((event) => !record[event]) || null;
}

function netMinutes(record) {
  const entrada = minutesFromTime(record.entrada);
  const salida = minutesFromTime(record.salida);
  if (entrada === null || salida === null) return 0;
  const salidaComida = minutesFromTime(record.salidaComida);
  const regresoComida = minutesFromTime(record.regresoComida);
  const comida = salidaComida !== null && regresoComida !== null
    ? Math.max(0, regresoComida - salidaComida)
    : 0;
  return Math.max(0, salida - entrada - comida);
}

function recordStatus(record) {
  const done = EVENTS.filter((event) => record[event]).length;
  if (done < 4) return `Pendiente: ${LABELS[EVENTS[done]]}`;
  if (!record.operatorSignature || !record.bossSignature) return "Salida sin firmas";
  return "Completo";
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setupSignaturePad(canvasId) {
  const canvas = $(canvasId);
  const context = canvas.getContext("2d");
  const pad = { drawing: false, hasInk: false };

  context.lineWidth = 3;
  context.lineCap = "round";
  context.strokeStyle = "#111318";

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    const source = event.touches ? event.touches[0] : event;
    return {
      x: (source.clientX - rect.left) * (canvas.width / rect.width),
      y: (source.clientY - rect.top) * (canvas.height / rect.height)
    };
  }

  function start(event) {
    event.preventDefault();
    const current = point(event);
    pad.drawing = true;
    context.beginPath();
    context.moveTo(current.x, current.y);
  }

  function move(event) {
    if (!pad.drawing) return;
    event.preventDefault();
    const current = point(event);
    context.lineTo(current.x, current.y);
    context.stroke();
    pad.hasInk = true;
  }

  function end() {
    pad.drawing = false;
  }

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", end);

  return {
    hasInk: () => pad.hasInk,
    clear: () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      pad.hasInk = false;
    },
    dataUrl: () => canvas.toDataURL("image/png")
  };
}

function exportCsv(records, from, to) {
  const header = ["Fecha", "Operador", "Montacargas", "Entrada", "Salida comida", "Regreso comida", "Salida", "Horas netas", "Firma operador", "Firma jefe area", "Estado"];
  const rows = records.map((record) => [
    formatDate(record.date),
    record.operator,
    record.forklift,
    record.entrada,
    record.salidaComida,
    record.regresoComida,
    record.salida,
    formatMinutes(netMinutes(record)),
    record.operatorSignature ? "Firmado" : "",
    record.bossSignature ? "Firmado" : "",
    recordStatus(record)
  ]);

  const csv = [header, ...rows]
    .map((line) => line.map((cell) => `"${String(cell || "").replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `bitacora-montacargas-${from || "inicio"}-${to || "fin"}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function registroUrl() {
  const path = location.pathname.replace(/[^/]*$/, "registro.html");
  return `${location.origin}${path}`;
}

function jsonp(params) {
  const url = apiUrl();
  if (!url) return Promise.reject(new Error("No hay URL de Google Apps Script configurada."));

  return new Promise((resolve, reject) => {
    const callback = `servimonCb_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const script = document.createElement("script");
    const query = new URLSearchParams({ ...params, callback });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("No respondio Google Sheets."));
    }, 12000);

    function cleanup() {
      clearTimeout(timer);
      delete window[callback];
      script.remove();
    }

    window[callback] = (response) => {
      cleanup();
      resolve(response);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("No se pudo conectar con Google Sheets."));
    };

    script.src = `${url}?${query.toString()}`;
    document.body.appendChild(script);
  });
}

async function fetchRemoteRecords(from = "", to = "") {
  const response = await jsonp({ action: "list", from, to });
  if (!response.ok) throw new Error(response.error || "No se pudo leer la bitacora.");
  const remote = response.records || [];
  return mergeRecords(loadRecords(), remote);
}

async function fetchRemoteDay(date, operator, forklift) {
  const response = await jsonp({ action: "record", date, operator, forklift });
  if (!response.ok) throw new Error(response.error || "No se pudo leer el registro.");
  const remote = response.record ? [response.record] : [];
  return mergeRecords(loadRecords(), remote);
}

function postToGoogleSheets(payload) {
  const url = apiUrl();
  if (!url) {
    return Promise.reject(new Error("Falta configurar Google Apps Script."));
  }

  return new Promise((resolve) => {
    const iframeName = `servimonFrame_${Date.now()}`;
    const iframe = document.createElement("iframe");
    iframe.name = iframeName;
    iframe.style.display = "none";

    const form = document.createElement("form");
    form.method = "POST";
    form.action = url;
    form.target = iframeName;
    form.style.display = "none";

    const values = { action: "save", ...payload };
    for (const [key, value] of Object.entries(values)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = value || "";
      form.appendChild(input);
    }

    let done = false;
    iframe.addEventListener("load", () => {
      if (done) return;
      done = true;
      setTimeout(() => {
        form.remove();
        iframe.remove();
      }, 300);
      resolve(true);
    });

    document.body.appendChild(iframe);
    document.body.appendChild(form);
    form.submit();
    setTimeout(() => {
      if (!done) {
        queuePending(payload);
        resolve(false);
      }
    }, 15000);
  });
}

async function saveEventCentral(payload) {
  upsertLocalEvent(payload);
  try {
    return await postToGoogleSheets(payload);
  } catch {
    queuePending(payload);
    return false;
  }
}

async function syncPending() {
  const pending = loadPending();
  if (!pending.length || !apiUrl()) return 0;
  let sent = 0;
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    await postToGoogleSheets(pending[i]);
    removePending(i);
    sent += 1;
  }
  return sent;
}
