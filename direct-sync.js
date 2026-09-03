(function () {
  "use strict";

  var CONFIG_URL = "https://os.senryoyakusha.com/api/shifts/line/config";
  var OPERATIONS_URL = "https://os.senryoyakusha.com/api/shifts/line/operations";
  var READ_URL = "https://os.senryoyakusha.com/api/shifts/line/read";
  var LEGACY_GAS_URL_FALLBACK = "https://script.google.com/macros/s/AKfycbz3Cnb2C_o8xjb9I_I_0jfgNXMhmo_TzcLh76MQ8FqYg9lYRx3VdEo4OdNVxpJO2fYl/exec";
  var DB_NAME = "senryoyakusha-shift-v2";
  var DB_VERSION = 1;
  var STORE_NAME = "lineOperations";
  var MAX_BATCH = 30;
  var RETRY_DELAY_MS = 2500;
  var ADAPTER_VERSION = "2026-09-03.4";
  var DIRECT_MARKER_ID = "__shiftV2DirectOperationId";
  var DIRECT_MARKER_FINGERPRINT = "__shiftV2DirectFingerprint";

  var state = {
    config: null,
    directRunning: false,
    directTimer: null,
    configLoading: false,
    legacyProcessBatchSave: null,
    pendingStampClick: null
  };

  function safeGlobal(name) {
    try {
      return Function("return typeof " + name + " !== 'undefined' ? " + name + " : undefined")();
    } catch (_) {
      return undefined;
    }
  }

  function writeGlobal(name, value) {
    try {
      Function("value", name + " = value")(value);
    } catch (_) {
      try { window[name] = value; } catch (_) {}
    }
  }

  function recordDebug(eventName, detail) {
    try {
      localStorage.setItem("shift_v2_direct_debug", JSON.stringify({
        version: ADAPTER_VERSION,
        event: eventName,
        detail: detail || null,
        at: new Date().toISOString()
      }));
    } catch (_) {}
  }

  function newOperationId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    if (!window.crypto || typeof window.crypto.getRandomValues !== "function") {
      throw new Error("Secure random UUID is unavailable.");
    }
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map.call(bytes, function (value) {
      return value.toString(16).padStart(2, "0");
    }).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20)
    ].join("-");
  }

  function getAccessToken() {
    try {
      return window.liff && liff.isLoggedIn() ? liff.getAccessToken() : null;
    } catch (_) {
      return null;
    }
  }

  function isDirectDate(date) {
    var config = state.config;
    if (!config || config.enabled !== true) return false;
    if (config.allowedFrom && date < config.allowedFrom) return false;
    if (config.allowedTo && date > config.allowedTo) return false;
    return true;
  }

  function knownVersionForDate(date) {
    try {
      var versions = JSON.parse(localStorage.getItem("shift_v2_versions") || "{}");
      var value = Number(versions && versions[date]);
      return Number.isInteger(value) && value >= 1 ? value : null;
    } catch (_) {
      return null;
    }
  }

  function rememberVersions(shifts) {
    try {
      var versions = JSON.parse(localStorage.getItem("shift_v2_versions") || "{}");
      (Array.isArray(shifts) ? shifts : []).forEach(function (shift) {
        if (shift && shift.date && Number.isInteger(Number(shift.version))) {
          versions[shift.date] = Number(shift.version);
        }
      });
      localStorage.setItem("shift_v2_versions", JSON.stringify(versions));
    } catch (_) {}
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          var store = db.createObjectStore(STORE_NAME, { keyPath: "operationId" });
          store.createIndex("shiftKey", "shiftKey", { unique: false });
          store.createIndex("clientCreatedAt", "clientCreatedAt", { unique: false });
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error("IndexedDB open failed")); };
    });
  }

  async function withStore(mode, callback) {
    var db = await openDb();
    try {
      return await new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, mode);
        var store = tx.objectStore(STORE_NAME);
        var result;
        try { result = callback(store, tx); } catch (error) { reject(error); return; }
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error || new Error("IndexedDB transaction failed")); };
        tx.onabort = function () { reject(tx.error || new Error("IndexedDB transaction aborted")); };
      });
    } finally {
      db.close();
    }
  }

  async function putLatest(operation) {
    var db = await openDb();
    try {
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, "readwrite");
        var store = tx.objectStore(STORE_NAME);
        var index = store.index("shiftKey");
        var cursorRequest = index.openCursor(IDBKeyRange.only(operation.shiftKey));
        cursorRequest.onsuccess = function () {
          var cursor = cursorRequest.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            store.put(operation);
          }
        };
        cursorRequest.onerror = function () { reject(cursorRequest.error); };
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    } finally {
      db.close();
    }
  }

  async function takeBatch(limit) {
    var db = await openDb();
    try {
      return await new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, "readonly");
        var store = tx.objectStore(STORE_NAME);
        var request = store.getAll();
        request.onsuccess = function () {
          var rows = request.result || [];
          rows.sort(function (a, b) {
            return String(a.clientCreatedAt).localeCompare(String(b.clientCreatedAt));
          });
          resolve(rows.slice(0, limit));
        };
        request.onerror = function () { reject(request.error); };
      });
    } finally {
      db.close();
    }
  }

  async function removeOperations(operationIds) {
    if (!operationIds.length) return;
    await withStore("readwrite", function (store) {
      operationIds.forEach(function (id) { store.delete(id); });
    });
  }

  async function markRetry(operationIds) {
    if (!operationIds.length) return;
    var db = await openDb();
    try {
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, "readwrite");
        var store = tx.objectStore(STORE_NAME);
        operationIds.forEach(function (id) {
          var request = store.get(id);
          request.onsuccess = function () {
            if (!request.result) return;
            var next = request.result;
            next.retryCount = Number(next.retryCount || 0) + 1;
            store.put(next);
          };
        });
        tx.oncomplete = resolve;
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    } finally {
      db.close();
    }
  }

  async function clearOutsideRollout() {
    if (!state.config) return;
    var rows = await takeBatch(5000);
    var remove = rows
      .filter(function (row) { return !isDirectDate(row.date); })
      .map(function (row) { return row.operationId; });
    await removeOperations(remove);
  }

  function directOperationFromStamp(date, label, store, exactWorkHours) {
    var now = new Date().toISOString();
    var base = {
      operationId: newOperationId(),
      shiftKey: date + ":1",
      date: date,
      baseVersion: knownVersionForDate(date),
      clientCreatedAt: now,
      retryCount: 0
    };

    if (!label) {
      return Object.assign(base, { operationKind: "cancel" });
    }

    var commonTypes = {
      "休み": "off",
      "希望休": "requested_off",
      "調整休み": "adjustment_off",
      "作業日": "workday"
    };
    if (commonTypes[label]) {
      return Object.assign(base, {
        operationKind: "upsert",
        storeKey: "common",
        shiftType: commonTypes[label],
        startTime: null,
        endTime: null,
        workHours: Number.isFinite(Number(exactWorkHours)) ? Number(exactWorkHours) : 0
      });
    }

    var match = String(label).match(/(\d{2})(\d{2})$/);
    if (!match) return null;
    var startHour = Number(match[1]);
    var endHour = Number(match[2]);
    if (
      !Number.isInteger(startHour)
      || !Number.isInteger(endHour)
      || startHour < 0
      || endHour > 24
      || endHour < startHour
    ) return null;

    var workHours = endHour - startHour;
    if (Number.isFinite(Number(exactWorkHours)) && Number(exactWorkHours) >= 0) {
      workHours = Number(exactWorkHours);
    } else {
      try {
        var calc = safeGlobal("calcShiftData");
        if (typeof calc === "function") {
          var calculated = Number(calc(label));
          if (Number.isFinite(calculated) && calculated >= 0) workHours = calculated;
        }
      } catch (_) {}
    }

    return Object.assign(base, {
      operationKind: "upsert",
      storeKey: store,
      shiftType: "work",
      startTime: String(startHour).padStart(2, "0") + ":00",
      endTime: String(endHour).padStart(2, "0") + ":00",
      workHours: workHours
    });
  }

  function currentLineUserId() {
    return localStorage.getItem("shift_app_user_id") || safeGlobal("CURRENT_USER_ID") || null;
  }

  function activeDateFromDom() {
    var active = document.querySelector(".day.active-focus[data-date]");
    if (active && active.getAttribute("data-date")) return active.getAttribute("data-date");
    var fallback = safeGlobal("activeDateString");
    return typeof fallback === "string" && fallback ? fallback : null;
  }

  function readCachedRow(date) {
    var rows;
    try {
      rows = JSON.parse(localStorage.getItem("cached_shifts") || "[]");
    } catch (_) {
      rows = [];
    }
    if (!Array.isArray(rows)) return null;
    var lineUserId = currentLineUserId();
    for (var i = rows.length - 1; i >= 0; i -= 1) {
      var row = rows[i];
      if (!row || row.date !== date) continue;
      if (lineUserId && row.user_id !== lineUserId) continue;
      return row;
    }
    return null;
  }

  function legacyItemFingerprint(item) {
    if (!item) return "";
    return JSON.stringify([
      String(item.date || ""),
      String(item.shift_label || ""),
      String(item.store || "")
    ]);
  }

  function markLegacyItemDurable(date, operationId) {
    try {
      var queue = safeGlobal("pendingQueue");
      if (!Array.isArray(queue)) return false;
      var marked = false;
      queue.forEach(function (item) {
        if (!item || item.date !== date) return;
        item[DIRECT_MARKER_ID] = operationId;
        item[DIRECT_MARKER_FINGERPRINT] = legacyItemFingerprint(item);
        marked = true;
      });
      if (marked) {
        writeGlobal("pendingQueue", queue);
        localStorage.setItem("shift_backup", JSON.stringify(queue));
      }
      return marked;
    } catch (error) {
      console.warn("Shift v2 could not mark legacy queue item as durable", error);
      return false;
    }
  }

  function hasDurableDirectMarker(item) {
    return Boolean(
      item
      && typeof item[DIRECT_MARKER_ID] === "string"
      && item[DIRECT_MARKER_ID]
      && item[DIRECT_MARKER_FINGERPRINT] === legacyItemFingerprint(item)
    );
  }

  function legacyGasUrl() {
    var configured = safeGlobal("GAS_URL");
    return typeof configured === "string" && configured ? configured : LEGACY_GAS_URL_FALLBACK;
  }

  function requestUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function isLegacyGasReadRequest(input, init) {
    var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    return method === "GET" && requestUrl(input) === legacyGasUrl();
  }

  function legacyResponse(body, response) {
    return new Response(JSON.stringify(body), {
      status: response && response.status ? response.status : 200,
      statusText: response && response.statusText ? response.statusText : "OK",
      headers: { "Content-Type": "application/json" }
    });
  }

  function canonicalShiftLabel(shift) {
    var shiftType = String(shift && shift.shiftType || "");
    if (shiftType === "off") return "休み";
    if (shiftType === "requested_off") return "希望休";
    if (shiftType === "adjustment_off") return "調整休み";
    if (shiftType === "workday") return "作業日";
    if (shiftType !== "work") return "";

    var storeName = String(shift.storeName || "");
    var start = String(shift.startTime || "").slice(0, 2);
    var end = String(shift.endTime || "").slice(0, 2);
    if (!storeName || !/^\d{2}$/.test(start) || !/^\d{2}$/.test(end)) return "";
    return storeName + start + end;
  }

  function canonicalShiftColor(shift) {
    if (!shift || shift.shiftType !== "work") return "var(--common-color)";
    var storeName = String(shift.storeName || "");
    var longShift = Number(shift.workHours || 0) >= 5.5;
    if (storeName === "annee") return longShift ? "var(--annee-g1)" : "var(--annee-g2)";
    if (storeName === "yoki.") return longShift ? "var(--yoki-g1)" : "var(--yoki-g2)";
    return "var(--common-color)";
  }

  function canonicalShiftToLegacy(shift, readPayload) {
    var label = canonicalShiftLabel(shift);
    if (!label) return null;
    var workHours = Number(shift.workHours || 0);
    var store = shift.shiftType === "work" ? String(shift.storeName || "") : "common";
    var attendanceScore = shift.shiftType === "work"
      ? (workHours >= 5.5 ? 1 : (workHours > 0 ? 0.5 : 0))
      : 0;
    return {
      user_id: readPayload.staff.lineUserId,
      user_name: readPayload.staff.name || "あなた",
      date: shift.date,
      shift_label: label,
      color: canonicalShiftColor(shift),
      store: store,
      work_hours: workHours,
      attendance_score: attendanceScore
    };
  }

  function mergeCanonicalSelfRead(legacyPayload, readPayload) {
    if (
      !readPayload
      || !readPayload.ok
      || !readPayload.staff
      || !readPayload.scope
      || !readPayload.staff.lineUserId
      || !readPayload.scope.allowedFrom
      || !readPayload.scope.allowedTo
    ) return legacyPayload;

    var legacyShifts = Array.isArray(legacyPayload)
      ? legacyPayload
      : (Array.isArray(legacyPayload && legacyPayload.shifts) ? legacyPayload.shifts : []);
    var users = Array.isArray(legacyPayload && legacyPayload.users) ? legacyPayload.users : [];
    var lineUserId = String(readPayload.staff.lineUserId);
    var from = String(readPayload.scope.allowedFrom);
    var to = String(readPayload.scope.allowedTo);
    var canonicalRows = (Array.isArray(readPayload.shifts) ? readPayload.shifts : [])
      .map(function (shift) { return canonicalShiftToLegacy(shift, readPayload); })
      .filter(Boolean);

    rememberVersions(readPayload.shifts || []);

    var merged = legacyShifts.filter(function (row) {
      if (!row || String(row.user_id || "") !== lineUserId) return true;
      var date = String(row.date || "").replace(/\//g, "-").split("T")[0];
      return date < from || date > to;
    }).concat(canonicalRows);

    recordDebug("read_overlay", {
      from: from,
      to: to,
      canonicalCount: canonicalRows.length,
      legacyCount: legacyShifts.length,
      mergedCount: merged.length
    });

    return { shifts: merged, users: users };
  }

  async function captureCommittedStamp(intent) {
    if (!intent || !intent.date) return;
    var after = readCachedRow(intent.date);
    var afterSerialized = JSON.stringify(after || null);
    if (afterSerialized === intent.beforeSerialized) {
      recordDebug("stamp_no_change", { date: intent.date });
      return;
    }

    if (!state.config) await loadConfig();
    if (!isDirectDate(intent.date)) {
      recordDebug("stamp_outside_rollout", { date: intent.date });
      return;
    }

    var operation;
    try {
      operation = after
        ? directOperationFromStamp(
            intent.date,
            after.shift_label || "",
            after.store || "",
            Number(after.work_hours)
          )
        : directOperationFromStamp(intent.date, "", "", null);
    } catch (error) {
      recordDebug("stamp_operation_error", {
        date: intent.date,
        message: error && error.message ? error.message : String(error)
      });
      console.warn("Shift v2 could not construct direct operation", error);
      return;
    }

    if (!operation) {
      recordDebug("stamp_unrecognized", { date: intent.date });
      return;
    }

    try {
      await putLatest(operation);
      var legacyMarked = markLegacyItemDurable(intent.date, operation.operationId);
      recordDebug("stamp_queued", {
        date: intent.date,
        operationKind: operation.operationKind,
        shiftType: operation.shiftType || null,
        storeKey: operation.storeKey || null,
        legacyMarked: legacyMarked
      });
      scheduleDrain(50);
    } catch (error) {
      recordDebug("stamp_queue_error", {
        date: intent.date,
        message: error && error.message ? error.message : String(error)
      });
      console.warn("Shift v2 could not persist direct operation", error);
    }
  }

  function installStampCapture() {
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var button = target.closest("button.stamp");
      if (!button) return;
      var palette = document.getElementById("paletteOverlay");
      if (!palette || !palette.contains(button)) return;

      var date = activeDateFromDom();
      if (!date) return;
      var before = readCachedRow(date);
      state.pendingStampClick = {
        button: button,
        date: date,
        beforeSerialized: JSON.stringify(before || null),
        startedAt: Date.now()
      };
    }, true);

    document.addEventListener("click", function (event) {
      var intent = state.pendingStampClick;
      if (!intent) return;
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var button = target.closest("button.stamp");
      if (!button || button !== intent.button) return;

      state.pendingStampClick = null;
      Promise.resolve().then(function () {
        return captureCommittedStamp(intent);
      }).catch(function (error) {
        console.warn("Shift v2 stamp capture failed", error);
      });
    }, false);
  }

  async function loadConfig() {
    if (state.configLoading) return state.config;
    var accessToken = getAccessToken();
    if (!accessToken) return null;
    state.configLoading = true;
    try {
      var response = await fetch(CONFIG_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: accessToken })
      });
      if (!response.ok) throw new Error("Shift direct config HTTP " + response.status);
      var payload = await response.json();
      state.config = payload && payload.config
        ? payload.config
        : { enabled: false, writeMode: "dual_write" };
      localStorage.setItem("shift_v2_direct_config", JSON.stringify({
        value: state.config,
        cachedAt: Date.now()
      }));
      await clearOutsideRollout();
      recordDebug("config_loaded", {
        enabled: state.config.enabled === true,
        allowedFrom: state.config.allowedFrom || null,
        allowedTo: state.config.allowedTo || null,
        writeMode: state.config.writeMode || "dual_write"
      });
      scheduleDrain(0);
      return state.config;
    } catch (error) {
      console.warn("Shift v2 direct config unavailable; keeping legacy save path", error);
      state.config = {
        enabled: false,
        allowedFrom: null,
        allowedTo: null,
        writeMode: "dual_write"
      };
      recordDebug("config_error", {
        message: error && error.message ? error.message : String(error)
      });
      return state.config;
    } finally {
      state.configLoading = false;
    }
  }

  function restoreCachedConfig() {
    try {
      var cached = JSON.parse(localStorage.getItem("shift_v2_direct_config") || "null");
      if (
        cached
        && cached.value
        && Date.now() - Number(cached.cachedAt || 0) < 6 * 60 * 60 * 1000
      ) {
        state.config = cached.value;
      }
    } catch (_) {}
  }

  function scheduleDrain(delay) {
    clearTimeout(state.directTimer);
    state.directTimer = setTimeout(function () {
      drainDirectQueue();
    }, delay == null ? 800 : delay);
  }

  function removeLegacyDates(dates) {
    if (!dates.size) return;
    try {
      var queue = safeGlobal("pendingQueue");
      if (!Array.isArray(queue)) return;
      var filtered = queue.filter(function (item) {
        return !dates.has(item.date);
      });
      writeGlobal("pendingQueue", filtered);
      localStorage.setItem("shift_backup", JSON.stringify(filtered));
    } catch (error) {
      console.warn("Shift v2 could not prune legacy queue", error);
    }
  }

  async function drainDirectQueue() {
    if (state.directRunning || !navigator.onLine) return;
    if (!state.config) {
      await loadConfig();
      if (!state.config) return;
    }
    if (state.config.enabled !== true) return;

    var accessToken = getAccessToken();
    if (!accessToken) return;
    state.directRunning = true;
    try {
      while (navigator.onLine) {
        var batch = await takeBatch(MAX_BATCH);
        if (!batch.length) break;

        var outsideIds = batch
          .filter(function (op) { return !isDirectDate(op.date); })
          .map(function (op) { return op.operationId; });
        if (outsideIds.length) {
          await removeOperations(outsideIds);
          batch = batch.filter(function (op) { return isDirectDate(op.date); });
          if (!batch.length) continue;
        }

        var response;
        try {
          response = await fetch(OPERATIONS_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              accessToken: accessToken,
              operations: batch.map(function (op) {
                var copy = Object.assign({}, op);
                delete copy.shiftKey;
                delete copy.retryCount;
                return copy;
              })
            })
          });
        } catch (error) {
          await markRetry(batch.map(function (op) { return op.operationId; }));
          recordDebug("direct_network_retry", {
            count: batch.length,
            message: error && error.message ? error.message : String(error)
          });
          console.warn("Shift v2 direct network retry", error);
          setTimeout(function () { scheduleDrain(0); }, RETRY_DELAY_MS);
          break;
        }

        var payload = await response.json().catch(function () { return {}; });
        if (!response.ok) {
          await markRetry(batch.map(function (op) { return op.operationId; }));
          recordDebug("direct_rejected", {
            count: batch.length,
            status: response.status,
            error: payload && payload.error ? payload.error : null
          });
          console.warn("Shift v2 direct save rejected", response.status, payload);
          if (response.status >= 500 || response.status === 429) {
            setTimeout(function () { scheduleDrain(0); }, RETRY_DELAY_MS);
          }
          break;
        }

        var result = payload && payload.result ? payload.result : {};
        var acknowledged = Array.isArray(result.acknowledgedOperationIds)
          ? result.acknowledgedOperationIds
          : [];
        if (!acknowledged.length) {
          await markRetry(batch.map(function (op) { return op.operationId; }));
          recordDebug("direct_no_ack", { count: batch.length });
          break;
        }

        await removeOperations(acknowledged);

        var ackSet = new Set(acknowledged);
        var acknowledgedBatch = batch.filter(function (op) {
          return ackSet.has(op.operationId);
        });
        if (state.config.writeMode === "direct_only") {
          removeLegacyDates(new Set(acknowledgedBatch.map(function (op) {
            return op.date;
          })));
        }

        try {
          var versions = JSON.parse(localStorage.getItem("shift_v2_versions") || "{}");
          (result.results || []).forEach(function (row) {
            if (row && row.shift && row.shift.date && Number.isInteger(row.shift.version)) {
              versions[row.shift.date] = row.shift.version;
            }
          });
          localStorage.setItem("shift_v2_versions", JSON.stringify(versions));
        } catch (_) {}

        recordDebug("direct_ack", {
          sent: batch.length,
          acknowledged: acknowledged.length
        });
      }
    } finally {
      state.directRunning = false;
    }
  }

  function wrapLegacySave() {
    var legacy = safeGlobal("processBatchSave") || window.processBatchSave;
    if (typeof legacy !== "function") return false;
    if (legacy.__shiftV2Wrapped) return true;
    state.legacyProcessBatchSave = legacy;

    var wrapped = async function () {
      var queue = safeGlobal("pendingQueue");
      if (!Array.isArray(queue) || !queue.length) {
        return legacy.apply(this, arguments);
      }

      if (!state.config) await loadConfig();

      if (
        state.config
        && state.config.enabled === true
        && state.config.writeMode === "direct_only"
      ) {
        var suppressibleDates = new Set(
          queue
            .filter(function (item) {
              return item && isDirectDate(item.date) && hasDurableDirectMarker(item);
            })
            .map(function (item) { return item.date; })
        );

        if (suppressibleDates.size) {
          var legacyItems = queue.filter(function (item) {
            return !item || !suppressibleDates.has(item.date);
          });
          writeGlobal("pendingQueue", legacyItems);
          localStorage.setItem("shift_backup", JSON.stringify(legacyItems));
          scheduleDrain(0);
          recordDebug("direct_only_legacy_suppressed", {
            count: queue.length - legacyItems.length,
            fallbackCount: legacyItems.filter(function (item) {
              return item && isDirectDate(item.date);
            }).length
          });
          if (!legacyItems.length) return;
        } else {
          recordDebug("direct_only_legacy_fallback", {
            count: queue.filter(function (item) {
              return item && isDirectDate(item.date);
            }).length
          });
        }
      }

      return legacy.apply(this, arguments);
    };
    wrapped.__shiftV2Wrapped = true;
    writeGlobal("processBatchSave", wrapped);
    window.processBatchSave = wrapped;
    return true;
  }

  function installLegacySaveWrapper() {
    var saveOk = wrapLegacySave();
    if (!saveOk) setTimeout(installLegacySaveWrapper, 250);
  }

  function installReadBridge() {
    if (window.fetch && window.fetch.__shiftV2ReadWrapped) return;
    var nativeFetch = window.fetch.bind(window);
    var wrappedFetch = function (input, init) {
      if (!isLegacyGasReadRequest(input, init)) return nativeFetch(input, init);

      var legacyPromise = nativeFetch(input, init);
      var accessToken = getAccessToken();
      if (!accessToken) return legacyPromise;

      var configPromise = state.config ? Promise.resolve(state.config) : loadConfig();
      return Promise.all([
        legacyPromise.then(function (response) {
          return response.json().then(function (body) {
            return { response: response, body: body };
          });
        }),
        configPromise.then(function (config) {
          if (!config || config.enabled !== true) return null;
          return nativeFetch(READ_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accessToken: accessToken })
          }).then(function (response) {
            if (!response.ok) {
              recordDebug("read_rejected", { status: response.status });
              return null;
            }
            return response.json();
          });
        }).catch(function (error) {
          recordDebug("read_config_error", {
            message: error && error.message ? error.message : String(error)
          });
          return null;
        })
      ]).then(function (parts) {
        var legacy = parts[0];
        var directRead = parts[1];
        var merged = directRead ? mergeCanonicalSelfRead(legacy.body, directRead) : legacy.body;
        return legacyResponse(merged, legacy.response);
      }).catch(function (error) {
        recordDebug("read_bridge_error", {
          message: error && error.message ? error.message : String(error)
        });
        return legacyPromise;
      });
    };
    wrappedFetch.__shiftV2ReadWrapped = true;
    window.fetch = wrappedFetch;
  }

  function waitForLiff() {
    var attempts = 0;
    var timer = setInterval(function () {
      attempts += 1;
      var token = getAccessToken();
      if (token) {
        clearInterval(timer);
        loadConfig();
        scheduleDrain(0);
      } else if (attempts > 80) {
        clearInterval(timer);
      }
    }, 250);
  }

  restoreCachedConfig();
  installReadBridge();
  installStampCapture();
  installLegacySaveWrapper();
  waitForLiff();

  window.addEventListener("online", function () {
    loadConfig();
    scheduleDrain(0);
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      loadConfig();
      scheduleDrain(0);
    }
  });

  window.ShiftV2DirectSync = {
    version: ADAPTER_VERSION,
    reloadConfig: loadConfig,
    drain: drainDirectQueue,
    isDirectDate: isDirectDate,
    debug: function () {
      try {
        return JSON.parse(localStorage.getItem("shift_v2_direct_debug") || "null");
      } catch (_) {
        return null;
      }
    }
  };
})();