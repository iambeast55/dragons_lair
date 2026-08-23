const archiveConfig = {
  owner: "iambeast55",
  repo: "dragons_lair",
  branch: "master",
  rootFolder: "windows"
};

const imagePattern = /\.(avif|gif|heic|jpeg|jpg|png|webp)$/i;
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

let tree = [];
let folders = [];
let photos = [];
let selectedFolder = new URLSearchParams(location.search).get("folder") || "";
let newestFirst = true;
let activeIndex = 0;

function githubApi(path) {
  return `https://api.github.com/repos/${archiveConfig.owner}/${archiveConfig.repo}/${path}`;
}

function githubRaw(path) {
  const safePath = encodeURIComponent(path).replaceAll("%2F", "/");
  return `https://raw.githubusercontent.com/${archiveConfig.owner}/${archiveConfig.repo}/${archiveConfig.branch}/${safePath}`;
}

// Replace only this data source when the archive moves to Azure Blob Storage.
const archiveSource = {
  async list() {
    const response = await fetch(githubApi(`git/trees/${archiveConfig.branch}?recursive=1`), {
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!response.ok) throw new Error(`Archive request failed (${response.status})`);
    const data = await response.json();
    return data.tree || [];
  },
  imageUrl(path) {
    return githubRaw(path);
  }
};

function displayName(value) {
  return value.replaceAll("-", " ").replaceAll("_", " ");
}

function folderFromPath(path) {
  return path.slice(archiveConfig.rootFolder.length + 1).split("/")[0] || "";
}

function imageCount(folder) {
  const prefix = `${archiveConfig.rootFolder}/${folder}/`;
  return tree.filter((item) => item.type === "blob" && item.path.startsWith(prefix) && imagePattern.test(item.path)).length;
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
    tree = await archiveSource.list();
    folders = [...new Set(
      tree
        .filter((item) => item.type === "tree" && item.path.startsWith(`${archiveConfig.rootFolder}/`))
        .map((item) => folderFromPath(item.path))
        .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b));
    elements.sourceStatus.textContent = "Archive connected";
    renderFolders();
    await selectFolder(folders.includes(selectedFolder) ? selectedFolder : folders[0] || "");
  } catch (error) {
    elements.sourceStatus.textContent = "Archive unavailable";
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
    renderEmpty("Add an image folder under windows to begin browsing.");
    return;
  }

  elements.folderTitle.textContent = displayName(folder);
  elements.countText.textContent = `Loading ${displayName(folder)}...`;
  const prefix = `${archiveConfig.rootFolder}/${folder}/`;
  photos = tree
    .filter((item) => item.type === "blob" && item.path.startsWith(prefix) && imagePattern.test(item.path))
    .map((item) => ({
      path: item.path,
      name: item.path.split("/").pop(),
      url: archiveSource.imageUrl(item.path),
      timestamp: parseFilenameDate(item.path)
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
