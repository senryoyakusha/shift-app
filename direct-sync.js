(function () {
  "use strict";

  var CONFIG_URL = "https://os.senryoyakusha.com/api/shifts/line/config";
  var OPERATIONS_URL = "https://os.senryoyakusha.com/api/shifts/line/operations";
  var DB_NAME = "senryoyakusha-shift-v2";
  var DB_VERSION = 1;
  var STORE_NAME = "lineOperations";
  var MAX_BATCH = 30;
  var RETRY_DELAY_MS = 2500;

  var state = {
    config: null,
    directRunning: false,
    directTimer: null,
    configLoading: false,
    legacyApplyShift: null,
    legacyProcessBatchSave: null
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
          rows.sort(function (a, b) { return String(a.clientCreatedAt).localeCompare(String(b.clientCreatedAt)); });
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
    var remove = rows.filter(function (row) { return !isDirectDate(row.date); }).map(function (row) { return row.operationId; });
    await removeOperations(remove);
  }

  function directOperationFromStamp(date, label, store) {
    var now = new Date().toISOString();
    var base = {
      operationId: crypto.randomUUID(),
      shiftKey: date + ":1",
      date: date,
      baseVersion: null,
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
        workHours: 0
      });
    }

    var match = String(label).match(/(\d{2})(\d{2})$/);
    if (!match) return null;
    var startHour = Number(match[1]);
    var endHour = Number(match[2]);
    if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || endHour > 24 || endHour < startHour) return null;

    var workHours = endHour - startHour;
    try {
      var calc = safeGlobal("calcShiftData");
      if (typeof calc === "function") {
        var calculated = Number(calc(label));
        if (Number.isFinite(calculated) && calculated >= 0) workHours = calculated;
      }
    } catch (_) {}

    return Object.assign(base, {
      operationKind: "upsert",
      storeKey: store,
      shiftType: "work",
      startTime: String(startHour).padStart(2, "0") + ":00",
      endTime: String(endHour).padStart(2, "0") + ":00",
      workHours: workHours
    });
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
      state.config = payload && payload.config ? payload.config : { enabled: false, writeMode: "dual_write" };
      localStorage.setItem("shift_v2_direct_config", JSON.stringify({ value: state.config, cachedAt: Date.now() }));
      await clearOutsideRollout();
      scheduleDrain(0);
      scheduleLegacyDrain();
      return state.config;
    } catch (error) {
      console.warn("Shift v2 direct config unavailable; keeping legacy save path", error);
      state.config = { enabled: false, allowedFrom: null, allowedTo: null, writeMode: "dual_write" };
      scheduleLegacyDrain();
      return state.config;
    } finally {
      state.configLoading = false;
    }
  }

  function restoreCachedConfig() {
    try {
      var cached = JSON.parse(localStorage.getItem("shift_v2_direct_config") || "null");
      if (cached && cached.value && Date.now() - Number(cached.cachedAt || 0) < 6 * 60 * 60 * 1000) {
        state.config = cached.value;
      }
    } catch (_) {}
  }

  function scheduleDrain(delay) {
    clearTimeout(state.directTimer);
    state.directTimer = setTimeout(function () { drainDirectQueue(); }, delay == null ? 800 : delay);
  }

  function removeLegacyDates(dates) {
    if (!dates.size) return;
    try {
      var queue = safeGlobal("pendingQueue");
      if (!Array.isArray(queue)) return;
      var filtered = queue.filter(function (item) { return !dates.has(item.date); });
      writeGlobal("pendingQueue", filtered);
      localStorage.setItem("shift_backup", JSON.stringify(filtered));
    } catch (error) {
      console.warn("Shift v2 could not prune legacy queue", error);
    }
  }

  function scheduleLegacyDrain() {
    setTimeout(function () {
      try {
        var fn = state.legacyProcessBatchSave;
        if (typeof fn === "function") fn();
      } catch (_) {}
    }, 0);
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

        var outsideIds = batch.filter(function (op) { return !isDirectDate(op.date); }).map(function (op) { return op.operationId; });
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
          console.warn("Shift v2 direct network retry", error);
          setTimeout(function () { scheduleDrain(0); }, RETRY_DELAY_MS);
          break;
        }

        var payload = await response.json().catch(function () { return {}; });
        if (!response.ok) {
          await markRetry(batch.map(function (op) { return op.operationId; }));
          console.warn("Shift v2 direct save rejected", response.status, payload);
          if (response.status >= 500 || response.status === 429) {
            setTimeout(function () { scheduleDrain(0); }, RETRY_DELAY_MS);
          }
          break;
        }

        var result = payload && payload.result ? payload.result : {};
        var acknowledged = Array.isArray(result.acknowledgedOperationIds) ? result.acknowledgedOperationIds : [];
        if (!acknowledged.length) {
          await markRetry(batch.map(function (op) { return op.operationId; }));
          break;
        }

        await removeOperations(acknowledged);

        var ackSet = new Set(acknowledged);
        var acknowledgedBatch = batch.filter(function (op) { return ackSet.has(op.operationId); });
        if (state.config.writeMode === "direct_only") {
          removeLegacyDates(new Set(acknowledgedBatch.map(function (op) { return op.date; })));
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
      }
    } finally {
      state.directRunning = false;
      scheduleLegacyDrain();
    }
  }

  function wrapApplyShift() {
    var legacy = safeGlobal("applyShift") || window.applyShift;
    if (typeof legacy !== "function") return false;
    if (legacy.__shiftV2Wrapped) return true;
    state.legacyApplyShift = legacy;

    var wrapped = function (label, color, store) {
      var date = safeGlobal("activeDateString");
      var result = legacy.apply(this, arguments);
      if (!date) return result;

      var operation = directOperationFromStamp(date, label, store);
      if (!operation) return result;

      putLatest(operation).then(function () {
        if (!state.config) loadConfig();
        scheduleDrain(800);
      }).catch(function (error) {
        console.warn("Shift v2 could not persist direct operation", error);
      });
      return result;
    };
    wrapped.__shiftV2Wrapped = true;
    writeGlobal("applyShift", wrapped);
    window.applyShift = wrapped;
    return true;
  }

  function wrapLegacySave() {
    var legacy = safeGlobal("processBatchSave") || window.processBatchSave;
    if (typeof legacy !== "function") return false;
    if (legacy.__shiftV2Wrapped) return true;
    state.legacyProcessBatchSave = legacy;

    var wrapped = async function () {
      var queue = safeGlobal("pendingQueue");
      if (!Array.isArray(queue) || !queue.length) return legacy.apply(this, arguments);

      if (!state.config) {
        await loadConfig();
      }

      if (state.config && state.config.enabled === true && state.config.writeMode === "direct_only") {
        var hasDirectOnly = queue.some(function (item) { return item && isDirectDate(item.date); });
        if (hasDirectOnly) {
          scheduleDrain(0);
          return;
        }
      }
      return legacy.apply(this, arguments);
    };
    wrapped.__shiftV2Wrapped = true;
    writeGlobal("processBatchSave", wrapped);
    window.processBatchSave = wrapped;
    return true;
  }

  function installWrappers() {
    var applyOk = wrapApplyShift();
    var saveOk = wrapLegacySave();
    if (!applyOk || !saveOk) setTimeout(installWrappers, 250);
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
  installWrappers();
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
    reloadConfig: loadConfig,
    drain: drainDirectQueue,
    isDirectDate: isDirectDate
  };
})();
