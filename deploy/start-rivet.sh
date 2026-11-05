#!/bin/sh
set -eu

# Railway supplies the base S3 endpoint. Rust object_store expects the bucket
# in the hostname when virtual-hosted requests are enabled.
if [ "${AWS_VIRTUAL_HOSTED_STYLE_REQUEST:-false}" = "true" ]; then
  endpoint="${RIVET__OBJECT_STORAGE__PRIMARY__S3__ENDPOINT:?Set the Railway bucket endpoint}"
  bucket="${RIVET__OBJECT_STORAGE__PRIMARY__S3__BUCKET:?Set the Railway bucket name}"
  case "$endpoint" in
    https://*)
      host="${endpoint#https://}"
      host="${host%/}"
      export RIVET__OBJECT_STORAGE__PRIMARY__S3__ENDPOINT="https://${bucket}.${host}"
      ;;
    *) echo "The S3 endpoint must use HTTPS." >&2; exit 1 ;;
  esac
fi

exec /usr/bin/rivet-engine "$@"
