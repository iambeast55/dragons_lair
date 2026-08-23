async function redirectSignedInUser() {
  try {
    const response = await fetch("/.auth/me", { credentials: "same-origin" });
    if (!response.ok) return;
    const { clientPrincipal } = await response.json();
    if (clientPrincipal) location.replace("/");
  } catch {
    const status = document.querySelector("#loginStatus");
    if (status && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      status.textContent = "Microsoft sign-in becomes active after deployment to Azure.";
    }
  }
}

redirectSignedInUser();
