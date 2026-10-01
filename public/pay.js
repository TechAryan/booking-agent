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
        if (j && (j.pay_status === "paid" || j.status !== "held")) location.reload();
      }).catch(function () {});
    }, 5000);
  }
})();
