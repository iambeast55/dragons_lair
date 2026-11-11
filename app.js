const PAGE_SIZE = 36;
const TEAM_BY_OCTET = window.DRAGONS_LAIR_TEAM_BY_OCTET;

const elements = {
  folderList: document.querySelector("#folderList"),
  folderSearch: document.querySelector("#folderSearch"),
  folderTitle: document.querySelector("#folderTitle"),
  teamLabel: document.querySelector("#teamLabel"),
  countText: document.querySelector("#countText"),
  gallery: document.querySelector("#gallery"),
  refreshButton: document.querySelector("#refreshButton"),
  sortButton: document.querySelector("#sortButton"),
  sortIcon: document.querySelector("#sortIcon"),
  sortLabel: document.querySelector("#sortLabel"),
  sourceStatus: document.querySelector("#sourceStatus"),
  userName: document.querySelector("#userName"),
  userInitial: document.querySelector("#userInitial"),
  logoutButton: document.querySelector("#logoutButton"),
  hostCount: document.querySelector("#hostCount"),
  photoCount: document.querySelector("#photoCount"),
  pagination: document.querySelector("#pagination"),
  previousPage: document.querySelector("#previousPage"),
  nextPage: document.querySelector("#nextPage"),
  pageStatus: document.querySelector("#pageStatus"),
  viewer: document.querySelector("#viewer"),
  viewerImage: document.querySelector("#viewerImage"),
  viewerTitle: document.querySelector("#viewerTitle"),
  viewerMeta: document.querySelector("#viewerMeta")
};

let folderData = [];
let photos = [];
let selectedFolder = new URLSearchParams(location.search).get("folder") || "";
let newestFirst = new URLSearchParams(location.search).get("sort") !== "oldest";
let currentPage = Math.max(1, Number(new URLSearchParams(location.search).get("page")) || 1);
let totalPages = 1;
let activeIndex = 0;

function teamForFolder(folder) {
  const parts = folder.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return { number: null, label: "Other networks", prefix: "Unmapped", order: 999 };
  }
  if (parts[0] !== 10 || parts[1] !== 0) {
    return { number: null, label: "Other networks", prefix: "Unmapped", order: 999 };
  }
  const number = TEAM_BY_OCTET.get(parts[2]) || 68;
  return {
    number,
    label: `Team ${number}`,
    prefix: number === 68 ? "10.0" : `10.0.${parts[2]}`,
    order: number
  };
}

function ipSort(first, second) {
  return first.name.localeCompare(second.name, undefined, { numeric: true });
}

function groupFolders() {
  const groups = new Map();
  for (const folder of folderData) {
    const team = teamForFolder(folder.name);
    const key = team.number === null ? "other" : `team-${team.number}`;
    if (!groups.has(key)) groups.set(key, { ...team, folders: [], count: 0 });
    const group = groups.get(key);
    group.folders.push(folder);
    group.count += folder.count;
  }
  return [...groups.values()]
    .map((group) => ({ ...group, folders: group.folders.sort(ipSort) }))
    .sort((a, b) => a.order - b.order);
}

function formatDate(timestamp) {
  if (!timestamp) return "Timestamp unavailable";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit"
  }).format(new Date(timestamp));
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", ...options });
  if (response.status === 401) {
    location.replace("/login.html");
    throw new Error("Authentication required");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function loadIdentity() {
  const identity = await api("/api/session");
  const label = identity.username || "Signed in";
  elements.userName.textContent = label;
  elements.userInitial.textContent = label.charAt(0).toUpperCase() || "U";
}

async function loadFolders(force = false) {
  elements.sourceStatus.textContent = "Loading archive…";
  const query = force ? "?refresh=1" : "";
  const archive = await api(`/api/archive${query}`);
  folderData = Array.isArray(archive.folders) ? archive.folders : [];
  folderData.sort(ipSort);
  elements.hostCount.textContent = folderData.length;
  elements.photoCount.textContent = folderData.reduce((sum, folder) => sum + Number(folder.count || 0), 0);
  elements.sourceStatus.textContent = "Blob storage connected";
  if (!folderData.some((folder) => folder.name === selectedFolder)) {
    selectedFolder = folderData[0]?.name || "";
    currentPage = 1;
  }
  renderFolders();
  await loadPhotos();
}

function renderFolders() {
  elements.folderList.replaceChildren();
  const groups = groupFolders();
  if (!groups.length) {
    const message = document.createElement("p");
    message.className = "summary";
    message.textContent = "No IP folders found";
    elements.folderList.append(message);
    return;
  }

  for (const group of groups) {
    const details = document.createElement("details");
    details.className = "team-group";
    details.dataset.search = `${group.label} ${group.prefix} ${group.folders.map((folder) => folder.name).join(" ")}`.toLowerCase();
    details.open = group.folders.some((folder) => folder.name === selectedFolder);
    const summary = document.createElement("summary");
    const title = document.createElement("span");
    title.innerHTML = `<strong>${group.label}</strong><small>${group.prefix}</small>`;
    const stats = document.createElement("span");
    stats.className = "group-stats";
    stats.textContent = `${group.folders.length} hosts · ${group.count} shots`;
    summary.append(title, stats);
    const links = document.createElement("div");
    links.className = "folder-links";
    for (const folder of group.folders) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `folder-item${folder.name === selectedFolder ? " active" : ""}`;
      button.dataset.folder = folder.name;
      button.innerHTML = `<span class="folder-icon" aria-hidden="true"></span><span class="folder-name"></span><span class="folder-count">${folder.count}</span>`;
      button.querySelector(".folder-name").textContent = folder.name;
      button.addEventListener("click", () => selectFolder(folder.name));
      links.append(button);
    }
    details.append(summary, links);
    elements.folderList.append(details);
  }
}

