#!/bin/bash
# Lancé par my_init au démarrage du conteneur : remplace le vert Overleaf par du
# vert sapin dans les feuilles de style et les logos. Sans effet au second passage.
set -e
cd /overleaf/services/web/public

# ancien vert -> vert sapin (de la teinte la plus claire à la plus foncée)
sed_args=(
  -e 's/#eaf6ef/#e7f0ea/gI'
  -e 's/#daede2/#d3e3d8/gI'
  -e 's/#b8dbc8/#adc9b6/gI'
  -e 's/#86caa5/#7ba68a/gI'
  -e 's/#53b57f/#4f8a63/gI'
  -e 's/#098842/#0b5d2f/gI'
  -e 's/#138a07/#0b5d2f/gI'
  -e 's/#1e6b41/#095228/gI'
  -e 's/#04652f/#095228/gI'
  -e 's/#046530/#095228/gI'
  -e 's/#1c623b/#084a24/gI'
  -e 's/#195936/#073f1f/gI'
)

find stylesheets images img -type f \( -name '*.css' -o -name '*.svg' \) -print0 \
  | xargs -0 grep -liE '#(eaf6ef|daede2|b8dbc8|86caa5|53b57f|098842|138a07|1e6b41|04652f|046530|1c623b|195936)' \
  | xargs -r sed -i "${sed_args[@]}"
sed -i "${sed_args[@]}" favicon*.svg mask-favicon.svg overleaf-logo.svg 2>/dev/null || true
