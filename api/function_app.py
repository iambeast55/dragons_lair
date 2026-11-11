import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError
from azure.storage.blob import BlobSasPermissions, BlobServiceClient, generate_blob_sas

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

DEFAULT_CONTAINER = "windows"
IMAGE_PATTERN = re.compile(r"\.(avif|gif|heic|jpeg|jpg|png|webp)$", re.I)
FOLDER_PATTERN = re.compile(r"^[^/\\]{1,128}$")
FOLDER_CACHE = {"expires": 0.0, "folders": []}
FOLDER_CACHE_LOCK = threading.Lock()


def storage_client():
    connection_string = os.getenv("PHOTO_STORAGE_CONNECTION_STRING")
    container_name = os.getenv("PHOTO_STORAGE_CONTAINER", DEFAULT_CONTAINER).strip().lower()
    if not connection_string or not container_name:
        raise RuntimeError("Blob storage is not configured")
    service = BlobServiceClient.from_connection_string(connection_string)
    account_key = getattr(service.credential, "account_key", None)
    if not account_key:
        raise RuntimeError("Storage cannot issue read URLs")
    return service, service.get_container_client(container_name), container_name, account_key


def list_folders(container, force=False):
    now = time.time()
    with FOLDER_CACHE_LOCK:
        if not force and FOLDER_CACHE["expires"] > now:
            return FOLDER_CACHE["folders"]
        counts = {}
        for item in container.list_blobs():
            if not IMAGE_PATTERN.search(item.name) or "/" not in item.name:
                continue
            folder = item.name.split("/", 1)[0]
            if folder:
                counts[folder] = counts.get(folder, 0) + 1
        folders = [{"name": name, "count": count} for name, count in counts.items()]
        FOLDER_CACHE.update(expires=now + 45, folders=folders)
        return folders


@app.route(route="archive", methods=["GET"])
def archive(req: func.HttpRequest) -> func.HttpResponse:
    # Azure Static Web Apps password protection gates this endpoint before it
    # reaches the managed Function.
    try:
        service, container, container_name, account_key = storage_client()
        folder = (req.params.get("folder") or "").strip()
        if not folder:
            folders = list_folders(container, force=req.params.get("refresh") == "1")
            return json_response({"folders": folders})
        if not FOLDER_PATTERN.fullmatch(folder):
            return json_response({"error": "Invalid folder"}, 400)

        try:
            page = max(1, int(req.params.get("page", "1")))
            page_size = max(12, min(72, int(req.params.get("pageSize", "36"))))
        except ValueError:
            return json_response({"error": "Invalid pagination"}, 400)
        newest_first = req.params.get("sort", "newest") != "oldest"

        blobs = [
            item for item in container.list_blobs(name_starts_with=f"{folder}/")
            if IMAGE_PATTERN.search(item.name)
        ]
        blobs.sort(key=lambda item: item.last_modified, reverse=newest_first)
        total = len(blobs)
        total_pages = max(1, (total + page_size - 1) // page_size)
        page = min(page, total_pages)
        selected = blobs[(page - 1) * page_size:page * page_size]
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=20)
        photos = []
        for item in selected:
            sas_token = generate_blob_sas(
                account_name=service.account_name,
                container_name=container_name,
                blob_name=item.name,
                account_key=account_key,
                permission=BlobSasPermissions(read=True),
                expiry=expires_at,
            )
            photos.append({
                "path": item.name,
                "name": item.name.rsplit("/", 1)[-1],
                "timestamp": item.last_modified.isoformat(),
                "url": f"{container.get_blob_client(item.name).url}?{sas_token}",
            })
        return json_response({
            "folder": folder,
            "photos": photos,
            "page": page,
            "pageSize": page_size,
            "total": total,
            "totalPages": total_pages,
        })
    except ResourceNotFoundError:
        return json_response({"folders": [], "photos": []})
    except Exception as error:
        logging.exception("Blob archive request failed: %s", error)
        return json_response({"error": "Blob archive could not be loaded"}, 502)


def json_response(payload, status_code=200):
    return func.HttpResponse(
        json.dumps(payload),
        status_code=status_code,
        mimetype="application/json",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
