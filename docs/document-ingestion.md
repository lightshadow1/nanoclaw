# Local document ingestion

Telegram documents in registered chats are downloaded to a host-owned inbox,
then mounted read-only at `/workspace/inbox` in that group's container.
The mount is created even before the first document, so running containers see
new downloads. Caption triggers work like text mentions. Use a caption describing
the requested analysis. Containers started before this feature was installed
must finish/restart once to receive the new mount.

Supported intake extensions: DOCX, XLSX, PPTX, ODT, ODS, ODP, RTF, EPUB, CSV,
TXT and PDF. Conversion uses pinned `@firecrawl/anydoc@0.1.6` locally; scanned
PDFs require OCR, and extracted formatting/visuals can be incomplete.

The download limit is 20 MiB, 30 seconds, and 200 MiB per group. Files expire
after seven days, swept on subsequent intake. One download per group and four
globally can be in flight; simultaneous duplicate messages share a download.
Generated paths avoid untrusted names. Failed downloads leave no usable path.

The storage root is `~/.local/share/nanoclaw-documents/<checkout-path-hash>`;
each group has a hashed subdirectory. Keep it outside all writable agent mounts.
It is intentionally outside the project tree, including the main agent's project
mount. A relocated checkout uses a new inbox namespace; old paths expire only
when that old checkout receives another document, or through operator cleanup.

The conversion skill is synced using the existing container skill mechanism.
`convert-document` limits wall time to 60 seconds, V8 heap to 256 MiB, and output
files to 20 MiB. Native parser allocations are subject to the container runtime's
memory limit, not the V8 limit. Generated conversion directories expire on later
conversion runs after seven days. Durable notes belong outside those directories.
The read-only task profile cannot write conversions or use this skill.

## Validation

```sh
docker build -t nanoclaw-agent:anydoc-review container
python3 scripts/anydoc-fixtures.py /tmp/nanoclaw-anydoc-fixtures
docker run --rm --network none --memory 1g --entrypoint bash \
  -v /tmp/nanoclaw-anydoc-fixtures:/fixtures:ro \
  -v "$PWD/scripts/test-anydoc.sh":/test-anydoc.sh:ro \
  nanoclaw-agent:anydoc-review /test-anydoc.sh
```

Promotion requires rebuilding/selecting the agent image on the deployment host.
Retain the previous image tag for rollback. This feature does not add WhatsApp
downloads, OCR, automatic wiki ingestion, or external document uploads.

Upstream source: `nanocoai/nanoclaw` at `74224f62`,
`.claude/skills/add-anydoc` (MIT). Adapted to this fork's container paths and
Telegram adapter; the v2 installer is not used.
