# Overleaf de YomYom

Overleaf sur ton Mac, en une commande : pas de compte à créer, pas de connexion, une interface en vert sapin et un onglet **Agent** qui travaille sur le projet avec [pi-aristote](https://github.com/l-pommeret/pi-aristote).

C'est un fork de l'[Overleaf Toolkit](https://github.com/overleaf/toolkit), qui sert à installer Overleaf Community Edition. La documentation d'origine est dans [README.toolkit.md](README.toolkit.md).

## Installer

Ouvre le Terminal et colle :

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/l-pommeret/overleaf-local/master/install.sh)"
```

Le script installe ce qui manque (Homebrew, Docker via Colima, Rosetta sur les Mac Apple Silicon) et télécharge Overleaf. Il propose ensuite d'installer pi-aristote, puis ouvre Overleaf dans le navigateur. La première fois, il faut compter 20 à 40 minutes : la TeX Live complète (français, TikZ, biblatex, beamer, XeLaTeX, LuaLaTeX…) se télécharge à ce moment-là. Il faut environ 15 Go libres.

## Utiliser

```sh
overleaf          # démarre et ouvre http://localhost
overleaf stop     # arrête tout et libère la mémoire
overleaf status   # état des services
overleaf update   # met à jour puis redémarre
```

Les projets restent sur le Mac, dans `~/overleaf-local/data`.

## L'onglet Agent

Dans un projet, l'icône **α** de la barre latérale ouvre l'agent : pi-aristote en entier, dans un vrai terminal, avec ses commandes, `/aristote`, Ultracode, son navigateur… Il travaille sur une copie du projet tenue à jour dans les deux sens : ce qu'il écrit arrive dans Overleaf en quelques secondes (puis le PDF se recompile), et ce que tu tapes dans Overleaf lui parvient aussi.

pi sait qu'il est dans Overleaf : il peut lire le journal de la dernière compilation (`.overleaf/output.log`) pour corriger les erreurs. Le bouton **ν** démarre une nouvelle conversation, sinon l'agent garde le fil du projet.

- Il faut une clé Aristote : lance `pi` une fois dans le Terminal du Mac, puis `/aristote`.
- Une suppression faite par l'agent n'est pas reportée dans Overleaf : il te le signale, et tu supprimes toi-même si c'est voulu.

## Ce qui change par rapport à l'Overleaf Toolkit

- `local/module` : module Overleaf qui connecte automatiquement un utilisateur unique, affiche « Overleaf de YomYom » partout, ajoute le thème et l'onglet Agent, et sert à la synchronisation avec l'agent.
- `local/init/50-sapin.sh` : remplace le vert Overleaf par du vert sapin au démarrage.
- `local/image` : image Overleaf avec les collections LaTeX courantes.
- `local/bridge` : petit serveur (Node et Python, sans dépendances) entre l'onglet Agent et `pi` : synchronisation du projet et terminal. Il n'est joignable que depuis le Mac (127.0.0.1) et il est protégé par un jeton.
- `bin/init`, `lib/shared-functions.sh` : compatibilité avec les outils de base de macOS.

Overleaf n'écoute que sur `127.0.0.1` : il n'est pas joignable depuis le réseau. Sans compte, quiconque utilise la session du Mac peut ouvrir les projets.
