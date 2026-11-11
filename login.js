const form = document.querySelector("#loginForm");
const password = document.querySelector("#password");
const status = document.querySelector("#loginStatus");
const button = document.querySelector("#loginButton");
const sessionKey = "dragons_lair_session";
const requestedPath = new URLSearchParams(location.search).get("return") || "/";
const returnPath = requestedPath.startsWith("/") && !requestedPath.startsWith("//") ? requestedPath : "/";

async function sessionIsActive() {
  const token = sessionStorage.getItem(sessionKey);
  if (!token) return false;
  const response = await fetch("/api/session", {
    cache: "no-store",
    headers: { "X-Archive-Session": token }
  });
  if (!response.ok) return false;
  const active = Boolean((await response.json()).authenticated);
  if (!active) sessionStorage.removeItem(sessionKey);
  return active;
}

sessionIsActive().then((active) => {
  if (active) location.replace(returnPath);
}).catch(() => {});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "";
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: password.value })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Sign-in failed");
    if (!payload.token) throw new Error("The server did not create a session");
    sessionStorage.setItem(sessionKey, payload.token);
    location.replace(returnPath);
  } catch (error) {
    password.select();
    status.textContent = error.message;
    button.disabled = false;
    button.textContent = "Enter archive";
  }
});
