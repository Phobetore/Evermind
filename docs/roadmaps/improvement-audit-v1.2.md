# Evermind — Audit des points d'amélioration (v1.2)

## Objectif
Identifier **tous les axes d'amélioration prioritaires** pour rapprocher Evermind du niveau d'expérience perçu sur Crush-like apps (qualité narrative, cohérence mémoire, UX, fluidité), tout en restant local-first.

---

## 1) Gaps Produit / UX (impact utilisateur direct)

### 1.1 Positionnement & promesse perçue
- Le produit expose beaucoup de puissance technique, mais la promesse perçue côté UI reste "outil" plutôt que "companion émotionnel".
- Manque d'onboarding narratif guidé (création de personnage, réglages recommandés, test conversationnel immédiat).

### 1.2 Expérience chat
- Peu de "moments premium" : réactions contextuelles, transitions, repères de scène, résumé d'épisode.
- Fonctions de branche/régénération pas assez visibles ni explicites dans le flow principal.
- Le contrôle qualité (best-of-N, self-refine) est technique, pas orienté résultat (ex: "Mode immersion", "Mode cohérence stricte").

### 1.3 Character creation
- Assistant personnage insuffisamment “productisé” : manque de wizard multi-étapes, previews, et presets d’archétypes.
- Peu de garde-fous qualité sur first message, examples, boundaries, système rules (score automatique absent dans l’éditeur).

### 1.4 Memory UX
- Inspecteur mémoire optionnel mais pas assez central à la proposition de valeur.
- Manque de visualisation des liens mémoire ↔ réponse générée (explainability).
- Outils "pin/forget/merge" trop cachés ou pas guidés par des suggestions.

---

## 2) Gaps Qualité LLM / Orchestration

### 2.1 Prompting
- Prompt actuel riche mais potentiellement trop verbeux et coûteux en tokens contextuels.
- Absence de versions de prompt pilotées par A/B test systématique (prompt registry versionné + scoring).
- Le contrôleur est statique: pas d'adaptation au type de scène (romance, conflit, exposition, action).

### 2.2 Best-of-N / Judge
- Le pipeline existe mais manque d’instrumentation fine : pas de dashboard qualité par candidat (raison rejet/choix).
- L’arbitrage pourrait intégrer des heuristiques hybrides (judge + règles hard fail : méta, echo user, contradiction mémoire sévère).
- Self-refine non conditionné à un seuil qualitatif (devrait être activé dynamiquement selon score juge).

### 2.3 Retrieval mémoire
- Top-K + scoring présents, mais rerank sémantique/cross-encoder non explicite en fallback.
- Pas de policy context-aware (ex: poids différents selon scène émotionnelle vs factuelle).
- Mémoire injectée encore peu hiérarchisée (core facts / commitments / volatile state).

### 2.4 Anti-répétition / style drift
- Réduction de répétition partiellement adressée, mais pas de métriques automatiques de loop lexicale.
- Pas de détecteur de dégradation de style sur conversations longues (drift de persona).

---

## 3) Gaps Mémoire Long Terme (cœur différenciant)

### 3.1 Modèle de données mémoire
- `importance` / `confidence` sont utiles mais sans calibration continue ni feedback loop explicite.
- Manque d'un statut "verified" / "user-confirmed" pour les faits sensibles.
- Contradictions stockées, mais résolution semi-automatique insuffisante.

### 3.2 Consolidation
- Dédoublonnage basé similarité à renforcer avec règles métier (entités, temporalité, négation).
- Manque de versioning des mémoires (audit trail: avant/après fusion).

### 3.3 World state
- Structure utile mais pas de mécanisme de “state transitions” explicites (machine d’état légère).
- Les threads narratifs ouverts ne sont pas priorisés automatiquement par ancienneté/urgence émotionnelle.

### 3.4 Explainability
- L’utilisateur ne voit pas clairement "pourquoi cette réponse" (mémoires utilisées, contraintes appliquées, score confiance).

---

## 4) Gaps Frontend / UI Design

### 4.1 Design system
- Direction visuelle amorcée mais encore hétérogène (densité, hiérarchie typographique, surfaces).
- Manque d’un système de tokens plus complet (spacing, radius, shadows, motion, semantic colors).

### 4.2 Information architecture
- Chat, settings, memories, personas restent cloisonnés; peu de ponts contextuels.
- Manque d’actions contextuelles in-situ (ex: depuis un message -> "save as memory", "pin fact").

### 4.3 Performance perceptive
- Loading skeletons basiques, mais pas de “progressive disclosure” pendant les phases judge/extract/write.
- Manque de telemetry UI (temps perçu, frustration points, abandon par écran).

### 4.4 Accessibilité
- Vérification contraste/keyboard/focus states pas formalisée.
- Peu d’indices ARIA sur éléments interactifs complexes (composer, menus de variantes).

---

## 5) Gaps Backend / API / Fiabilité

### 5.1 API de chat
- SSE fonctionnel mais événements pas assez riches pour l’UI (phases pipeline détaillées, scores intermédiaires).
- Pas de contrat strict documenté pour toutes les erreurs recoverables vs fatales.

### 5.2 Robustesse
- Gestion des timeouts/retries LLM à renforcer (circuit breaker, backoff par rôle).
- Peu de stratégies de dégradation progressive (si judge down: policy explicite + bannière UI).

### 5.3 Config & profils
- Profils techniques, mais manque de presets orientés cas d’usage ("romance slow-burn", "high drama", "cozy").
- Validation config pourrait inclure garde-fous GPU/ctx plus prédictifs (estimation VRAM dynamique).

### 5.4 Observabilité
- Logs présents, mais manque d’agrégats orientés produit (cohérence, immersion, rappel mémoire réussi).
- Absence de tableau de bord local consolidé (latence stage-by-stage + token budget + erreurs).

