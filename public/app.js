(function () {
  // Copy buttons
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-copy]");
    if (!b) return;
    navigator.clipboard.writeText(b.getAttribute("data-copy")).then(function () {
      var t = b.textContent; b.textContent = "Copied ✓"; setTimeout(function () { b.textContent = t; }, 1500);
    });
  });
  // Confirm dialogs + busy state on slow forms
  document.addEventListener("submit", function (e) {
    var f = e.target;
    var c = f.getAttribute("data-confirm");
    if (c && !window.confirm(c)) { e.preventDefault(); return; }
    var busy = f.getAttribute("data-busy");
    if (busy) { var btn = f.querySelector("button:not([type=button])"); if (btn) { btn.disabled = true; btn.textContent = busy; } }
  });

  // Test chat
  var chat = document.getElementById("chat");
  if (!chat) return;
  var msgs = chat.querySelector(".msgs"), form = chat.querySelector("form"), input = form.querySelector("input");
  var csrf = chat.getAttribute("data-csrf");
  function add(cls, text) { var d = document.createElement("div"); d.className = "m " + cls; d.textContent = text; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; }
  function send(text) {
    if (!text) return;
    add("u", text); input.value = ""; input.disabled = true;
    var typing = add("b", "…");
    fetch(chat.getAttribute("data-endpoint"), { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: JSON.stringify({ text: text }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { typing.textContent = j.reply || j.error || "No reply"; })
      .catch(function () { typing.textContent = "Network error. Try again."; })
      .finally(function () { input.disabled = false; input.focus(); msgs.scrollTop = msgs.scrollHeight; });
  }
  form.addEventListener("submit", function (e) { e.preventDefault(); send(input.value.trim()); });
  document.querySelectorAll("[data-suggest]").forEach(function (b) { b.addEventListener("click", function () { send(b.getAttribute("data-suggest")); }); });
  var reset = document.querySelector("[data-chat-reset]");
  if (reset) reset.addEventListener("click", function () {
    fetch(chat.getAttribute("data-reset"), { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: "{}" })
      .then(function () { msgs.innerHTML = ""; add("b", "Started a new conversation."); });
  });
  add("b", "Hi! I'm your booking assistant. Try one of the suggestions above, or type anything.");
})();
