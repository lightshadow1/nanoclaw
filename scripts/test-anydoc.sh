#!/bin/bash
# Run inside the built agent image with fixtures mounted read-only at /fixtures.
set -euo pipefail
for extension in docx xlsx pptx pdf csv; do
  output=$(convert-document "/fixtures/sample.$extension")
  grep -q 'NanoClaw document fixture' "$output"
  echo "PASS $extension"
done
input='/fixtures/sample $(touch SHOULD_NOT_EXIST) '\''quoted'\''.txt'
output=$(convert-document "$input")
grep -q 'NanoClaw document fixture' "$output"
test ! -e SHOULD_NOT_EXIST
echo 'PASS shell metacharacters'
if convert-document /fixtures/corrupt.docx; then
  echo 'Corrupt document unexpectedly succeeded' >&2; exit 1
fi
if convert-document /fixtures/empty.pdf; then
  echo 'Empty PDF unexpectedly succeeded' >&2; exit 1
fi
if touch /fixtures/should-not-write 2>/dev/null; then
  echo 'Fixture mount is writable' >&2; exit 1
fi
echo 'PASS malformed/empty documents and read-only input'
