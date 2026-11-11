import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError
from azure.storage.blob import BlobSasPermissions, BlobServiceClient, generate_blob_sas

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

DEFAULT_CONTAINER = "windows"
AUTH_COOKIE = "dl_session"
IMAGE_PATTERN = re.compile(r"\.(avif|gif|heic|jpeg|jpg|png|webp)$", re.I)
FOLDER_PATTERN = re.compile(r"^[^/\\]{1,128}$")
FOLDER_CACHE = {"expires": 0.0, "folders": []}
FOLDER_CACHE_LOCK = threading.Lock()
LOGIN_ATTEMPTS = defaultdict(deque)


def b64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt_text, digest_text = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        salt = b64url_decode(salt_text)
        expected = b64url_decode(digest_text)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(iterations))
        return hmac.compare_digest(actual, expected)
    except (TypeError, ValueError):
        return False


def session_secret() -> bytes:
    value = os.getenv("SESSION_SECRET", "")
    if len(value) < 32:
        raise RuntimeError("SESSION_SECRET must contain at least 32 characters")
    return value.encode()


def create_session(username: str) -> str:
    payload = {
        "u": username,
        "exp": int(time.time()) + int(os.getenv("SESSION_HOURS", "12")) * 3600,
        "n": secrets.token_urlsafe(8),
    }
    encoded = b64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    signature = b64url_encode(hmac.new(session_secret(), encoded.encode(), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def authenticated_username(req: func.HttpRequest):
    try:
        cookie = SimpleCookie(req.headers.get("Cookie", ""))
        token = cookie.get(AUTH_COOKIE)
        if not token or "." not in token.value:
            return None
        encoded, supplied_signature = token.value.split(".", 1)
        expected_signature = b64url_encode(
            hmac.new(session_secret(), encoded.encode(), hashlib.sha256).digest()
        )
        if not hmac.compare_digest(supplied_signature, expected_signature):
            return None
        payload = json.loads(b64url_decode(encoded))
        if int(payload.get("exp", 0)) <= int(time.time()):
            return None
        username = str(payload.get("u", ""))
        return username if hmac.compare_digest(username, os.getenv("APP_USERNAME", "redteam")) else None
    except (ValueError, TypeError, json.JSONDecodeError, RuntimeError):
        return None


def client_ip(req: func.HttpRequest) -> str:
    forwarded = req.headers.get("X-Forwarded-For", "")
    return forwarded.split(",", 1)[0].strip() or "unknown"


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


@app.route(route="login", methods=["POST"])
def login(req: func.HttpRequest) -> func.HttpResponse:
    ip_address = client_ip(req)
    now = time.time()
    attempts = LOGIN_ATTEMPTS[ip_address]
    while attempts and attempts[0] < now - 300:
        attempts.popleft()
    if len(attempts) >= 8:
        return json_response({"error": "Too many attempts. Try again in five minutes."}, 429)

    try:
        payload = req.get_json()
    except ValueError:
        payload = {}
    expected_username = os.getenv("APP_USERNAME", "redteam")
    valid_username = hmac.compare_digest(str(payload.get("username", "")), expected_username)
    valid_password = verify_password(
        str(payload.get("password", "")), os.getenv("APP_PASSWORD_HASH", "")
    )
    if not (valid_username and valid_password):
        attempts.append(now)
        return json_response({"error": "Invalid username or password."}, 401)

    LOGIN_ATTEMPTS.pop(ip_address, None)
    max_age = int(os.getenv("SESSION_HOURS", "12")) * 3600
    cookie = (
        f"{AUTH_COOKIE}={create_session(expected_username)}; Path=/; Max-Age={max_age}; "
        "HttpOnly; Secure; SameSite=Strict"
    )
    return json_response({"authenticated": True, "username": expected_username}, headers={"Set-Cookie": cookie})


@app.route(route="session", methods=["GET"])
def session(req: func.HttpRequest) -> func.HttpResponse:
    username = authenticated_username(req)
    if not username:
        return json_response({"authenticated": False}, 401)
    return json_response({"authenticated": True, "username": username})


@app.route(route="logout", methods=["POST"])
def logout(req: func.HttpRequest) -> func.HttpResponse:
    cookie = f"{AUTH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"
    return json_response({"authenticated": False}, headers={"Set-Cookie": cookie})


@app.route(route="archive", methods=["GET"])
def archive(req: func.HttpRequest) -> func.HttpResponse:
    if not authenticated_username(req):
        return json_response({"error": "Authentication required"}, 401)

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


def json_response(payload, status_code=200, headers=None):
    response_headers = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    }
    response_headers.update(headers or {})
    return func.HttpResponse(
        json.dumps(payload),
        status_code=status_code,
        mimetype="application/json",
        headers=response_headers,
    )
