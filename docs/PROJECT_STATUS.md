# État d'avancement global — Projet Evermind

> **Date :** Février 2026
> **Base de référence :** Dossier technique v1.0 (spécification originale)
> **Version actuelle du backend :** v0.2.0

---

## Résumé exécutif

Le projet Evermind est **bien avancé** : les phases MVP (v0.1) et v0.2 sont **complétées**, et la phase v1.0 est **en cours de finalisation** (~85 % achevée).

| Phase | Statut | Détail |
|-------|--------|--------|
| **MVP (v0.1)** | ✅ Complété | UI chat, CRUD personnages, 1+ serveur LLM, SQLite, prompts |
| **v0.2 — Mémoire** | ✅ Complété | 3 serveurs LLM, extraction mémoire JSON, retrieval vectoriel, consolidation |
| **v1.0 — Release** | 🟡 ~85 % | Best-of-N ✅, self-refine ✅, orchestrateur ✅, benchmarks CRUD ✅, import/export ✅ |

### Ce qui reste pour v1.0

| Élément | Statut |
|---------|--------|
| Moteur d'exécution des benchmarks (section 16) | ❌ Non implémenté |
| Branches de conversation (arbre de messages) | ❌ Non implémenté |
| Gestion lifecycle process LLM dans le backend | ⚠️ Délégué aux scripts externes |

---

## Détail par section du dossier technique

### §4 — Architecture globale

| Composant | Spécifié | Implémenté | Notes |
|-----------|----------|------------|-------|
| Frontend Web (UI chat + editor) | ✅ | ✅ | Next.js + TypeScript |
| Backend API (orchestrateur) | ✅ | ✅ | FastAPI + Python 3.11+ |
| Serveurs LLM (API OpenAI-like) | ✅ | ✅ | llama.cpp via scripts start.sh/ps1 |
| Stockage SQLite + vector index | ✅ | ✅ | SQLite WAL + index vectoriel numpy |
| Swap de modèles via profils | ✅ | ✅ | 4 profils configurables |

### §5 — Stack technique

| Élément | Spécifié | Implémenté | Notes |
|---------|----------|------------|-------|
| **Frontend Next.js** | ✅ | ✅ | App Router, TypeScript, Tailwind |
| Streaming tokens | ✅ | ✅ | SSE via fetch + ReadableStream |
| Regenerate / retry | ✅ | ✅ | Bouton régénération sur le dernier message |
| Alternates (variantes) | ✅ | ✅ | CRUD variantes + sélection |
| Branches de conversation | ✅ | ❌ | Pas d'arbre parent/enfant dans les messages |
| Sidebar personnages + conversations | ✅ | ✅ | Navigation avec état actif |
| Settings profils | ✅ | ✅ | Profils, sliders temp/top_p, best-of-N |
| Memory inspector | ✅ | ✅ | Filtres type, pin/forget, world state |
| **Backend FastAPI** | ✅ | ✅ | 11 routers enregistrés |
| CRUD personnages & conversations | ✅ | ✅ | Complet avec import/export |
| Orchestration best-of-N + self-refine | ✅ | ✅ | Pipeline complet |
| Pipeline mémoire | ✅ | ✅ | Extract → consolidate → index → retrieve |
| Logs JSON | ✅ | ✅ | JSONFormatter + setup_logging() |
| **Runtime LLM Vulkan** | ✅ | ✅ | llama-server, 3 ports (8081/8082/8083) |
| **SQLite WAL** | ✅ | ✅ | PRAGMA journal_mode=WAL |

### §6 — Stratégie de modèles & profils

| Élément | Spécifié | Implémenté | Notes |
|---------|----------|------------|-------|
| Profil A — Équilibré (défaut) | ✅ | ✅ | Chat Gemma-3 12B, Mém/Juge Qwen3-4B |
| Profil B — Qualité max | ✅ | ✅ | Chat GPT-OSS 20B |
| Profil C — Rapide | ✅ | ✅ | Chat Llama 3.1 8B |
| Profil D — Test | ✅ | ✅ | Chat Phi-4 15B |
| Embeddings configurable (CPU) | ✅ | ✅ | intfloat/e5-small-v2 (dim 384) |
| Contexte max par profil | ✅ | ✅ | Configurable dans config.yaml |

### §7 — Système de mémoire (cœur produit)

