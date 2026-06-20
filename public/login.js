// Login page bootstrap. Reads ?error=… and ?returnTo=… from the URL,
// surfaces any error message to the user, and threads returnTo through to
// /auth/login so we land back where we came from.
(function () {
  const params = new URLSearchParams(location.search);

  const err = params.get("error");
  if (err) {
    const box = document.getElementById("login-error");
    if (box) {
      // textContent — never innerHTML — so server-supplied messages cannot
      // become script even if they make it past server-side sanitisation.
      box.textContent = err;
      box.hidden = false;
    }
  }

  const returnTo = params.get("returnTo");
  if (returnTo && returnTo.length > 0 && returnTo.length < 512) {
    // Only allow same-site, absolute paths; the server validates again but we
    // shouldn't even build a hostile URL on the client.
    if (returnTo.startsWith("/") && returnTo.charAt(1) !== "/" && !returnTo.includes("\\")) {
      const btn = document.getElementById("login-btn");
      if (btn) {
        btn.href = "/auth/login?returnTo=" + encodeURIComponent(returnTo);
      }
    }
  }
})();
