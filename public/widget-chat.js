(function () {
  var id = window.WIDGET_ID, KEY = "chat-session-" + id;
  function newSession() { var a = new Uint8Array(18); crypto.getRandomValues(a); return Array.from(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  var session = null;
  try { session = localStorage.getItem(KEY); } catch (e) {}
  if (!session) { session = newSession(); try { localStorage.setItem(KEY, session); } catch (e) {} }
  var msgs = document.getElementById("msgs"), form = document.getElementById("f"), input = document.getElementById("t");
  function add(cls, text) { var d = document.createElement("div"); d.className = "m " + cls; d.textContent = text; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; }
  form.addEventListener("submit", function (e) {
    e.preventDefault(); var text = input.value.trim(); if (!text) return;
    add("u", text); input.value = ""; input.disabled = true;
    var t = add("b typing", "typing…");
    fetch("/w/" + id + "/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: session, text: text }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { t.className = "m b"; t.textContent = j.reply || j.error || "Sorry, no reply."; })
      .catch(function () { t.className = "m b"; t.textContent = "Network error. Please try again."; })
      .finally(function () { input.disabled = false; input.focus(); msgs.scrollTop = msgs.scrollHeight; });
  });
  document.getElementById("reset").addEventListener("click", function () {
    fetch("/w/" + id + "/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: session }) });
    session = newSession(); try { localStorage.setItem(KEY, session); } catch (e) {}
    while (msgs.children.length > 1) msgs.removeChild(msgs.lastChild);
  });
  input.focus();
})();
