#!/usr/bin/env bash
# Renderiza los 8 proyectos a ../entregables/<video>/veyra-<video>-<formato>.mp4
cd "$(dirname "$0")/projects" || exit 1
for d in 0*; do
  slug=${d%-9x16}; slug=${slug%-16x9}; fmt=${d##*-}; name=${slug#*-}
  mkdir -p "../entregables/$slug"
  out="../../entregables/$slug/veyra-$name-$fmt.mp4"
  (cd "$d" && npx -y hyperframes render --quality delivery -o "$out" --quiet >/dev/null 2>&1 && echo "OK $d" || echo "FALLO $d")
done
echo TERMINADO