| Élément | Spécifié | Implémenté | Notes |
|---------|----------|------------|-------|
| **4 couches mémoire** | ✅ | ✅ | Character Core, World State, Episodic, Semantic |
| MemoryItem (JSON structuré) | ✅ | ✅ | Tous les champs spec présents |
| **Pipeline tour complet** | | | |
| — A) Retrieval avant génération | ✅ | ✅ | Recherche vectorielle top-K + scoring priorité |
| — B) Génération chat (prompt assemblé) | ✅ | ✅ | System → Core → World → Memories → History |
| — C) Écriture mémoire après génération | ✅ | ✅ | Extraction JSON → consolidation → indexation |
| Scoring priorité composite | ✅ | ✅ | Similarité + importance×confidence + récence + référence |
| Dédoublonnage (seuil 0.90) | ✅ | ✅ | Fusion + boost confidence |
| Pin / Forget (soft delete) | ✅ | ✅ | Endpoints + UI inspector |
| Best-of-N + self-refine | ✅ | ✅ | N configurable (1-7), juge + réécriture |
| Juge multi-critères | ✅ | ✅ | Persona, mémoire, continuité, style, immersion |

### §8 — Prompts (templates)

| Template | Spécifié | Implémenté | Notes |
|----------|----------|------------|-------|
| Prompt système RP strict | ✅ | ✅ | Template C.1 |
| Format injection mémoire | ✅ | ✅ | Templates C.4-C.6 |
| Prompt extraction mémoire (JSON strict) | ✅ | ✅ | Template D.1 |
| Prompt juge (JSON strict) | ✅ | ✅ | Template D.2 |
| Prompt self-refine | ✅ | ✅ | Template D.3 |

### §9 — API Backend — Endpoints

| Groupe | Endpoints spécifiés | Implémentés | Notes |
|--------|--------------------:|------------:|-------|
| Health | 2 | ✅ 2 | `/health`, `/version` |
| Characters | 7 | ✅ 7 | CRUD + import + export |
| Conversations | 4 | ✅ 4 | CRUD avec filtre character_id |
| Messages | 2 | ✅ 2 | Liste + création |
| Chat stream | 1 | ✅ 1 | POST `/chat/stream` SSE |
| Memory | 5 | ✅ 5 | Memories CRUD + world_state + rebuild + forget |
| Profiles / Models | 4 | ✅ 4 | Profils + status + restart |
| Tools | 1 | ✅ 1 | Character assistant |
| **Bonus (hors spec)** | — | ✅ | Variants (4 endpoints), Benchmarks (5 endpoints) |

**Total : 26/26 endpoints spécifiés implémentés**, plus 9 endpoints bonus.

### §10 — Frontend — UX & écrans

| Écran | Spécifié | Implémenté | Notes |
|-------|----------|------------|-------|
| Liste personnages | ✅ | ✅ | Recherche, filtre, import/export, delete |
| Éditeur personnage | ✅ | ✅ | 10+ champs + assistant IA intégré |
| Chat (streaming) | ✅ | ✅ | SSE token-by-token |
| Chat (regenerate) | ✅ | ✅ | Régénération du dernier message |
| Chat (variantes) | ✅ | ✅ | Via système de variants |
| Chat (branches) | ✅ | ❌ | Pas de branching d'arbre |
| Settings (profils) | ✅ | ✅ | Sélection profil + paramètres |
| Settings (best-of-N + self-refine) | ✅ | ✅ | Slider N (1-7) + toggle |
| Memory inspector | ✅ | ✅ | Filtres, pin, forget, world state |

### §11 — Backend — Modules internes

| Module | Spécifié | Implémenté | Notes |
|--------|----------|------------|-------|
| `model_manager/` | ✅ | ⚠️ | Health/status OK ; lifecycle process délégué aux scripts |
| `prompting/` | ✅ | ✅ | Templates + assembleur complets |
| `chat_orchestrator/` | ✅ | ✅ | Best-of-N, self-refine, streaming |
| `memory_pipeline/` | ✅ | ✅ | Retrieve → extract → consolidate → index |
| `storage/` | ✅ | ✅ | SQLite + migrations + vecteurs (via `core/`) |
| `tools/` | ✅ | ✅ | Character assistant, import/export |

### §12 — Base de données (SQLite)

| Table | Spécifiée | Implémentée | Notes |
|-------|-----------|-------------|-------|
| `characters` | ✅ | ✅ | Tous les champs spec |
| `conversations` | ✅ | ✅ | FK vers characters |
| `messages` | ✅ | ✅ | role CHECK constraint |
| `world_state` | ✅ | ✅ | JSON state par personnage |
| `memories` | ✅ | ✅ | Avec pinning (ajout vs spec) |
| Index vectoriel | ✅ | ✅ | JSON numpy (brute-force cosine) |
| **Bonus** | — | ✅ | `message_variants`, `benchmark_runs`, `benchmark_scores` |

