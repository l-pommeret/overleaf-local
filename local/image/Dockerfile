# Image Overleaf avec les paquets LaTeX courants (l'image officielle n'a qu'une
# TeX Live minimale : ni babel-french, ni TikZ, ni biblatex).
ARG BASE=sharelatex/sharelatex:6.3.2
FROM ${BASE}
ARG TEX_COLLECTIONS="collection-latexrecommended collection-latexextra collection-fontsrecommended collection-pictures collection-langfrench collection-langenglish collection-bibtexextra collection-mathscience collection-xetex collection-luatex collection-plaingeneric collection-binextra"
# Le dépôt courant de TeX Live, ou l'archive de l'année de l'image une fois celle-ci gelée.
# `update --all` met fmtutil & co au niveau du nouveau tlmgr, sinon la génération des formats échoue.
RUN set -e; \
    year=$(ls /usr/local/texlive | grep -E '^[0-9]{4}$' | tail -1); \
    if ! { tlmgr option repository https://mirror.ctan.org/systems/texlive/tlnet && tlmgr update --self; }; then \
      tlmgr option repository "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/$year/tlnet-final"; \
      tlmgr update --self; \
    fi; \
    tlmgr update --all; \
    tlmgr install ${TEX_COLLECTIONS}; \
    tlmgr path add; \
    rm -rf /usr/local/texlive/*/tlpkg/backups/* /tmp/*
