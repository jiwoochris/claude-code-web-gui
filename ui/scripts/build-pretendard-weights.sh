#!/usr/bin/env bash
# Build custom-named copies of Pretendard subfamily OTFs.
#
# Why this exists: macOS Core Text strips weight tokens from font family
# names, so a pptx that asks for `typeface="Pretendard SemiBold"` resolves
# to the "Pretendard" base family + SemiBold weight at the OS level.
# LibreOffice on macOS rides on Core Text and only finds Regular/Bold for
# that base family from the static OTF distribution, so SemiBold/Medium/
# Light requests collapse to Regular or (with b="1") to Bold.
#
# Workaround: ship companion OTFs whose family name has no weight token
# Core Text recognizes (e.g. "PretendardSB"), copying glyphs+metrics from
# the matching static OTF. The render pipeline then substitutes
# "Pretendard SemiBold" -> "PretendardSB" via XCU and the right glyphs
# land in the PDF.
#
# Idempotent: skips weights whose target OTF is newer than the source.

set -euo pipefail

INSTALL_DIR="${PRETENDARD_INSTALL_DIR:-${HOME}/Library/Fonts}"
SRC_DIR="${PRETENDARD_SRC_DIR:-${HOME}/Library/Fonts}"
VENV="${HOME}/.local/share/ccwg-fontvenv"

mkdir -p "$INSTALL_DIR"

# weight-name : OS/2 weight class : short tag (used in custom family name)
SPEC=(
  "Thin:100:TN"
  "ExtraLight:200:EL"
  "Light:300:LT"
  "Medium:500:MD"
  "SemiBold:600:SB"
  "ExtraBold:800:EB"
  "Black:900:BL"
)

needs_build=0
for entry in "${SPEC[@]}"; do
  weight="${entry%%:*}"
  rest="${entry#*:}"
  short="${rest##*:}"
  src="$SRC_DIR/Pretendard-$weight.otf"
  dst="$INSTALL_DIR/PretendardCCWG-$short.otf"
  if [[ ! -f "$src" ]]; then continue; fi
  if [[ ! -f "$dst" || "$src" -nt "$dst" ]]; then
    needs_build=1
    break
  fi
done

if (( ! needs_build )); then
  exit 0
fi

if [[ ! -x "$VENV/bin/python" ]]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip >/dev/null
  "$VENV/bin/pip" install --quiet fonttools
fi

for entry in "${SPEC[@]}"; do
  weight="${entry%%:*}"
  rest="${entry#*:}"
  klass="${rest%%:*}"
  short="${rest##*:}"
  src="$SRC_DIR/Pretendard-$weight.otf"
  dst="$INSTALL_DIR/PretendardCCWG-$short.otf"
  if [[ ! -f "$src" ]]; then
    echo "[fonts] skip $weight: $src not found"
    continue
  fi
  if [[ -f "$dst" && "$dst" -nt "$src" ]]; then
    continue
  fi
  "$VENV/bin/python" - "$src" "$dst" "PretendardCCWG-$short" "$klass" <<'PY'
import sys
from fontTools.ttLib import TTFont
src, dst, family, klass = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
ps = f"{family}-Regular"
font = TTFont(src)
name = font["name"]
name.names = []
def setn(nid, val):
    name.setName(val, nid, 3, 1, 0x409)  # Windows Unicode
    name.setName(val, nid, 1, 0, 0)      # Mac Roman
for nid, val in [(1, family), (2, "Regular"), (3, ps), (4, family), (6, ps)]:
    setn(nid, val)
os2 = font["OS/2"]
os2.usWeightClass = klass
# Clear bold/italic bits, set REGULAR (bit 6) so the font reports as Regular
os2.fsSelection = (os2.fsSelection & ~0x21) | 0x40
font.save(dst)
PY
  echo "[fonts] wrote $dst"
done

fc-cache -f >/dev/null 2>&1 || true