---

## 6) Gaps Modèles / Runtime AMD Vulkan

### 6.1 Sélection modèles
- Profils définis mais pas de benchmark automatique en conditions réelles utilisateur (30–50 tours).
- Pas de recommandation adaptative modèle/ctx selon VRAM observée au runtime.

### 6.2 Contexte & KV cache
- Politique contexte existe mais pourrait être adaptative par conversation (compression dynamique + window shifting intelligent).
- Besoin d'un mécanisme de “context stress guard” (prévenir avant OOM, auto-réduction smart).

### 6.3 Embeddings
- Pipeline embeddings configurable mais manque de calibration (dim/latence/qualité retrieval).
- Pas de benchmark retrieval offline (Recall@K sur dataset narratif maison).

---

## 7) Gaps QA / Évaluation qualité

### 7.1 Evaluation continue
- Tests unitaires solides, mais manque de tests d’intégration narratifs bout-en-bout automatisés.
- Pas de golden conversations versionnées avec score comparatif sur chaque commit.

### 7.2 Métriques produit
- Nécessité d’un score composite: Persona Fidelity, Memory Recall, Continuity, Immersion, Repetition.
- Besoin d’un seuil de qualité de release (quality gate) avant merge.

### 7.3 Régression UI
- Pas de tests visuels systématiques (screenshots diff) sur composants critiques du chat.

---

## 8) Gaps Sécurité locale & gouvernance

- Validation import/export à renforcer sur schémas et tailles (protection contre payloads malformés géants).
- Sanitization stricte des champs affichés en UI (défense XSS locale, même en usage mono-user).
- Journalisation des changements sensibles (suppression mémoire, merge, override world state).

---

## 9) Plan d’action priorisé (exécutable)

## P0 (1–2 semaines) — Impact qualité perçue immédiat
1. Ajouter **quality telemetry** par tour (scores juge, répétition, contradiction, mémoire rappelée).
2. Créer un **mode UX “Immersion”** activant preset cohérence (best-of, self-refine, repeat penalty, memory strict).
3. Enrichir les événements SSE (pipeline stages détaillés + états fallback).
4. Mettre en place un **benchmark narratif automatisé** (set fixe de scénarios + scoring export JSON).

## P1 (2–4 semaines) — Différenciation mémoire
1. Introduire une hiérarchie mémoire (Core Facts / Commitments / Episodic / Volatile).
2. Ajouter explainability UI: "mémoires utilisées" et "raisons de sélection".
3. Déployer une consolidation avancée (règles entités + temporalité + contradiction severity).
4. Implémenter un versioning des memory merges + actions undo basiques.

## P2 (4–8 semaines) — Finition produit type Crush-like
1. Refonte onboarding personnage (wizard + score qualité + suggestions IA).
2. Système de variantes/branches visuel et central dans le chat.
3. Presets narratifs haut niveau (cozy/drama/slow-burn/intense).
4. Tests visuels front automatisés et quality gate global avant release.

---

## 10) KPI de succès recommandés
- **Memory recall @40 tours**: > 80% (faits importants).
- **Persona drift**: < 10% de tours avec dérive significative.
- **Meta leakage**: < 1% de réponses.
- **Repetition score**: baisse de 30% vs baseline.
- **Satisfaction perçue (testeurs)**: +2 points sur échelle 1–10.

---

## 11) Recommandation stratégique
Le principal levier n’est pas seulement une "UI plus belle" : c’est la combinaison
1) **orchestration qualité mesurable**,
2) **mémoire explicable et contrôlable**,
3) **UX orientée immersion plutôt qu’options techniques**.

Tant que ces trois piliers ne sont pas traités ensemble, le produit restera en dessous de l’expérience Crush-like, même avec de bons modèles.


## 12) État d’avancement (snapshot)

### Déjà avancé
- ✅ Prompt budget guardrails (troncature messages + limite items mémoire injectés).
- ✅ Presets `quality_mode` côté frontend + application backend.
- ✅ Statuts SSE multi-phases (`generating`, `judging`, `refining`, `memory`) visibles côté UI.
- ✅ Durcissement extraction mémoire pour payloads non conformes.

### Encore à faire (priorité haute)
- 🟨 **Quality telemetry exploitable**: base backend ajoutée (quality_signals heuristiques), reste à surfacer en UI + enrichir avec scores juge/rappel mémoire.
- 🔲 **Benchmark narratif automatisé**: scénario long 30–50 tours + rapport JSON.
- 🟨 **Explainability mémoire**: résumé retrieval + memory summaries (type/titre/importance/confiance) ajoutés au meta backend et accessibles via UI; reste à afficher raisons/scoring de sélection explicites.
- 🔲 **Détection de drift persona** automatique sur sessions longues.
- 🔲 **Quality gate release** avec seuils minimaux (meta leakage, repetition, continuity).

### Encore à faire (priorité moyenne)
- 🔲 UI branches/variants plus centrale (navigation visuelle explicite).
- 🔲 Onboarding/wizard de création de personnage (avec score qualité des champs).
- 🔲 Consolidation mémoire avancée (entités + temporalité + contradiction severity + versioning merge).
- 🔲 Presets narratifs orientés usage (cozy/drama/slow-burn/intense).
- 🔲 Tests visuels front automatisés (diff screenshot sur écrans clés).

### Encore à faire (priorité infra/fiabilité)
- 🔲 Circuit breaker / retries/backoff par rôle LLM.
- 🔲 Dashboard local d’observabilité consolidée (latence stage-by-stage + tokens + erreurs).
- 🔲 Guardrails VRAM adaptatifs dynamiques (ctx stress guard + fallback progressif).
- 🔲 Validation import/export renforcée (taille/payload) + audit sécurité locale.
