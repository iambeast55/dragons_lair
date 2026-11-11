import json
import base64
import binascii
import hashlib
import hmac
import logging
import os
import re
import secrets
import threading
import time
from http.cookies import SimpleCookie
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
LOGIN_ATTEMPTS = {}
LOGIN_ATTEMPTS_LOCK = threading.Lock()
SESSION_COOKIE = "dl_session"
SESSION_TTL_SECONDS = 8 * 60 * 60
LOGIN_WINDOW_SECONDS = 5 * 60
MAX_LOGIN_ATTEMPTS = 8


def base64url_encode(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def base64url_decode(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def password_is_valid(password):
    encoded = os.getenv("ARCHIVE_PASSWORD_HASH", "")
    try:
        algorithm, iterations, salt, expected = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            base64url_decode(salt),
            int(iterations),
        )
        return hmac.compare_digest(base64url_encode(actual), expected)
    except (TypeError, ValueError):
        logging.error("ARCHIVE_PASSWORD_HASH is missing or invalid")
        return False


def session_secret():
    value = os.getenv("ARCHIVE_SESSION_SECRET", "")
    if len(value) < 32:
        raise RuntimeError("Archive session secret is not configured")
    return value.encode("utf-8")


def create_session_token():
    payload = base64url_encode(json.dumps({
        "exp": int(time.time()) + SESSION_TTL_SECONDS,
        "nonce": secrets.token_urlsafe(12),
    }, separators=(",", ":")).encode("utf-8"))
    signature = base64url_encode(hmac.new(
        session_secret(), payload.encode("ascii"), hashlib.sha256
    ).digest())
    return f"{payload}.{signature}"


def request_session(req):
    try:
        token = req.headers.get("x-archive-session", "").strip()
        authorization = req.headers.get("authorization", "")
        if not token and authorization.lower().startswith("bearer "):
            token = authorization[7:].strip()
        if not token:
            cookie = SimpleCookie()
            cookie.load(req.headers.get("cookie", ""))
            token = cookie[SESSION_COOKIE].value
        payload, supplied_signature = token.split(".", 1)
        expected_signature = base64url_encode(hmac.new(
            session_secret(), payload.encode("ascii"), hashlib.sha256
        ).digest())
        if not hmac.compare_digest(supplied_signature, expected_signature):
            return None
        claims = json.loads(base64url_decode(payload))
        if int(claims.get("exp", 0)) <= int(time.time()):
            return None
        return claims
    except (KeyError, ValueError, TypeError, json.JSONDecodeError, RuntimeError, UnicodeDecodeError, binascii.Error):
        return None


def client_ip(req):
    forwarded = req.headers.get("x-forwarded-for", "")
    return (forwarded.split(",", 1)[0].strip() or "unknown")[:64]


def login_is_limited(address):
    now = time.time()
    with LOGIN_ATTEMPTS_LOCK:
        attempts = [stamp for stamp in LOGIN_ATTEMPTS.get(address, []) if now - stamp < LOGIN_WINDOW_SECONDS]
        LOGIN_ATTEMPTS[address] = attempts
        return len(attempts) >= MAX_LOGIN_ATTEMPTS


def record_login_failure(address):
    with LOGIN_ATTEMPTS_LOCK:
        LOGIN_ATTEMPTS.setdefault(address, []).append(time.time())


def clear_login_failures(address):
    with LOGIN_ATTEMPTS_LOCK:
        LOGIN_ATTEMPTS.pop(address, None)


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
    if not request_session(req):
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
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=10)
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


@app.route(route="login", methods=["POST"])
def login(req: func.HttpRequest) -> func.HttpResponse:
    address = client_ip(req)
    if login_is_limited(address):
        return json_response({"error": "Too many attempts. Try again in a few minutes."}, 429)
    try:
        password = (req.get_json().get("password") or "")[:256]
    except (ValueError, AttributeError):
        return json_response({"error": "Invalid request"}, 400)
    if not password_is_valid(password):
        record_login_failure(address)
        return json_response({"error": "Incorrect password"}, 401)
    try:
        token = create_session_token()
    except RuntimeError as error:
        logging.error("Login is not configured: %s", error)
        return json_response({"error": "Login is not configured"}, 503)
    clear_login_failures(address)
    return json_response({
        "authenticated": True,
        "token": token,
        "expiresIn": SESSION_TTL_SECONDS,
    })


@app.route(route="session", methods=["GET"])
def session(req: func.HttpRequest) -> func.HttpResponse:
    return json_response({"authenticated": bool(request_session(req))})


@app.route(route="logout", methods=["POST"])
def logout(req: func.HttpRequest) -> func.HttpResponse:
    return json_response({"authenticated": False})


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
