(function () {
  "use strict";

  var OPERATIONS_URL = "https://os.senryoyakusha.com/api/shifts/line/operations";
  var JOURNAL_KEY = "shift_v2_direct_journal_v1";
  var RECOVERY_VERSION = "2026-09-04.1";
  var RECOVERY_DELAY_MS = 5000;
  var RETRY_DELAY_MS = 2500;
  var MAX_BATCH = 30;
  var DIRECT_MARKER_ID = "__shiftV2DirectOperationId";
  var DIRECT_MARKER_FINGERPRINT = "__shiftV2DirectFingerprint";

  var state = {
    pendingStampClick: null,
    recoveryRunning: false,
    recoveryTimer: null,
    identityTimer: null
  };

  function safeGlobal(name) {
    try {
      return Function("return typeof " + name + " !== 'undefined' ? " + name + " : undefined")();
    } catch (_) {
      return undefined;
    }
  }

  function currentLineUserId() {
    return localStorage.getItem("shift_app_user_id") || safeGlobal("CURRENT_USER_ID") || null;
  }

  function getAccessToken() {
    try {
      return window.liff && liff.isLoggedIn() ? liff.getAccessToken() : null;
    } catch (_) {
      return null;
    }
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
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
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

  function activeDateFromDom() {
    var active = document.querySelector(".day.active-focus[data-date]");
    if (active && active.getAttribute("data-date")) return active.getAttribute("data-date");
    var fallback = safeGlobal("activeDateString");
    return typeof fallback === "string" && fallback ? fallback : null;
  }

  function directOperationFromRow(date, row) {
    var base = {
      operationId: newOperationId(),
      shiftKey: date + ":1",
      date: date,
      baseVersion: knownVersionForDate(date),
      clientCreatedAt: new Date().toISOString(),
      retryCount: 0
    };

    if (!row || !row.shift_label) return Object.assign(base, { operationKind: "cancel" });

    var label = String(row.shift_label);
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

    var match = label.match(/(\d{2})(\d{2})$/);
    if (!match) return null;
    var startHour = Number(match[1]);
    var endHour = Number(match[2]);
    if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || endHour > 24 || endHour < startHour) {
      return null;
    }

    var workHours = Number(row.work_hours);
    if (!Number.isFinite(workHours) || workHours < 0) workHours = endHour - startHour;

    return Object.assign(base, {
      operationKind: "upsert",
      storeKey: String(row.store || ""),
      shiftType: "work",
      startTime: String(startHour).padStart(2, "0") + ":00",
      endTime: String(endHour).padStart(2, "0") + ":00",
      workHours: workHours
    });
  }

  function sameDesiredState(left, right) {
    if (!left || !right) return false;
    if (String(left.date || "") !== String(right.date || "")) return false;
    if (String(left.operationKind || "") !== String(right.operationKind || "")) return false;
    if (left.operationKind === "cancel") return true;
    return String(left.storeKey || "") === String(right.storeKey || "")
      && String(left.shiftType || "") === String(right.shiftType || "")
      && String(left.startTime || "") === String(right.startTime || "")
      && String(left.endTime || "") === String(right.endTime || "")
      && Number(left.workHours || 0) === Number(right.workHours || 0);
  }

  function readJournalRoot() {
    try {
      var parsed = JSON.parse(localStorage.getItem(JOURNAL_KEY) || "null");
      if (parsed && parsed.version === 1 && parsed.users && typeof parsed.users === "object") return parsed;
    } catch (_) {}
    return { version: 1, users: {} };
  }

  function saveJournalRoot(root) {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(root));
  }

  function userEntries(root, lineUserId, create) {
    if (!root.users[lineUserId] && create) root.users[lineUserId] = {};
    return root.users[lineUserId] || null;
  }

  function persistJournal(lineUserId, operation) {
    var root = readJournalRoot();
    var entries = userEntries(root, lineUserId, true);
    entries[operation.shiftKey] = operation;
    saveJournalRoot(root);
  }

  function journalCount() {
    var lineUserId = currentLineUserId();
    if (!lineUserId) return 0;
    var entries = userEntries(readJournalRoot(), lineUserId, false);
    return entries ? Object.keys(entries).length : 0;
  }

  function cachedWriteConfig() {
    try {
      var cached = JSON.parse(localStorage.getItem("shift_v2_direct_config") || "null");
      return cached && cached.value ? cached.value : null;
    } catch (_) {
      return null;
    }
  }

  function writeEnabled(config) {
    return Boolean(config && (typeof config.writeEnabled === "boolean" ? config.writeEnabled : config.enabled));
  }

  function writeFrom(config) {
    return config && typeof config.writeAllowedFrom === "string"
      ? config.writeAllowedFrom
      : (config && typeof config.allowedFrom === "string" ? config.allowedFrom : null);
  }

  function writeTo(config) {
    return config && typeof config.writeAllowedTo === "string"
      ? config.writeAllowedTo
      : (config && typeof config.allowedTo === "string" ? config.allowedTo : null);
  }

  function isWriteDate(config, date) {
    if (!writeEnabled(config)) return false;
    var from = writeFrom(config);
    var to = writeTo(config);
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  }

  function requestUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function clearAcknowledgedJournal(requestOperations, acknowledgedIds) {
    var lineUserId = currentLineUserId();
    if (!lineUserId || !Array.isArray(acknowledgedIds) || !acknowledgedIds.length) return;
    var root = readJournalRoot();
    var entries = userEntries(root, lineUserId, false);
    if (!entries) return;

    acknowledgedIds.forEach(function (operationId) {
      var requestOperation = (requestOperations || []).find(function (operation) {
        return operation && operation.operationId === operationId;
      });
      if (!requestOperation || !requestOperation.date) return;
      var key = requestOperation.date + ":1";
      var journalOperation = entries[key];
      if (!journalOperation) return;
      if (journalOperation.operationId === operationId || sameDesiredState(journalOperation, requestOperation)) {
        delete entries[key];
      }
    });

    if (Object.keys(entries).length === 0) delete root.users[lineUserId];
    saveJournalRoot(root);
  }

  function installOperationAckBridge() {
    if (!window.fetch || window.fetch.__shiftV2RecoveryWrapped) return;
    var previousFetch = window.fetch.bind(window);
    var wrappedFetch = function (input, init) {
      var url = requestUrl(input);
      var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      var requestOperations = [];
      if (url === OPERATIONS_URL && method === "POST") {
        try {
          var requestBody = JSON.parse((init && init.body) || "{}");
          requestOperations = Array.isArray(requestBody.operations) ? requestBody.operations : [];
        } catch (_) {}
      }

      return previousFetch(input, init).then(function (response) {
        if (url === OPERATIONS_URL && method === "POST" && response && typeof response.clone === "function") {
          response.clone().json().then(function (payload) {
            var result = payload && payload.result ? payload.result : {};
            clearAcknowledgedJournal(
              requestOperations,
              Array.isArray(result.acknowledgedOperationIds) ? result.acknowledgedOperationIds : []
            );
          }).catch(function () {});
        }
        return response;
      });
    };
    wrappedFetch.__shiftV2RecoveryWrapped = true;
    window.fetch = wrappedFetch;
  }

  async function sendJournalBatch(accessToken, operations) {
    var response = await fetch(OPERATIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: accessToken, operations: operations })
    });
    if (!response.ok) throw new Error("Shift recovery HTTP " + response.status);
    var payload = await response.json();
    var result = payload && payload.result ? payload.result : {};
    clearAcknowledgedJournal(
      operations,
      Array.isArray(result.acknowledgedOperationIds) ? result.acknowledgedOperationIds : []
    );
  }

  async function recoverJournal() {
    if (state.recoveryRunning || !navigator.onLine) return;
    var lineUserId = currentLineUserId();
    var accessToken = getAccessToken();
    if (!lineUserId || !accessToken) return;

    var config = cachedWriteConfig();
    if (!config) {
      scheduleRecovery(RETRY_DELAY_MS);
      return;
    }

    state.recoveryRunning = true;
    try {
      var root = readJournalRoot();
      var entries = userEntries(root, lineUserId, false);
      if (!entries) return;

      if (!writeEnabled(config)) {
        delete root.users[lineUserId];
        saveJournalRoot(root);
        return;
      }

      var eligible = [];
      Object.keys(entries).forEach(function (key) {
        var operation = entries[key];
        if (!operation || !operation.date || !isWriteDate(config, operation.date)) {
          delete entries[key];
          return;
        }
        eligible.push(operation);
      });
      if (Object.keys(entries).length === 0) delete root.users[lineUserId];
      saveJournalRoot(root);

      eligible.sort(function (a, b) {
        return String(a.clientCreatedAt).localeCompare(String(b.clientCreatedAt));
      });
      for (var offset = 0; offset < eligible.length; offset += MAX_BATCH) {
        await sendJournalBatch(accessToken, eligible.slice(offset, offset + MAX_BATCH));
      }
    } catch (error) {
      console.warn("Shift v2 recovery journal send failed", error);
      scheduleRecovery(RETRY_DELAY_MS);
    } finally {
      state.recoveryRunning = false;
    }
  }

  function scheduleRecovery(delay) {
    clearTimeout(state.recoveryTimer);
    state.recoveryTimer = setTimeout(function () {
      recoverJournal();
    }, delay == null ? RECOVERY_DELAY_MS : delay);
  }

  function adoptCoreMarker(date, expectedOperation) {
    try {
      var backup = JSON.parse(localStorage.getItem("shift_backup") || "[]");
      if (!Array.isArray(backup)) return;
      var item = backup.find(function (row) { return row && row.date === date; });
      if (!item || typeof item[DIRECT_MARKER_ID] !== "string" || !item[DIRECT_MARKER_ID]) return;
      if (item[DIRECT_MARKER_FINGERPRINT] !== JSON.stringify([
        String(item.date || ""),
        String(item.shift_label || ""),
        String(item.store || "")
      ])) return;

      var lineUserId = currentLineUserId();
      if (!lineUserId) return;
      var root = readJournalRoot();
      var entries = userEntries(root, lineUserId, false);
      var current = entries && entries[date + ":1"];
      if (!current || !sameDesiredState(current, expectedOperation)) return;
      current.operationId = item[DIRECT_MARKER_ID];
      saveJournalRoot(root);
    } catch (_) {}
  }

  function installStampJournalCapture() {
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var button = target.closest("button.stamp");
      if (!button) return;
      var palette = document.getElementById("paletteOverlay");
      if (!palette || !palette.contains(button)) return;
      var date = activeDateFromDom();
      if (!date) return;
      state.pendingStampClick = {
        button: button,
        date: date,
        beforeSerialized: JSON.stringify(readCachedRow(date) || null)
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
        var after = readCachedRow(intent.date);
        if (JSON.stringify(after || null) === intent.beforeSerialized) return;
        var lineUserId = currentLineUserId();
        if (!lineUserId) return;
        var operation = directOperationFromRow(intent.date, after);
        if (!operation) return;

        // Synchronous by design: this survives an immediate LIFF/WebView close.
        persistJournal(lineUserId, operation);
        setTimeout(function () { adoptCoreMarker(intent.date, operation); }, 75);
        scheduleRecovery(RECOVERY_DELAY_MS);
      }).catch(function (error) {
        console.warn("Shift v2 recovery journal capture failed", error);
      });
    }, false);
  }

  function waitForIdentityAndRecover() {
    var attempts = 0;
    clearInterval(state.identityTimer);
    state.identityTimer = setInterval(function () {
      attempts += 1;
      if (currentLineUserId() && getAccessToken()) {
        clearInterval(state.identityTimer);
        state.identityTimer = null;
        scheduleRecovery(RECOVERY_DELAY_MS);
      } else if (attempts > 80) {
        clearInterval(state.identityTimer);
        state.identityTimer = null;
      }
    }, 250);
  }

  installOperationAckBridge();
  installStampJournalCapture();
  waitForIdentityAndRecover();

  window.addEventListener("online", function () {
    scheduleRecovery(RECOVERY_DELAY_MS);
  });

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) scheduleRecovery(RECOVERY_DELAY_MS);
  });

  window.ShiftV2DirectRecovery = {
    version: RECOVERY_VERSION,
    recoverNow: recoverJournal,
    journalCount: journalCount
  };
})();
