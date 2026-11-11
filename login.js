const form = document.querySelector("#loginForm");
const password = document.querySelector("#password");
const status = document.querySelector("#loginStatus");
const button = document.querySelector("#loginButton");
const requestedPath = new URLSearchParams(location.search).get("return") || "/";
const returnPath = requestedPath.startsWith("/") && !requestedPath.startsWith("//") ? requestedPath : "/";

async function sessionIsActive() {
  const response = await fetch("/api/session", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) return false;
  return Boolean((await response.json()).authenticated);
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
    location.replace(returnPath);
  } catch (error) {
    password.select();
    status.textContent = error.message;
    button.disabled = false;
    button.textContent = "Enter archive";
  }
});
