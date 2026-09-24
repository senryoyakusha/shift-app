(function () {
  "use strict";

  var FULL_READ_URL = "https://os.senryoyakusha.com/api/shifts/line/read-full";
  var READ_VERSION = "2026-09-24.1";

  function recordDebug(eventName, detail) {
    try {
      localStorage.setItem("shift_v2_canonical_read_debug", JSON.stringify({
        version: READ_VERSION,
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

  function rememberVersions(shifts, lineUserId) {
    if (!lineUserId) return;
    try {
      var versions = JSON.parse(localStorage.getItem("shift_v2_versions") || "{}");
      (Array.isArray(shifts) ? shifts : []).forEach(function (shift) {
        if (
          shift
          && String(shift.lineUserId || "") === String(lineUserId)
          && shift.date
          && Number.isInteger(Number(shift.version))
        ) {
          versions[shift.date] = Number(shift.version);
        }
      });
      localStorage.setItem("shift_v2_versions", JSON.stringify(versions));
    } catch (_) {}
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
    if (!shift) return "var(--common-color)";
    var shiftType = String(shift.shiftType || "");
    if (shiftType === "off") return "#ff5e99";
    if (shiftType === "requested_off") return "#e63946";
    if (shiftType === "adjustment_off") return "#9381ff";
    if (shiftType === "workday") return "#2a9d8f";
    if (shiftType !== "work") return "var(--common-color)";

    var storeName = String(shift.storeName || "");
    var longShift = Number(shift.workHours || 0) >= 5.5;
    if (storeName === "annee") return longShift ? "var(--annee-g1)" : "var(--annee-g2)";
    if (storeName === "yoki.") return longShift ? "var(--yoki-g1)" : "var(--yoki-g2)";
    if (storeName === "aulne") return longShift ? "var(--aulne-g1)" : "var(--aulne-g2)";
    return "var(--common-color)";
  }

  function canonicalToLegacyShape(shift) {
    var label = canonicalShiftLabel(shift);
    var lineUserId = String(shift && shift.lineUserId || "");
    if (!label || !lineUserId) return null;

    var store = shift.shiftType === "work" ? String(shift.storeName || "") : "common";
    var workHours = Number(shift.workHours || 0);
    return {
      user_id: lineUserId,
      user_name: String(shift.staffName || ""),
      date: String(shift.date || ""),
      shift_label: label,
      color: canonicalShiftColor(shift),
      store: store,
      work_hours: workHours,
      attendance_score: shift.shiftType === "work"
        ? (workHours >= 5.5 ? 1 : workHours > 0 ? 0.5 : 0)
        : 0
    };
  }

  function userToLegacyShape(user) {
    var lineUserId = String(user && user.lineUserId || "");
    if (!lineUserId) return null;
    return {
      id: lineUserId,
      name: String(user.name || ""),
      stores: Array.isArray(user.stores) ? user.stores.map(String) : [],
      storeMemberships: Array.isArray(user.storeMemberships) ? user.storeMemberships : [],
      is_boss: user.isBoss === true,
      is_core: user.isCore === true
    };
  }

  function buildBody(payload) {
    if (!payload || payload.readMode !== "full_pure") {
      throw new Error("Shift canonical read contract mismatch");
    }

    var users = (Array.isArray(payload.users) ? payload.users : [])
      .map(userToLegacyShape)
      .filter(Boolean);
    var shifts = (Array.isArray(payload.shifts) ? payload.shifts : [])
      .map(canonicalToLegacyShape)
      .filter(Boolean);

    if (!users.length) throw new Error("Shift canonical read returned no users");
    var currentLineUserId = payload.staff && payload.staff.lineUserId
      ? String(payload.staff.lineUserId)
      : "";
    rememberVersions(payload.shifts || [], currentLineUserId);

    return { shifts: shifts, users: users };
  }

  async function readFull() {
    var accessToken = getAccessToken();
    if (!accessToken) throw new Error("LINE access token is unavailable");

    var response = await fetch(FULL_READ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: accessToken })
    });

    if (!response.ok) {
      recordDebug("canonical_read_rejected", { status: response.status });
      throw new Error("Shift canonical read HTTP " + response.status);
    }

    var payload = await response.json();
    var body = buildBody(payload);
    recordDebug("canonical_read_ok", {
      userCount: body.users.length,
      shiftCount: body.shifts.length
    });
    return body;
  }

  window.ShiftV2CanonicalRead = {
    version: READ_VERSION,
    readFull: readFull
  };
})();
