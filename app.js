const archiveConfig = {
  endpoint: "/api/archive"
};

const elements = {
  folderList: document.querySelector("#folderList"),
  folderTitle: document.querySelector("#folderTitle"),
  countText: document.querySelector("#countText"),
  gallery: document.querySelector("#gallery"),
  refreshButton: document.querySelector("#refreshButton"),
  sortButton: document.querySelector("#sortButton"),
  sortIcon: document.querySelector("#sortIcon"),
  sortLabel: document.querySelector("#sortLabel"),
  sourceStatus: document.querySelector("#sourceStatus"),
  userName: document.querySelector("#userName"),
  userInitial: document.querySelector("#userInitial"),
  viewer: document.querySelector("#viewer"),
  viewerImage: document.querySelector("#viewerImage"),
  viewerTitle: document.querySelector("#viewerTitle"),
  viewerMeta: document.querySelector("#viewerMeta")
};

let archivePhotos = [];
let folderCounts = new Map();
let folders = [];
let photos = [];
let selectedFolder = new URLSearchParams(location.search).get("folder") || "";
let newestFirst = true;
let activeIndex = 0;

const archiveSource = {
  async list() {
    const response = await fetch(archiveConfig.endpoint, { cache: "no-store" });
    if (!response.ok) throw new Error(`Archive request failed (${response.status})`);
    return response.json();
  }
};

function displayName(value) {
  return value.replaceAll("-", " ").replaceAll("_", " ");
}

function imageCount(folder) {
  return folderCounts.get(folder) || 0;
}

function parseFilenameDate(name) {
  const match = name.match(/(20\d{2}|19\d{2})[-_. ]?([01]\d)[-_. ]?([0-3]\d)[-_ ]?([0-2]\d)?([0-5]\d)?([0-5]\d)?/);
  if (!match) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00"] = match;
  const value = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`).getTime();
  return Number.isNaN(value) ? null : value;
}

function formatDate(timestamp) {
  if (!timestamp) return "Timestamp unavailable";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

async function loadIdentity() {
  try {
    const response = await fetch("/.auth/me", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Identity endpoint unavailable");
    const { clientPrincipal } = await response.json();
    if (!clientPrincipal) {
      location.replace("/login.html");
      return;
    }
    const label = clientPrincipal.userDetails || "Signed in";
    elements.userName.textContent = label;
    elements.userInitial.textContent = label.trim().charAt(0).toUpperCase() || "U";
  } catch {
    if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      location.replace("/login.html");
    }
  }
}

async function loadArchive() {
  elements.folderTitle.textContent = "Loading";
  elements.countText.textContent = "Loading your archive...";
  elements.gallery.replaceChildren();
  elements.sourceStatus.textContent = "Connecting...";
  try {
    const archive = await archiveSource.list();
    const folderData = Array.isArray(archive.folders) ? archive.folders : [];
    archivePhotos = Array.isArray(archive.photos) ? archive.photos : [];
    folderCounts = new Map(folderData.map((folder) => [folder.name, folder.count]));
    folders = folderData.map((folder) => folder.name).filter(Boolean);
    elements.sourceStatus.textContent = "Blob storage connected";
    renderFolders();
    await selectFolder(folders.includes(selectedFolder) ? selectedFolder : folders[0] || "");
  } catch (error) {
    elements.sourceStatus.textContent = "Blob storage unavailable";
    elements.folderTitle.textContent = "Unavailable";
    elements.countText.textContent = "The archive could not be loaded.";
    renderEmpty(error.message);
  }
}

function renderFolders() {
  elements.folderList.replaceChildren();
  if (!folders.length) {
    const message = document.createElement("p");
    message.className = "summary";
    message.textContent = "No folders yet";
    elements.folderList.append(message);
    return;
  }
  for (const folder of folders) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `folder-item${folder === selectedFolder ? " active" : ""}`;
    button.setAttribute("aria-current", folder === selectedFolder ? "page" : "false");
    button.addEventListener("click", () => selectFolder(folder));

    const icon = document.createElement("span");
    icon.className = "folder-icon";
    icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "folder-name";
    name.textContent = displayName(folder);
    const count = document.createElement("span");
    count.className = "folder-count";
    count.textContent = imageCount(folder);
    button.append(icon, name, count);
    elements.folderList.append(button);
  }
}

async function selectFolder(folder) {
  selectedFolder = folder;
  renderFolders();
  const url = new URL(location.href);
  folder ? url.searchParams.set("folder", folder) : url.searchParams.delete("folder");
  history.replaceState(null, "", url);
  if (!folder) {
    photos = [];
    elements.folderTitle.textContent = "No folders";
    elements.countText.textContent = "Your archive is ready for its first folder.";
    renderEmpty("Uploaded workstation folders will appear here.");
    return;
  }

  elements.folderTitle.textContent = displayName(folder);
  elements.countText.textContent = `Loading ${displayName(folder)}...`;
  photos = archivePhotos
    .filter((item) => item.folder === folder)
    .map((item) => ({
      path: item.path,
      name: item.name || item.path.split("/").pop(),
      url: item.url,
      timestamp: Date.parse(item.timestamp) || parseFilenameDate(item.path)
    }));
  sortPhotos();
  renderGallery();
}

function sortPhotos() {
  photos.sort((a, b) => {
    const first = a.timestamp || 0;
    const second = b.timestamp || 0;
    return newestFirst ? second - first || a.name.localeCompare(b.name) : first - second || a.name.localeCompare(b.name);
  });
}

function renderGallery() {
  elements.gallery.replaceChildren();
  if (!photos.length) {
    elements.countText.textContent = `No images found in ${displayName(selectedFolder)}.`;
    renderEmpty("This folder does not contain any supported images yet.");
    return;
  }

  elements.countText.textContent = `${photos.length} photo${photos.length === 1 ? "" : "s"} · ${newestFirst ? "newest first" : "oldest first"}`;
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
    const caption = document.createElement("span");
    caption.className = "photo-caption";
    const name = document.createElement("span");
    name.className = "photo-name";
    name.textContent = photo.name;
    const time = document.createElement("span");
    time.className = "photo-time";
    time.textContent = formatDate(photo.timestamp);
    frame.append(image);
    caption.append(name, time);
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
  elements.viewerMeta.textContent = `${activeIndex + 1} of ${photos.length} · ${formatDate(photo.timestamp)}`;
}

function moveViewer(direction) {
  if (!photos.length) return;
  activeIndex = (activeIndex + direction + photos.length) % photos.length;
  updateViewer();
}

elements.sortButton.addEventListener("click", () => {
  newestFirst = !newestFirst;
  elements.sortIcon.textContent = newestFirst ? "↓" : "↑";
  elements.sortLabel.textContent = newestFirst ? "Newest first" : "Oldest first";
  sortPhotos();
  renderGallery();
});
elements.refreshButton.addEventListener("click", loadArchive);
document.querySelector("#closeButton").addEventListener("click", () => elements.viewer.close());
document.querySelector("#prevButton").addEventListener("click", () => moveViewer(-1));
document.querySelector("#nextButton").addEventListener("click", () => moveViewer(1));
elements.viewer.addEventListener("click", (event) => {
  if (event.target === elements.viewer) elements.viewer.close();
});
document.addEventListener("keydown", (event) => {
  if (!elements.viewer.open) return;
  if (event.key === "ArrowLeft") moveViewer(-1);
  if (event.key === "ArrowRight") moveViewer(1);
});

loadIdentity();
loadArchive();
