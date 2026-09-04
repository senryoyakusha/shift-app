(function () {
  "use strict";

  var BOOTSTRAP_VERSION = "2026-09-04.2";
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

  if (document.readyState === "loading") {
    scripts.forEach(function (src) {
      document.write('<script src="' + src + '"><\\/script>');
    });
  } else {
    loadSequentially(0);
  }
})();
