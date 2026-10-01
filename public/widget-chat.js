(function () {
  var id = window.WIDGET_ID, KEY = "chat-session-" + id;
  function newSession() { var a = new Uint8Array(18); crypto.getRandomValues(a); return Array.from(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join(""); }
  var session = null;
  try { session = localStorage.getItem(KEY); } catch (e) {}
  if (!session) { session = newSession(); try { localStorage.setItem(KEY, session); } catch (e) {} }
  var msgs = document.getElementById("msgs"), form = document.getElementById("f"), input = document.getElementById("t");
  function linkify(el, text) {
    el.textContent = "";
    var re = /https?:\/\/[^\s<>"')]+[^\s<>"').,!?]/g, last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = document.createElement("a"); a.href = m[0]; a.textContent = m[0].length > 48 ? m[0].slice(0, 45) + "…" : m[0];
      a.target = "_blank"; a.rel = "noopener noreferrer"; el.appendChild(a); last = m.index + m[0].length;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
  }
  function add(cls, text) { var d = document.createElement("div"); d.className = "m " + cls; linkify(d, text); msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; }
  form.addEventListener("submit", function (e) {
    e.preventDefault(); var text = input.value.trim(); if (!text) return;
    add("u", text); input.value = ""; input.disabled = true; form.querySelector("button").disabled = true;
    var t = document.createElement("div"); t.className = "m b"; t.innerHTML = '<span class="typing" aria-label="Typing"><i></i><i></i><i></i></span>';
    msgs.appendChild(t); msgs.scrollTop = msgs.scrollHeight;
    fetch("/w/" + id + "/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: session, text: text }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { linkify(t, j.reply || j.error || "Sorry, no reply."); })
      .catch(function () { t.textContent = "Network error. Please try again."; })
      .finally(function () { input.disabled = false; form.querySelector("button").disabled = false; input.focus(); msgs.scrollTop = msgs.scrollHeight; });
  });
  document.getElementById("reset").addEventListener("click", function () {
    fetch("/w/" + id + "/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: session }) });
    session = newSession(); try { localStorage.setItem(KEY, session); } catch (e) {}
    while (msgs.children.length > 1) msgs.removeChild(msgs.lastChild);
  });
  input.focus();
})();
