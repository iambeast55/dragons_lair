import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone

import azure.functions as func
from azure.core.exceptions import ResourceNotFoundError
from azure.storage.blob import (
    BlobSasPermissions,
    BlobServiceClient,
    generate_blob_sas,
)

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

DEFAULT_CONTAINER = "windows"
IMAGE_PATTERN = re.compile(r"\.(avif|gif|heic|jpeg|jpg|png|webp)$", re.I)


@app.route(route="archive", methods=["GET"])
def archive(req: func.HttpRequest) -> func.HttpResponse:
    connection_string = os.getenv("PHOTO_STORAGE_CONNECTION_STRING")
    container_name = os.getenv("PHOTO_STORAGE_CONTAINER", DEFAULT_CONTAINER).strip().lower()
    if not connection_string or not container_name:
        return json_response({"error": "Blob storage is not configured"}, 500)

    try:
        service = BlobServiceClient.from_connection_string(connection_string)
        account_key = getattr(service.credential, "account_key", None)
        if not account_key:
            return json_response({"error": "Storage cannot issue read URLs"}, 500)

        container = service.get_container_client(container_name)
        expires_at = datetime.now(timezone.utc) + timedelta(minutes=20)
        folders = {}
        photos = []

        for item in container.list_blobs():
            if not IMAGE_PATTERN.search(item.name):
                continue
            path_parts = item.name.split("/")
            if len(path_parts) < 2 or not path_parts[0]:
                continue

            folder = path_parts[0]
            folders[folder] = folders.get(folder, 0) + 1
            sas_token = generate_blob_sas(
                account_name=service.account_name,
                container_name=container_name,
                blob_name=item.name,
                account_key=account_key,
                permission=BlobSasPermissions(read=True),
                expiry=expires_at,
            )
            photos.append(
                {
                    "folder": folder,
                    "path": item.name,
                    "name": path_parts[-1],
                    "timestamp": item.last_modified.isoformat(),
                    "url": f"{container.get_blob_client(item.name).url}?{sas_token}",
                }
            )

    except ResourceNotFoundError:
        return json_response({"folders": [], "photos": []})
    except Exception as error:
        logging.exception("Blob archive listing failed: %s", error)
        return json_response({"error": "Blob archive could not be loaded"}, 502)

    return json_response(
        {
            "folders": [
                {"name": name, "count": count}
                for name, count in sorted(folders.items())
            ],
            "photos": photos,
        }
    )


def json_response(payload, status_code=200):
    return func.HttpResponse(
        json.dumps(payload),
        status_code=status_code,
        mimetype="application/json",
    )