### §13 — Scoring & consolidation mémoire

| Élément | Spécifié | Implémenté | Notes |
|---------|----------|------------|-------|
| Score de priorité composite | ✅ | ✅ | Formule complète avec poids configurables |
| Décroissance récence (exp decay) | ✅ | ✅ | `recency_factor()` |
| Bonus referenced | ✅ | ✅ | `referenced_factor()` |
| importance × confidence | ✅ | ✅ | Appliqué dans `compute_priority()` |
| Dédoublonnage (seuil > 0.90) | ✅ | ✅ | `deduplicate_memory()` |
| Pin / Forget | ✅ | ✅ | Endpoints + UI |

### §14 — Sécurité locale

| Élément | Spécifié | Implémenté | Notes |
|---------|----------|------------|-------|
| Bind 127.0.0.1 par défaut | ✅ | ✅ | config.yaml |
| CORS restrictif | ✅ | ✅ | Middleware CORS localhost uniquement |
| Import JSON validé | ✅ | ✅ | Pydantic validation |
| Rate limiting | — | ✅ | Bonus : RateLimitMiddleware |
| Request ID middleware | — | ✅ | Bonus : RequestIDMiddleware |

### §15 — Observabilité

| Élément | Spécifié | Implémenté | Notes |
|---------|----------|------------|-------|
| Logs backend JSON | ✅ | ✅ | JSONFormatter + setup_logging |
| Logs LLM servers (fichiers) | ✅ | ✅ | Via scripts start.sh/ps1 |
| `GET /models/status` | ✅ | ✅ | pid, modèle, ctx, port, alive |
| Timing / latence | ✅ | ✅ | TimingContext dans services |

### §16 — Benchmarks & tests

| Élément | Spécifié | Implémenté | Notes |
|---------|----------|------------|-------|
| CRUD benchmark runs/scores | ✅ | ✅ | 5 endpoints API + DB |
| Batterie de tests automatisable | ✅ | ❌ | Pas de runner d'exécution |
| Drift persona sur 30-50 tours | ✅ | ❌ | Pas implémenté |
| Rappel faits long terme | ✅ | ❌ | Pas implémenté |
| Scoring automatique par juge | ✅ | ❌ | Infrastructure prête, pas de runner |
| Export rapport JSON | ✅ | ⚠️ | Endpoint `/report` existe, pas de génération |

### §17 — Déploiement & lancement

| Élément | Spécifié | Implémenté | Notes |
|---------|----------|------------|-------|
| Arborescence conforme | ✅ | ✅ | backend/, frontend/, scripts/, models/, data/, logs/ |
| config.yaml unique | ✅ | ✅ | Configuration complète |
| `scripts/start.sh` | ✅ | ✅ | Démarre LLM + backend + frontend |
| `scripts/start.ps1` | ✅ | ✅ | Équivalent Windows |
| `scripts/stop.sh/ps1` | ✅ | ✅ | Arrêt gracieux |
| `scripts/health-check.sh/ps1` | — | ✅ | Bonus |
| `scripts/setup.sh/ps1` | — | ✅ | Bonus : installation automatique |
| Makefile | — | ✅ | Bonus : commandes centralisées |
| Validation config | — | ✅ | Bonus : `validate_config.py` |

### §18 — Paramètres génération

| Élément | Spécifié | Implémenté | Notes |
|---------|----------|------------|-------|
| temp ~0.7, top_p ~0.9 | ✅ | ✅ | Défauts dans generation-params.ts |
| Fenêtre historique 10-20 messages | ✅ | ✅ | Configurable |
| Mémoire injectée 8-12 items | ✅ | ✅ | Via retriever top-N |
| best_of_n configurable | ✅ | ✅ | Slider 1-7 dans Settings |
| self_refine toggle | ✅ | ✅ | Toggle dans Settings |
| Garde-fous confidence < 0.6 | ✅ | ✅ | Dans extracteur/consolidateur |

### §19 — Assistance IA création personnage

