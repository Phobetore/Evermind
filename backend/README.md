# Evermind backend

## Mémoire sémantique (optionnelle)

Par défaut, les faits établis sont injectés par récence. Pour activer le rappel
**par pertinence sémantique** (le personnage retrouve le bon souvenir même très
loin dans l'historique) :

    .venv/Scripts/python -m pip install -e ".[semantic]"

Cela installe `sentence-transformers` (~2-3 Go avec torch). Au premier
lancement, le modèle `intfloat/multilingual-e5-small` (~470 Mo) est téléchargé
une seule fois, puis mis en cache localement (100 % hors-ligne ensuite). Sans cet
extra, le backend fonctionne normalement en mode récence.

### Rappel de passages (phase 2)

En plus des faits, Evermind peut repêcher des **extraits verbatim** d'anciens
messages sémantiquement liés à la scène en cours (utile quand le détail exact
d'un vieil échange compte). Réglé par « Rappel de passages (tokens) » dans les
Paramètres (défaut 1500, `0` pour désactiver). Nécessite le même extra
`semantic` ; sans lui, la fonctionnalité est inactive et le backend fonctionne
normalement.
