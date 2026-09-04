(function () {
  "use strict";

  var CONFIG_URL = "https://os.senryoyakusha.com/api/shifts/line/config";
  var READ_URL = "https://os.senryoyakusha.com/api/shifts/line/read";
  var LEGACY_GAS_URL_FALLBACK = "https://script.google.com/macros/s/AKfycbz3Cnb2C_o8xjb9I_I_0jfgNXMhmo_TzcLh76MQ8FqYg9lYRx3VdEo4OdNVxpJO2fYl/exec";
  var PILOT_VERSION = "2026-09-04.1";

  function safeGlobal(name) {
    try {
      return Function("return typeof " + name + " !== 'undefined' ? " + name + " : undefined")();
    } catch (_) {
      return undefined;
    }
  }

  function recordDebug(eventName, detail) {
    try {
      localStorage.setItem("shift_v2_pure_read_debug", JSON.stringify({
        version: PILOT_VERSION,
        event: eventName,
        detail: detail || null,
        at: new Date().toISOString()
      }));
    } catch (_) {}
  }

  function getAccessToken() {
    try {
      return window.liff && liff.isLoggedIn() ? liff.getAccessToken() : null;
    } catch (_) {
      return null;
    }
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

  function readCachedConfig() {
    try {
      var cached = JSON.parse(localStorage.getItem("shift_v2_direct_config") || "null");
      return cached && cached.value ? cached.value : null;
    } catch (_) {
      return null;
    }
  }

  function pureReadEnabled(config) {
    return Boolean(
      config
      && config.readDirectOnlyEnabled === true
      && typeof config.readDirectOnlyFrom === "string"
      && typeof config.readDirectOnlyTo === "string"
    );
  }

  async function refreshConfig(nativeFetch, accessToken) {
    var response = await nativeFetch(CONFIG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: accessToken })
    });
    if (!response.ok) throw new Error("Shift pure read config HTTP " + response.status);
    var payload = await response.json();
    var config = payload && payload.config ? payload.config : null;
    if (config) {
      localStorage.setItem("shift_v2_direct_config", JSON.stringify({ value: config, cachedAt: Date.now() }));
    }
    return config;
  }

  function readJsonArray(key) {
    try {
      var parsed = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
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

  function canonicalToLegacy(shift, readPayload) {
    var label = canonicalShiftLabel(shift);
    if (!label || !readPayload || !readPayload.staff) return null;
    var store = shift.shiftType === "work" ? String(shift.storeName || "") : "common";
    var workHours = Number(shift.workHours || 0);
    return {
      user_id: String(readPayload.staff.lineUserId || ""),
      user_name: String(readPayload.staff.name || "あなた"),
      date: String(shift.date || ""),
      shift_label: label,
      color: canonicalShiftColor(shift),
      store: store,
      work_hours: workHours,
      attendance_score: shift.shiftType === "work" ? (workHours >= 5.5 ? 1 : workHours > 0 ? 0.5 : 0) : 0
    };
  }

  function ensureCurrentUser(users, readPayload) {
    var lineUserId = String(readPayload && readPayload.staff && readPayload.staff.lineUserId || "");
    if (!lineUserId || users.some(function (user) { return user && user.id === lineUserId; })) return users;
    var current = safeGlobal("currentUserObj") || {};
    return users.concat([{
      id: lineUserId,
      name: String(readPayload.staff.name || current.name || "あなた"),
      stores: Array.isArray(current.stores) ? current.stores : [],
      is_boss: current.is_boss === true,
      is_core: current.is_core === true
    }]);
  }

  function buildPureReadBody(config, readPayload) {
    var from = String(config.readDirectOnlyFrom);
    var to = String(config.readDirectOnlyTo);
    var lineUserId = String(readPayload && readPayload.staff && readPayload.staff.lineUserId || "");
    var cachedShifts = readJsonArray("cached_shifts");
    var retained = cachedShifts.filter(function (row) {
      if (!row || String(row.user_id || "") !== lineUserId) return true;
      var date = String(row.date || "").replace(/\//g, "-").split("T")[0];
      return date < from || date > to;
    });
    var canonical = (Array.isArray(readPayload && readPayload.shifts) ? readPayload.shifts : [])
      .filter(function (shift) {
        var date = String(shift && shift.date || "");
        return date >= from && date <= to;
      })
      .map(function (shift) { return canonicalToLegacy(shift, readPayload); })
      .filter(Boolean);
    var users = ensureCurrentUser(readJsonArray("cached_users"), readPayload);
    return { shifts: retained.concat(canonical), users: users };
  }

  function cachedFallbackBody(config) {
    recordDebug("pure_read_cached_fallback", {
      from: config && config.readDirectOnlyFrom || null,
      to: config && config.readDirectOnlyTo || null
    });
    return { shifts: readJsonArray("cached_shifts"), users: readJsonArray("cached_users") };
  }

  function jsonResponse(body) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  function installPureReadBridge() {
    if (!window.fetch || window.fetch.__shiftV2PureReadWrapped) return;
    var previousFetch = window.fetch.bind(window);
    var nativeFetch = previousFetch;

    var wrappedFetch = async function (input, init) {
      if (!isLegacyGasReadRequest(input, init)) return previousFetch(input, init);

      var accessToken = getAccessToken();
      if (!accessToken) return previousFetch(input, init);

      var cachedConfig = readCachedConfig();
      var config = cachedConfig;
      try {
        config = await refreshConfig(nativeFetch, accessToken);
      } catch (error) {
        recordDebug("pure_read_config_error", { message: String(error && error.message || error) });
        if (!pureReadEnabled(cachedConfig)) return previousFetch(input, init);
        config = cachedConfig;
      }

      if (!pureReadEnabled(config)) return previousFetch(input, init);

      try {
        var readResponse = await nativeFetch(READ_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken: accessToken })
        });
        if (!readResponse.ok) throw new Error("Shift pure read HTTP " + readResponse.status);
        var readPayload = await readResponse.json();
        var body = buildPureReadBody(config, readPayload);
        recordDebug("pure_read_direct", {
          from: config.readDirectOnlyFrom,
          to: config.readDirectOnlyTo,
          canonicalCount: Array.isArray(readPayload.shifts) ? readPayload.shifts.length : 0
        });
        return jsonResponse(body);
      } catch (error) {
        // Once pure READ is enabled, never silently fall back to Sheets/GAS.
        recordDebug("pure_read_error", { message: String(error && error.message || error) });
        return jsonResponse(cachedFallbackBody(config));
      }
    };

    wrappedFetch.__shiftV2PureReadWrapped = true;
    window.fetch = wrappedFetch;
  }

  installPureReadBridge();

  window.ShiftV2PureReadPilot = {
    version: PILOT_VERSION,
    pureReadEnabled: pureReadEnabled
  };
})();
