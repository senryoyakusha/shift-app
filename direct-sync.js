(function () {
  "use strict";

  var BOOTSTRAP_VERSION = "2026-09-04.3";
  var scripts = [
    "./direct-sync-core.js?v=" + encodeURIComponent(BOOTSTRAP_VERSION),
    "./direct-recovery.js?v=" + encodeURIComponent(BOOTSTRAP_VERSION)
  ];

  function loadSequentially(index) {
    if (index >= scripts.length) return;
    var script = document.createElement("script");
    script.src = scripts[index];
    script.async = false;
    script.onload = function () { loadSequentially(index + 1); };
    script.onerror = function () {
      console.error("Shift v2 bootstrap failed to load", scripts[index]);
    };
    (document.head || document.documentElement).appendChild(script);
  }

  loadSequentially(0);
})();
