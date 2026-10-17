#!/usr/bin/env bash
# Pista original sintetizada con ffmpeg (sin samples). Uso: make-music.sh <segundos> <salida.mp3>
set -e
D=$1; OUT=$2; TMP=$(mktemp --suffix=.wav)
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "sine=f=110:d=$D" -f lavfi -i "sine=f=164.81:d=$D" -f lavfi -i "sine=f=220:d=$D" -f lavfi -i "sine=f=277.18:d=$D" \
  -f lavfi -i "aevalsrc='0.5*sin(2*PI*if(lt(mod(t,2),1),659.25,554.37)*t)*exp(-5*mod(t,0.5))*(1-exp(-300*mod(t,0.5)))':d=$D:s=44100" \
  -filter_complex "[0][1][2][3]amix=inputs=4:normalize=0,tremolo=f=0.2:d=0.3[pad];[4]aecho=0.8:0.6:300:0.35[pl];[pad][pl]amix=inputs=2:weights=1 0.5:normalize=0,lowpass=f=2400,afade=t=in:d=1.2,afade=t=out:st=$(echo "$D-1.8"|bc):d=1.8" \
  -ac 2 "$TMP"
PEAK=$(ffmpeg -hide_banner -i "$TMP" -af volumedetect -f null - 2>&1 | grep max_volume | sed 's/.*max_volume: \(-\?[0-9.]*\) dB/\1/')
GAIN=$(echo "-13 - ($PEAK)" | bc -l)
ffmpeg -hide_banner -loglevel error -y -i "$TMP" -af "volume=${GAIN}dB" -c:a libmp3lame -b:a 192k "$OUT"
echo "$OUT peak_antes=${PEAK}dB ganancia=${GAIN}dB"
ffmpeg -hide_banner -i "$OUT" -af volumedetect -f null - 2>&1 | grep -E "max_volume|mean_volume"
rm -f "$TMP"