async function selectFolder(folder) {
  selectedFolder = folder;
  currentPage = 1;
  renderFolders();
  await loadPhotos();
}

async function loadPhotos() {
  updateLocation();
  if (!selectedFolder) {
    photos = [];
    elements.folderTitle.textContent = "No folders";
    elements.teamLabel.textContent = "Archive";
    renderEmpty("Uploaded workstation folders will appear here.");
    return;
  }
  const team = teamForFolder(selectedFolder);
  elements.folderTitle.textContent = selectedFolder;
  elements.teamLabel.textContent = `${team.label} · ${team.prefix}`;
  elements.countText.textContent = "Loading screenshots…";
  elements.gallery.replaceChildren();
  const query = new URLSearchParams({
    folder: selectedFolder,
    page: String(currentPage),
    pageSize: String(PAGE_SIZE),
    sort: newestFirst ? "newest" : "oldest"
  });
  try {
    const archive = await api(`/api/archive?${query}`);
    photos = Array.isArray(archive.photos) ? archive.photos : [];
    currentPage = archive.page || 1;
    totalPages = archive.totalPages || 1;
    elements.countText.textContent = `${archive.total || 0} screenshots · ${newestFirst ? "newest" : "oldest"} first`;
    renderGallery();
    renderPagination();
    updateLocation();
  } catch (error) {
    elements.countText.textContent = "The archive could not be loaded.";
    renderEmpty(error.message);
  }
}

function updateLocation() {
  const url = new URL(location.href);
  selectedFolder ? url.searchParams.set("folder", selectedFolder) : url.searchParams.delete("folder");
  url.searchParams.set("sort", newestFirst ? "newest" : "oldest");
  url.searchParams.set("page", String(currentPage));
  history.replaceState(null, "", url);
}

function renderGallery() {
  elements.gallery.replaceChildren();
  if (!photos.length) return renderEmpty("This folder does not contain images on this page.");
  photos.forEach((photo, index) => {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = "photo-tile";
    tile.addEventListener("click", () => openViewer(index));
    const frame = document.createElement("span");
    frame.className = "photo-frame";
    const image = document.createElement("img");
    image.src = photo.url;
    image.alt = photo.name;
    image.loading = "lazy";
    image.decoding = "async";
    const caption = document.createElement("span");
    caption.className = "photo-caption";
    const name = document.createElement("span");
    name.className = "photo-name";
    name.textContent = photo.name;
    const timestamp = document.createElement("span");
    timestamp.className = "photo-time";
    timestamp.textContent = formatDate(photo.timestamp);
    frame.append(image);
    caption.append(name, timestamp);
    tile.append(frame, caption);
    elements.gallery.append(tile);
  });
}

function renderEmpty(message) {
  elements.gallery.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const copy = document.createElement("p");
  copy.textContent = message;
  empty.append(copy);
  elements.gallery.append(empty);
  elements.pagination.hidden = true;
}

function renderPagination() {
  elements.pagination.hidden = totalPages <= 1;
  elements.previousPage.disabled = currentPage <= 1;
  elements.nextPage.disabled = currentPage >= totalPages;
  elements.pageStatus.textContent = `Page ${currentPage} of ${totalPages}`;
}

function openViewer(index) {
  activeIndex = index;
  updateViewer();
  elements.viewer.showModal();
}

function updateViewer() {
  const photo = photos[activeIndex];
  if (!photo) return;
  elements.viewerImage.src = photo.url;
  elements.viewerImage.alt = photo.name;
  elements.viewerTitle.textContent = photo.name;
  elements.viewerMeta.textContent = `${activeIndex + 1} of ${photos.length} on page ${currentPage} · ${formatDate(photo.timestamp)}`;
}

function moveViewer(direction) {
  if (!photos.length) return;
  activeIndex = (activeIndex + direction + photos.length) % photos.length;
  updateViewer();
}

elements.folderSearch.addEventListener("input", () => {
  const query = elements.folderSearch.value.trim().toLowerCase();
  document.querySelectorAll(".team-group").forEach((group) => {
    group.hidden = query && !group.dataset.search.includes(query);
    if (query && !group.hidden) group.open = true;
  });
});
elements.sortButton.addEventListener("click", async () => {
  newestFirst = !newestFirst;
  currentPage = 1;
  elements.sortIcon.textContent = newestFirst ? "↓" : "↑";
  elements.sortLabel.textContent = newestFirst ? "Newest first" : "Oldest first";
  await loadPhotos();
});
elements.refreshButton.addEventListener("click", () => loadFolders(true));
elements.previousPage.addEventListener("click", async () => { currentPage -= 1; await loadPhotos(); elements.gallery.scrollIntoView(); });
elements.nextPage.addEventListener("click", async () => { currentPage += 1; await loadPhotos(); elements.gallery.scrollIntoView(); });
elements.logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
  location.replace("/login.html");
});
document.querySelector("#closeButton").addEventListener("click", () => elements.viewer.close());
document.querySelector("#prevButton").addEventListener("click", () => moveViewer(-1));
document.querySelector("#nextButton").addEventListener("click", () => moveViewer(1));
elements.viewer.addEventListener("click", (event) => { if (event.target === elements.viewer) elements.viewer.close(); });
document.addEventListener("keydown", (event) => {
  if (!elements.viewer.open) return;
  if (event.key === "ArrowLeft") moveViewer(-1);
  if (event.key === "ArrowRight") moveViewer(1);
});

Promise.all([loadIdentity(), loadFolders()]).catch((error) => {
  if (error.message !== "Authentication required") {
    elements.sourceStatus.textContent = "Archive unavailable";
    renderEmpty(error.message);
  }
});
