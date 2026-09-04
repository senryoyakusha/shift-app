(function () {
  "use strict";

  var VERSION = "2026-09-04.10";
  var PRESETS = ["0920", "1020", "1021", "1621", "1721"];

  function normalizedStores(user) {
    return (Array.isArray(user && user.stores) ? user.stores : [])
      .map(String)
      .map(function (store) { return store.trim(); })
      .filter(Boolean);
  }

  function membershipRows(user) {
    return (Array.isArray(user && user.storeMemberships) ? user.storeMemberships : [])
      .filter(function (membership) {
        return membership && typeof membership.storeName === "string" && membership.storeName.trim();
      });
  }

  function membershipEffectiveOn(membership, date) {
    if (!date) return true;
    var start = typeof membership.startDate === "string" ? membership.startDate : null;
    var end = typeof membership.endDate === "string" ? membership.endDate : null;
    return (!start || start <= date) && (!end || end >= date);
  }

  function storesForUser(user, date) {
    var memberships = membershipRows(user);
    if (!memberships.length) return normalizedStores(user);
    var seen = new Set();
    memberships.forEach(function (membership) {
      if (!membershipEffectiveOn(membership, date)) return;
      seen.add(String(membership.storeName).trim());
    });
    return Array.from(seen);
  }

  function allUserStores() {
    var seen = new Set();
    (Array.isArray(globalUsersData) ? globalUsersData : []).forEach(function (user) {
      normalizedStores(user).forEach(function (store) { seen.add(store); });
    });
    return Array.from(seen);
  }

  function personalStores(date) {
    return storesForUser(currentUserObj, date);
  }

  function visibleSharedStores() {
    if (currentUserObj && (currentUserObj.is_boss || currentUserObj.is_core)) return allUserStores();
    return personalStores(null);
  }

  function storeColor(store, longShift) {
    if (store === "annee") return longShift ? "var(--annee-g1)" : "var(--annee-g2)";
    if (store === "yoki.") return longShift ? "var(--yoki-g1)" : "var(--yoki-g2)";
    if (store === "aulne") return longShift ? "var(--aulne-g1)" : "var(--aulne-g2)";
    return "var(--common-color)";
  }

  function seatCountForStore(storeName) {
    var target = String(storeName || "").trim();
    if (!target) return null;
    var users = Array.isArray(globalUsersData) ? globalUsersData : [];
    for (var i = 0; i < users.length; i++) {
      var memberships = membershipRows(users[i]);
      for (var j = 0; j < memberships.length; j++) {
        var membership = memberships[j];
        if (String(membership.storeName || "").trim() !== target) continue;
        var seats = Number(membership.seatCount);
        if (Number.isFinite(seats) && seats > 0) return seats;
      }
    }
    return null;
  }

  function safeStoreId(store) {
    var encoded = Array.from(new TextEncoder().encode(String(store || "")))
      .map(function (value) { return value.toString(16).padStart(2, "0"); })
      .join("");
    return "store-" + (encoded || "unknown");
  }

  function ensureStoreTabs() {
    var container = document.getElementById("storeTabs");
    if (!container) return [];
    var stores = visibleSharedStores();
    container.innerHTML = "";
    stores.forEach(function (store) {
      var tab = document.createElement("div");
      tab.className = "store-tab";
      tab.id = "tab-" + safeStoreId(store);
      tab.dataset.store = store;
      tab.style.display = "block";
      tab.textContent = store;
      tab.onclick = function () { switchStore(store); };
      container.appendChild(tab);
    });
    return stores;
  }

  function ensureDynamicPaletteGroups() {
    var content = document.getElementById("paletteContent");
    if (!content) return;

    var annee = document.getElementById("palette-group-annee");
    var yoki = document.getElementById("palette-group-yoki");
    if (annee) annee.dataset.store = "annee";
    if (yoki) yoki.dataset.store = "yoki.";

    content.querySelectorAll(".palette-group-dynamic").forEach(function (node) { node.remove(); });
    var commonTitle = Array.from(content.children).find(function (node) {
      return node.classList && node.classList.contains("palette-section-title") && String(node.textContent || "").includes("共通");
    });

    personalStores(null).forEach(function (store) {
      if (store === "annee" || store === "yoki.") return;
      var group = document.createElement("div");
      group.className = "palette-group-dynamic";
      group.dataset.store = store;
      group.style.display = "none";

      var title = document.createElement("div");
      title.className = "palette-section-title";
      title.textContent = "■ " + store;
      group.appendChild(title);

      var grid = document.createElement("div");
      grid.className = "stamp-grid";
      PRESETS.forEach(function (time) {
        var start = Number(time.slice(0, 2));
        var end = Number(time.slice(2, 4));
        var button = document.createElement("button");
        button.type = "button";
        button.className = "stamp";
        button.style.background = storeColor(store, end - start >= 5.5);
        button.innerHTML = store + "<br>" + time;
        button.onclick = function () {
          applyShift(store + time, storeColor(store, end - start >= 5.5), store);
        };
        grid.appendChild(button);
      });

      var add = document.createElement("button");
      add.type = "button";
      add.className = "stamp s-del";
      add.style.border = "1px dashed #666";
      add.style.color = "#666";
      add.style.fontSize = "1rem";
      add.textContent = "＋";
      add.onclick = function () { createCustomStamp(store); };
      grid.appendChild(add);
      group.appendChild(grid);

      if (commonTitle) content.insertBefore(group, commonTitle);
      else content.appendChild(group);
    });
  }

  window.applyPermissions = function () {
    var found = (Array.isArray(globalUsersData) ? globalUsersData : []).find(function (user) {
      return user && user.id === CURRENT_USER_ID;
    });
    if (found) currentUserObj = found;

    var stores = ensureStoreTabs();
    ensureDynamicPaletteGroups();
    if (stores.length && !stores.includes(currentStore)) currentStore = stores[0];
    if (stores.length) switchStore(currentStore);
  };

  window.switchView = function (viewName) {
    currentView = viewName;
    document.getElementById("personalView").style.display = viewName === "personal" ? "block" : "none";
    document.getElementById("sharedView").style.display = viewName === "shared" ? "block" : "none";
    var tabs = ensureStoreTabs();
    document.getElementById("storeTabs").style.display = viewName === "shared" && tabs.length ? "flex" : "none";
    if (viewName === "shared") document.body.classList.add("noscroll");
    else document.body.classList.remove("noscroll");
    document.getElementById("navPersonal").className = viewName === "personal" ? "nav-item active" : "nav-item";
    document.getElementById("navShared").className = viewName === "shared" ? "nav-item active" : "nav-item";
    closePalette();
    if (viewName === "shared" && tabs.length) {
      if (!tabs.includes(currentStore)) currentStore = tabs[0];
      switchStore(currentStore);
    }
  };

  window.switchStore = function (storeName) {
    currentStore = storeName;
    localStorage.setItem("shift_app_store", storeName);
    document.querySelectorAll("#storeTabs .store-tab").forEach(function (tab) {
      var active = tab.dataset.store === storeName;
      tab.style.color = active ? "var(--main-red)" : "#aaa";
      tab.style.borderBottomColor = active ? "var(--main-red)" : "transparent";
    });
    if (currentView === "shared") renderSharedCalendars();
  };

  window.renderMyStamps = function () {
    ensureDynamicPaletteGroups();
    var customChanged = false;
    document.querySelectorAll("#paletteContent [data-store]").forEach(function (group) {
      var store = group.dataset.store;
      var grid = group.querySelector(".stamp-grid");
      if (!store || !grid) return;
      grid.querySelectorAll(".my-stamp").forEach(function (button) { button.remove(); });
      var addButton = Array.from(grid.querySelectorAll(".s-del")).find(function (button) {
        return String(button.textContent || "").trim() === "＋";
      });
      (Array.isArray(myCustomStamps) ? myCustomStamps : [])
        .filter(function (stamp) { return stamp && stamp.store === store; })
        .forEach(function (stamp) {
          var match = String(stamp.label || "").match(/(\d{2})(\d{2})$/);
          var hours = match ? parseInt(match[2], 10) - parseInt(match[1], 10) : 0;
          var normalizedColor = hours > 0 ? storeColor(store, hours >= 5.5) : (stamp.color || storeColor(store, true));
          if (stamp.color !== normalizedColor) {
            stamp.color = normalizedColor;
            customChanged = true;
          }
          var button = document.createElement("button");
          button.type = "button";
          button.className = "stamp my-stamp";
          button.style.background = normalizedColor;
          button.innerHTML = stamp.text;
          button.onclick = function () { applyShift(stamp.label, normalizedColor, stamp.store); };
          if (addButton) grid.insertBefore(button, addButton);
          else grid.appendChild(button);
        });
    });
    if (customChanged) localStorage.setItem("my_custom_stamps", JSON.stringify(myCustomStamps));
  };

  window.openPalette = function (element, dateText, dateIso) {
    if (activeDayElement) activeDayElement.classList.remove("active-focus");
    activeDayElement = element;
    activeDateString = dateIso;
    activeDayElement.classList.add("active-focus");
    document.getElementById("selectedDateDisplay").innerText = dateText;

    renderMyStamps();
    var allowed = new Set(personalStores(dateIso));
    document.querySelectorAll("#paletteContent [data-store]").forEach(function (group) {
      group.style.display = allowed.has(group.dataset.store) ? "block" : "none";
    });

    document.getElementById("paletteOverlay").style.display = "block";
    document.body.classList.add("palette-open");
    setTimeout(function () {
      var rect = element.getBoundingClientRect();
      if (rect.bottom > window.innerHeight - (window.innerHeight * 0.38)) {
        window.scrollBy({
          top: rect.bottom - (window.innerHeight - (window.innerHeight * 0.4)),
          behavior: "smooth"
        });
      }
    }, 10);
  };

  window.createCustomStamp = function (targetStore) {
    var label = prompt("出勤と退勤時間を4桁の数字で入力してください\n（例：1117）");
    if (!label) return;
    if (label.length === 3) label = "0" + label;
    var match = label.match(/^(\d{2})(\d{2})$/);
    if (!match) { alert("4桁の数字で入力してください（例：1117）"); return; }
    var hours = parseInt(match[2], 10) - parseInt(match[1], 10);
    if (hours <= 0) { alert("正しい時間を入力してください"); return; }

    var color = storeColor(targetStore, hours >= 5.5);
    var finalLabel = targetStore + label;
    var stampData = {
      label: finalLabel,
      color: color,
      store: targetStore,
      text: targetStore + "<br>" + label
    };
    if (!myCustomStamps.some(function (stamp) { return stamp.label === finalLabel && stamp.store === targetStore; })) {
      myCustomStamps.push(stampData);
      localStorage.setItem("my_custom_stamps", JSON.stringify(myCustomStamps));
    }
    applyShift(finalLabel, color, targetStore);
    closePalette();
  };

  window.shiftSeatCountForStore = seatCountForStore;

  try {
    if (Array.isArray(globalUsersData) && globalUsersData.length) applyPermissions();
    console.info("Shift dynamic store UI loaded", VERSION);
  } catch (error) {
    console.error("Shift dynamic store UI failed", error);
  }
})();