| Élément | Spécifié | Implémenté | Notes |
|---------|----------|------------|-------|
| Inputs (nom, thème, style, limites) | ✅ | ✅ | CharacterAssistantRequest |
| Outputs (persona, style, scenario, etc.) | ✅ | ✅ | JSON structuré |
| Example dialogues générés | ✅ | ✅ | 5-10 exemples |
| Memory seed générée | ✅ | ✅ | Souvenirs initiaux |
| Intégration UI | ✅ | ✅ | Panneau assistant dans CharacterForm |

### §20 — Gestion modèles (installation)

| Élément | Spécifié | Implémenté | Notes |
|---------|----------|------------|-------|
| Vérification fichiers modèles | ✅ | ✅ | Dans scripts start |
| Vérification ports | ✅ | ✅ | Preflight checks |
| Health ping LLM servers | ✅ | ✅ | Health checks dans scripts + API |
| Page status en cas d'erreur | ✅ | ⚠️ | Logs mais pas de page UI dédiée |

---

## Tests & qualité

| Métrique | Valeur |
|----------|--------|
| Tests backend (pytest) | **138 tests** — tous passent ✅ |
| Lint (ruff) | **0 erreur** ✅ |
| Couverture estimée | ~85-90 % des modules |
| Fichiers de test | 31 fichiers |

### Tests par domaine

| Domaine | Fichiers de test | Couverture |
|---------|-----------------|------------|
| Routers / API | 12 | ✅ Bonne |
| Mémoire (pipeline) | 5 | ✅ Bonne |
| Chat (orchestrateur) | 3 | ✅ Bonne |
| Services | 3 | ✅ Bonne |
| Config & utilitaires | 3 | ✅ Bonne |
| Features avancées | 5 | ✅ Bonne |

---

## Éléments bonus (non spécifiés, implémentés)

| Élément | Description |
|---------|-------------|
| **Makefile** | Commandes centralisées (setup, dev, test, lint, clean) |
| **Scripts setup** | Installation automatique des dépendances |
| **Health-check scripts** | Vérification santé de tous les services |
| **Rate limiting** | Protection contre les abus |
| **Request ID middleware** | Traçabilité des requêtes |
| **Validation config** | Outil de validation du config.yaml |
| **Message variants** | Système de variantes de messages |
| **Benchmark CRUD** | Infrastructure complète pour les benchmarks |

---

## Éléments manquants pour v1.0 complète

### ❌ Non implémentés

1. **Branches de conversation** (§5, §10)
   - L'UI et l'API ne supportent pas les arbres de messages (parent/enfant)
   - Les variantes existent mais pas le branching complet

2. **Moteur d'exécution des benchmarks** (§16)
   - L'infrastructure CRUD est en place (API + DB)
   - Il manque le runner qui exécute les tests (drift persona, rappel, continuité)
   - Il manque le scoring automatique par le juge sur des runs complets

3. **Page status UI en cas d'erreur modèle** (§20)
   - Les logs et le health check existent côté backend/scripts
   - Pas de page frontend dédiée affichant le statut des modèles

### ⚠️ Partiellement implémentés

4. **Model Manager — lifecycle process** (§11)
   - Le health check et le status sont implémentés
   - Le démarrage/arrêt des process LLM est délégué aux scripts externes
   - Le restart dans l'API détecte les erreurs mais ne relance pas automatiquement

---

## Score global d'avancement

| Section spec | Complétude |
|-------------|------------|
| §4 Architecture globale | 100 % |
| §5 Stack technique | 90 % (branches manquantes) |
| §6 Stratégie modèles & profils | 100 % |
| §7 Système de mémoire | 100 % |
| §8 Prompts templates | 100 % |
| §9 API Backend | 100 % |
| §10 Frontend UX | 90 % (branches manquantes) |
| §11 Modules internes | 95 % (model_manager partiel) |
| §12 Base de données | 100 % |
| §13 Scoring & consolidation | 100 % |
| §14 Sécurité locale | 100 % |
| §15 Observabilité | 100 % |
| §16 Benchmarks & tests | 40 % (CRUD seul, pas de runner) |
| §17 Déploiement & lancement | 100 % |
| §18 Paramètres génération | 100 % |
| §19 Assistance IA personnage | 100 % |
| §20 Gestion modèles | 90 % (pas de page status UI) |
| **Moyenne pondérée** | **~92 %** |

---

## Recommandations pour compléter v1.0

1. **Priorité haute** : Implémenter le moteur de benchmarks (§16) — c'est le plus gros morceau manquant
2. **Priorité moyenne** : Ajouter le branching de conversation (parent_id sur messages)
3. **Priorité basse** : Page frontend status modèles, restart process intégré au backend
