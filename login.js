const form = document.querySelector("#loginForm");
const status = document.querySelector("#loginStatus");
const button = document.querySelector("#loginButton");

async function checkSession() {
  try {
    const response = await fetch("/api/session", { cache: "no-store", credentials: "same-origin" });
    if (response.ok) location.replace("/");
  } catch {
    status.textContent = "The authentication service is unavailable.";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "";
  button.disabled = true;
  button.textContent = "Signing in…";
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Sign-in failed.");
    location.replace("/");
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
    button.textContent = "Enter archive";
    form.password.select();
  }
});

checkSession();
