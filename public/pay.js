(function () {
  // Live countdown for the payment hold.
  var cd = document.querySelector("[data-countdown]");
  if (cd) {
    var end = +cd.getAttribute("data-countdown");
    var t = setInterval(function () {
      var left = Math.max(0, end - Date.now()), m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
      cd.textContent = m + ":" + (s < 10 ? "0" : "") + s;
      if (!left) clearInterval(t);
    }, 1000);
  }
  // Reload once the payment is confirmed (the webhook may land while this page is open).
  var poll = document.querySelector("[data-poll]");
  if (poll) {
    var url = poll.getAttribute("data-poll");
    setInterval(function () {
      fetch(url, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (j) {
        var upi = poll.hasAttribute("data-poll-upi");
        if (j && (j.pay_status === "paid" || (upi ? j.status === "cancelled" : j.status !== "held"))) location.reload();
      }).catch(function () {});
    }, 5000);
  }

  // Payment screenshot: shrink big phone photos before sending.
  var pf = document.querySelector("[data-proof]");
  if (pf) {
    var input = pf.querySelector("input[type=file]"), label = pf.querySelector("label");
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      if (!f) return;
      label.classList.add("busy");
      label.lastChild.textContent = "Checking your screenshot…";
      shrink(f, function (blob) {
        var fd = new FormData();
        fd.append("shot", blob, "screenshot.jpg");
        fetch(pf.action, { method: "POST", body: fd }).then(function () { location.reload(); }, function () { pf.submit(); });
      });
    });
  }
  function shrink(file, done) {
    if (!/^image\//.test(file.type) || file.size < 400 * 1024) return done(file);
    var img = new Image(), url = URL.createObjectURL(file);
    img.onload = function () {
      var max = 1800, w = img.width, h = img.height, k = Math.min(1, max / Math.max(w, h));
      var c = document.createElement("canvas");
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob(function (b) { done(b || file); }, "image/jpeg", 0.88);
    };
    img.onerror = function () { done(file); };
    img.src = url;
  }
})();
