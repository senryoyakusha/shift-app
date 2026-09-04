(function () {
  "use strict";

  var OPERATIONS_URL = "https://os.senryoyakusha.com/api/shifts/line/operations";
  var STATUS_VERSION = "2026-09-04.1";
  var hideTimer = null;
  var pendingStamp = null;

  function safeGlobal(name) {
    try {
      return Function("return typeof " + name + " !== 'undefined' ? " + name + " : undefined")();
    } catch (_) {
      return undefined;
    }
  }

  function cachedConfig() {
    try {
      var cached = JSON.parse(localStorage.getItem("shift_v2_direct_config") || "null");
      return cached && cached.value ? cached.value : null;
    } catch (_) {
      return null;
    }
  }

  function writeEnabled(config) {
    if (!config) return false;
    return typeof config.writeEnabled === "boolean"
      ? config.writeEnabled === true
      : config.enabled === true;
  }

  function writeFrom(config) {
    if (!config) return null;
    return typeof config.writeAllowedFrom === "string"
      ? config.writeAllowedFrom
      : (typeof config.allowedFrom === "string" ? config.allowedFrom : null);
  }

  function writeTo(config) {
    if (!config) return null;
    return typeof config.writeAllowedTo === "string"
      ? config.writeAllowedTo
      : (typeof config.allowedTo === "string" ? config.allowedTo : null);
  }

  function isDirectOnlyDate(date) {
    var config = cachedConfig();
    if (!config || config.writeMode !== "direct_only" || !writeEnabled(config)) return false;
    var from = writeFrom(config);
    var to = writeTo(config);
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  }

  function activeDateFromDom() {
    var active = document.querySelector(".day.active-focus[data-date]");
    if (active && active.getAttribute("data-date")) return active.getAttribute("data-date");
    var fallback = safeGlobal("activeDateString");
    return typeof fallback === "string" && fallback ? fallback : null;
  }

  function setStatus(text, background, autoHide) {
    var element = document.getElementById("saveStatus");
    if (!element) return;
    clearTimeout(hideTimer);
    hideTimer = null;
    element.innerText = text;
    element.style.background = background;
    element.classList.add("status-show");
    if (autoHide) {
      hideTimer = setTimeout(function () {
        element.classList.remove("status-show");
      }, 1600);
    }
  }

  function requestUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function parseRequestOperations(init) {
    try {
      var body = JSON.parse((init && init.body) || "{}");
      return Array.isArray(body.operations) ? body.operations : [];
    } catch (_) {
      return [];
    }
  }

  function requestTouchesDirectOnly(operations) {
    return operations.some(function (operation) {
      return operation && typeof operation.date === "string" && isDirectOnlyDate(operation.date);
    });
  }

  function installStampStatus() {
    document.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var button = target.closest("button.stamp");
      if (!button) return;
      var palette = document.getElementById("paletteOverlay");
      if (!palette || !palette.contains(button)) return;
      var date = activeDateFromDom();
      if (!date) return;
      pendingStamp = { button: button, date: date };
    }, true);

    document.addEventListener("click", function (event) {
      var intent = pendingStamp;
      if (!intent) return;
      var target = event.target;
      if (!target || typeof target.closest !== "function") return;
      var button = target.closest("button.stamp");
      if (!button || button !== intent.button) return;
      pendingStamp = null;
      if (isDirectOnlyDate(intent.date)) {
        setStatus("🔄 同期中...", "rgba(0,0,0,0.8)", false);
      }
    }, false);
  }

  function installOperationStatus() {
    if (!window.fetch || window.fetch.__shiftV2StatusWrapped) return;
    var previousFetch = window.fetch.bind(window);
    var wrappedFetch = function (input, init) {
      var url = requestUrl(input);
      var method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
      if (url !== OPERATIONS_URL || method !== "POST") {
        return previousFetch(input, init);
      }

      var operations = parseRequestOperations(init);
      var directOnly = requestTouchesDirectOnly(operations);
      if (directOnly) setStatus("🔄 同期中...", "rgba(0,0,0,0.8)", false);

      return previousFetch(input, init).then(function (response) {
        if (!directOnly) return response;
        if (!response || !response.ok || typeof response.clone !== "function") {
          setStatus("⚠️ 未同期・再送中", "rgba(243,156,18,0.9)", false);
          return response;
        }

        response.clone().json().then(function (payload) {
          var result = payload && payload.result ? payload.result : {};
          var acknowledged = Array.isArray(result.acknowledgedOperationIds)
            ? result.acknowledgedOperationIds
            : [];
          if (acknowledged.length > 0) {
            setStatus("✅ 同期済み", "rgba(42,157,143,0.9)", true);
          } else {
            setStatus("⚠️ 未同期・再送中", "rgba(243,156,18,0.9)", false);
          }
        }).catch(function () {
          setStatus("⚠️ 未同期・再送中", "rgba(243,156,18,0.9)", false);
        });
        return response;
      }).catch(function (error) {
        if (directOnly) setStatus("⚠️ 未同期・再送中", "rgba(243,156,18,0.9)", false);
        throw error;
      });
    };

    wrappedFetch.__shiftV2StatusWrapped = true;
    window.fetch = wrappedFetch;
  }

  installStampStatus();
  installOperationStatus();

  window.ShiftV2DirectStatus = {
    version: STATUS_VERSION,
    isDirectOnlyDate: isDirectOnlyDate
  };
})();
