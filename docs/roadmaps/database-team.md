# Roadmap Équipe Base de Données / Stockage — Evermind

> **Stack :** SQLite (WAL) · Index vectoriel (sqlite-vss / faiss / hnswlib) · Python
> **Fichier DB :** `data/app.db`
> **Responsable :** Équipe Database
>
> 📎 Voir aussi : **[Addendum v1.1](addendum-v1.1.md)** — schéma JSON strict pour `messages.meta` (§B), aucune migration nécessaire (champ `meta TEXT` existant)

---

## 1. Responsabilités

- Conception et maintenance du **schéma SQLite**
- Système de **migrations** (versionnement du schéma)
- Couche d'**accès aux données** (DAL / Repository pattern)
- **Index vectoriel** pour les embeddings mémoire
- **Performance** (index, WAL, requêtes optimisées)
- **Backups** et portabilité de la DB
- **Intégrité des données** (contraintes, cascades, validations)

---

## 2. Dépendances

| Dépend de | Livrable attendu | Phase |
|-----------|-------------------|-------|
| AI & Mémoire | Schéma `MemoryItem` finalisé | v0.2 |
| AI & Mémoire | Dimension des embeddings (ex: 384) | v0.2 |
| Backend | Modèles Pydantic (interface) | MVP |

---

## 3. Phase MVP (v0.1) — Semaines 1–8

### 3.1 Setup SQLite (S1–S2) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| Créer `data/app.db` | Au premier démarrage, créer le fichier DB | ✅ Fichier créé automatiquement |
| Pragmas | `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON` | ✅ Pragmas appliqués |
| Module database | `app/core/database.py` — connexion, init, migrations | ✅ Module fonctionnel |
| Pool de connexions | aiosqlite ou sqlite3 avec pool simple | ✅ Connexions gérées proprement |
| Tests | Test de création + connexion + fermeture | ✅ Tests verts |

### 3.2 Système de migrations (S2–S3) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| Table `_migrations` | Tracking des migrations appliquées | ✅ Table créée |
| Migration initiale (001) | Schéma complet v0.1 (characters, conversations, messages) | ✅ Tables créées |
| Runner de migrations | Appliquer automatiquement les migrations au démarrage | ✅ Migrations exécutées dans l'ordre |
| Rollback | Support du rollback (optionnel mais recommandé) | 🔴 Migration réversible |
| Tests | Test de migration complète sur DB vide | ✅ Tests verts |

#### Migration 001 — Schéma initial

```sql
-- migrations/001_initial.sql

PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  persona TEXT NOT NULL DEFAULT '',
  writing_style TEXT NOT NULL DEFAULT '',
  scenario TEXT NOT NULL DEFAULT '',
  first_message TEXT NOT NULL DEFAULT '',
  example_dialogues TEXT NOT NULL DEFAULT '[]',
  boundaries TEXT NOT NULL DEFAULT '',
  system_rules TEXT NOT NULL DEFAULT '',
  memory_seed TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversations_character
  ON conversations(character_id);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id, created_at);
```

### 3.3 Couche d'accès données — Characters (S2–S4) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| `CharacterRepository` | CRUD complet (create, get, list, update, delete) | ✅ Toutes les opérations fonctionnent |
| Sérialisation JSON | Tags, example_dialogues, memory_seed → JSON string en DB | ✅ Sérialisation/désérialisation correcte |
| Cascade delete | Supprimer un personnage → supprimer conversations + messages | ✅ Cascade vérifiée |
| Recherche | Recherche par nom (LIKE) | ✅ Résultats filtrés |
| Tests unitaires | Tests pour chaque opération CRUD | ✅ Couverture 100% |

```python
# app/core/repositories/character_repository.py

class CharacterRepository:
    async def create(self, character: CharacterCreate) -> CharacterResponse: ...
    async def get(self, character_id: str) -> Optional[CharacterResponse]: ...
    async def list(self, search: Optional[str] = None) -> list[CharacterResponse]: ...
    async def update(self, character_id: str, data: CharacterUpdate) -> CharacterResponse: ...
    async def delete(self, character_id: str) -> bool: ...
```

### 3.4 Couche d'accès données — Conversations & Messages (S3–S5) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| `ConversationRepository` | CRUD (create, get, list_all, list_by_character, delete) | ✅ Opérations fonctionnelles |
| `MessageRepository` | CRUD (create, list_by_conversation, get) | ✅ Opérations fonctionnelles |
| Pagination messages | Limit + offset (ou cursor-based) | ✅ Pagination correcte |
| Fenêtre historique | Fonction `get_recent_messages(conversation_id, limit=20)` | ✅ N derniers messages retournés |
| Tri | Messages triés par `created_at` ASC | ✅ Ordre chronologique |
| Meta JSON | Champ `meta` sérialisé/désérialisé comme dict — schéma strict v1.1 (cf. [Addendum §B](addendum-v1.1.md#b-spécification-exacte-des-champs-meta)) | ✅ Correct |
| Tests | Tests unitaires pour chaque opération | ✅ Couverture 100% |

```python
# app/core/repositories/conversation_repository.py

class ConversationRepository:
    async def create(self, data: ConversationCreate) -> ConversationResponse: ...
    async def get(self, conversation_id: str) -> Optional[ConversationResponse]: ...
    async def list_by_character(self, character_id: str) -> list[ConversationResponse]: ...
    async def delete(self, conversation_id: str) -> bool: ...

# app/core/repositories/message_repository.py

class MessageRepository:
    async def create(self, data: MessageCreate) -> MessageResponse: ...
    async def list_by_conversation(
        self, conversation_id: str, limit: int = 50, offset: int = 0
    ) -> list[MessageResponse]: ...
    async def get_recent(
        self, conversation_id: str, limit: int = 20
    ) -> list[MessageResponse]: ...
```

### 3.5 Backups (S5–S6) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Copie de fichier | Backup simple : copie de `app.db` | Fichier copié |
| Nom horodaté | `app_2026-02-21_120000.db` | Format correct |
| Endpoint backup | `POST /admin/backup` (optionnel) | Backup déclenché |
| Restore | Copier un backup vers `app.db` (procédure documentée) | Documenté |

---

## 4. Phase v0.2 — Semaines 9–14

### 4.1 Migration 002 — Mémoire (S9–S10) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| Table `memories` | Schéma complet (cf. spec §12.1) | ✅ Table créée |
| Table `world_state` | Schéma complet | ✅ Table créée |
| Index | `idx_memories_character_type` | ✅ Index créé |
| Migration automatique | Appliquée au démarrage | ✅ Pas de données perdues |
| Tests | Test de migration sur DB v0.1 existante | ✅ Migration réussie |

#### Migration 002 — Mémoire

```sql
-- migrations/002_memory.sql

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('semantic', 'episodic', 'world')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  entities TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.8,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_referenced_at TEXT,
  source_turn_id TEXT,
  FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS world_state (
  character_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memories_character_type
  ON memories(character_id, type);

CREATE INDEX IF NOT EXISTS idx_memories_character_active
  ON memories(character_id, is_deleted);
```

### 4.2 Index vectoriel (S9–S11) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| Choix de lib | Évaluer : sqlite-vss, faiss (via faiss-cpu), hnswlib | ✅ **numpy** retenu (adapté pour <50k vecteurs ; upgrade path vers hnswlib/faiss ultérieur) |
| Table/fichier vectoriel | Stockage `memory_id → embedding[D]` | ✅ Données persistées |
| Insertion | Ajouter un vecteur lors de l'indexation d'un souvenir | ✅ Vecteur stocké |
| Recherche top-K | Recherche par similarité cosinus, top-K résultats | ✅ Résultats corrects |
| Suppression | Supprimer un vecteur (soft delete / forget) | ✅ Vecteur retiré de l'index |
| Reconstruction | Reconstruire l'index à partir de la DB | ✅ Index reconstruit |
| Tests | Tests de recherche avec données connues | ✅ Rappel correct |

#### Options d'index vectoriel

| Lib | Avantages | Inconvénients |
|-----|-----------|---------------|
| **sqlite-vss** | Intégré à SQLite, requêtes SQL | Extension C à compiler, moins mature |
| **faiss-cpu** | Très rapide, bien maintenu | Fichier séparé, pas dans SQLite |
| **hnswlib** | Léger, rapide, pip install | Fichier séparé |
| **numpy brut** ✅ | 0 dépendance | Lent au-delà de ~10k vecteurs |

> **Choix v0.2 :** `numpy` brut retenu — suffisant pour <50k vecteurs, zéro dépendance externe.
> Upgrade path vers `hnswlib` ou `faiss-cpu` prévu si les volumes augmentent.

### 4.3 `MemoryRepository` (S10–S12) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| `create` | Insérer un souvenir | ✅ Souvenir créé |
| `get` | Récupérer un souvenir par ID | ✅ Souvenir retourné |
| `list_by_character` | Liste filtrée (type, is_deleted, is_pinned) | ✅ Filtrage correct |
| `search_similar` | Recherche vectorielle top-K | 🔴 Résultats par similarité |
| `update_importance` | Mettre à jour importance/confidence | ✅ Valeurs mises à jour |
| `update_referenced_at` | Mettre à jour `last_referenced_at` | ✅ Timestamp mis à jour |
| `soft_delete` | `is_deleted=1` + retrait du vecteur | ✅ Souvenir masqué |
| `pin` / `unpin` | `is_pinned=1/0` | ✅ Statut mis à jour |
| `get_pinned` | Liste les souvenirs pinned d'un personnage | ✅ Souvenirs retournés |
| `merge` | Fusionner deux souvenirs (dédoublonnage) | ✅ Souvenir fusionné, ancien supprimé |
| Tests | Tests unitaires complets | ✅ Couverture des opérations CRUD |

```python
# app/core/repositories/memory_repository.py

class MemoryRepository:
    async def create(self, memory: MemoryCreate, embedding: list[float]) -> MemoryResponse: ...
    async def get(self, memory_id: str) -> Optional[MemoryResponse]: ...
    async def list_by_character(
        self, character_id: str,
        type: Optional[str] = None,
        include_deleted: bool = False
    ) -> list[MemoryResponse]: ...
    async def search_similar(
        self, query_embedding: list[float],
        character_id: str,
        top_k: int = 30,
        type: Optional[str] = None
    ) -> list[tuple[MemoryResponse, float]]: ...  # (memory, similarity)
    async def update_importance(self, memory_id: str, importance: float, confidence: float): ...
    async def update_referenced_at(self, memory_id: str): ...
    async def soft_delete(self, memory_id: str): ...
    async def pin(self, memory_id: str): ...
    async def unpin(self, memory_id: str): ...
    async def get_pinned(self, character_id: str) -> list[MemoryResponse]: ...
    async def merge(self, source_id: str, target_id: str, merged_content: str): ...
    async def rebuild_index(self, character_id: str): ...
```

### 4.4 `WorldStateRepository` (S10–S11) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| `get` | Récupérer le world_state d'un personnage | ✅ JSON retourné |
| `upsert` | Créer ou mettre à jour le world_state | ✅ Upsert correct |
| `update_field` | Mettre à jour un champ spécifique du JSON | ✅ Champ mis à jour |
| Tests | Tests unitaires | ✅ Couverture 100% |

```python
# app/core/repositories/world_state_repository.py

class WorldStateRepository:
    async def get(self, character_id: str) -> Optional[dict]: ...
    async def upsert(self, character_id: str, state: dict): ...
    async def update_field(self, character_id: str, field: str, value: any): ...
```

### 4.5 Performance (S12–S14) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Index supplémentaires | Analyser les requêtes lentes, ajouter des index | Requêtes < 10ms |
| Vacuum | Tâche périodique de vacuum (optionnel) | DB compactée |
| Benchmark requêtes | Mesurer la latence de chaque type de requête | Rapport de latence |
| Connexion pooling | Optimiser le pool de connexions aiosqlite | Pas de deadlock |
| WAL checkpoint | Configurer le checkpoint WAL | Pas de croissance WAL infinie |

---

## 5. Phase v1.0 — Semaines 15–20

### 5.1 Migration 003 — Benchmarks & variantes (S15–S16) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Table `message_variants` | Stocker les variantes/alternates d'un message | ✅ Migration SQL créée |
| Table `benchmark_runs` | Stocker les résultats de benchmarks | ✅ Migration SQL créée |
| Table `benchmark_scores` | Scores détaillés par run | ✅ Migration SQL créée |
| Migration | Appliquée automatiquement | Pas de données perdues |

#### Migration 003

```sql
-- migrations/003_variants_benchmarks.sql

CREATE TABLE IF NOT EXISTS message_variants (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  content TEXT NOT NULL,
  score REAL,
  is_selected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_variants_message
  ON message_variants(message_id);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT,
  completed_at TEXT,
  summary TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(character_id) REFERENCES characters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS benchmark_scores (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  persona_score REAL,
  memory_score REAL,
  continuity_score REAL,
  style_score REAL,
  immersion_score REAL,
  total_score REAL,
  details TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(run_id) REFERENCES benchmark_runs(id) ON DELETE CASCADE
);
```

### 5.2 Repositories variantes & benchmarks (S16–S17) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| `MessageVariantRepository` | CRUD variantes (create, list_by_message, select) | Opérations fonctionnelles |
| `BenchmarkRepository` | CRUD runs + scores | Opérations fonctionnelles |
| Tests | Tests unitaires | Couverture 100% |

### 5.3 Import / Export (S17–S18) 🔴

| Tâche | Détail | CA |
|-------|--------|-----|
| Export personnage complet | Character + memories + world_state → JSON | JSON conforme au schéma v1 |
| Import personnage | JSON → Character + memories + world_state | Données importées correctement |
| Validation schéma | Vérifier la conformité du JSON à l'import | Erreur claire si invalide |
| Re-indexation | Après import, recréer les vecteurs des memories | Index à jour |
| Tests | Test d'export → import roundtrip | Données identiques |

### 5.4 Hardening (S18–S20) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Transactions | Toutes les opérations multi-table dans des transactions | Atomicité garantie |
| Contraintes | Vérifier toutes les contraintes FK, CHECK, NOT NULL | Pas de donnée invalide |
| Concurrence | Tester les accès concurrents (WAL) | Pas de lock timeout |
| Corruption recovery | Procédure en cas de corruption DB | Documenté |
| Monitoring DB | Taille DB, nombre de records, stats | Endpoint `/admin/db_stats` (optionnel) |
| Tests d'intégration | Tests end-to-end avec le backend | Suite complète |

---

## 6. Spécifications techniques

### 6.1 Structure de fichiers

```
backend/app/core/
├── database.py                    # Connexion, init, pool
├── migrations.py                  # Runner de migrations
├── vector_index.py                # Gestion index vectoriel
└── repositories/
    ├── __init__.py
    ├── base.py                    # Base repository (connexion)
    ├── character_repository.py
    ├── conversation_repository.py
    ├── message_repository.py
    ├── memory_repository.py       # v0.2
    ├── world_state_repository.py  # v0.2
    ├── variant_repository.py      # v1.0
    └── benchmark_repository.py    # v1.0

backend/migrations/
├── 001_initial.sql
├── 002_memory.sql                 # v0.2
└── 003_variants_benchmarks.sql    # v1.0

data/
├── app.db                         # Base SQLite
└── vectors/                       # Index vectoriel (si fichier séparé)
    └── memories.index
```

### 6.2 Connexion SQLite

```python
# app/core/database.py
import aiosqlite
import os

DATABASE_PATH = os.getenv("DATABASE_PATH", "data/app.db")

async def get_db() -> aiosqlite.Connection:
    db = await aiosqlite.connect(DATABASE_PATH)
    await db.execute("PRAGMA journal_mode=WAL")
    await db.execute("PRAGMA synchronous=NORMAL")
    await db.execute("PRAGMA foreign_keys=ON")
    db.row_factory = aiosqlite.Row
    return db

async def init_db():
    """Créer le dossier data/ et appliquer les migrations."""
    os.makedirs("data", exist_ok=True)
    db = await get_db()
    await run_migrations(db)
    await db.close()
```

### 6.3 Index vectoriel (interface)

```python
# app/core/vector_index.py
from typing import Optional
import numpy as np

class VectorIndex:
    """Interface pour l'index vectoriel (implémentation : hnswlib, faiss, ou numpy)."""

    def __init__(self, dimension: int, index_path: str): ...

    def add(self, memory_id: str, embedding: list[float]) -> None:
        """Ajouter un vecteur à l'index."""
        ...

    def remove(self, memory_id: str) -> None:
        """Retirer un vecteur de l'index."""
        ...

    def search(
        self, query_embedding: list[float], top_k: int = 30,
        filter_ids: Optional[set[str]] = None
    ) -> list[tuple[str, float]]:
        """Rechercher les top-K vecteurs les plus similaires.
        Retourne [(memory_id, similarity_score), ...]"""
        ...

    def rebuild(self, memories: list[tuple[str, list[float]]]) -> None:
        """Reconstruire l'index depuis zéro."""
        ...

    def save(self) -> None:
        """Persister l'index sur disque."""
        ...

    def load(self) -> None:
        """Charger l'index depuis le disque."""
        ...
```

### 6.4 Schéma entité-relation

```
┌─────────────┐       ┌─────────────────┐       ┌──────────────┐
│ characters  │1─────*│ conversations    │1─────*│  messages     │
│             │       │                  │       │              │
│ id (PK)     │       │ id (PK)          │       │ id (PK)      │
│ name        │       │ character_id (FK)│       │ conv_id (FK) │
│ tags []     │       │ title            │       │ role         │
│ persona     │       │ created_at       │       │ content      │
│ style       │       │ updated_at       │       │ created_at   │
│ scenario    │       │                  │       │ meta {}      │
│ ...         │       └─────────────────┘       └──────┬───────┘
└──────┬──────┘                                        │1
       │1                                              │
       │           ┌─────────────────┐          ┌──────┴───────┐
       ├──────────*│  memories       │          │ msg_variants │
       │           │                 │          │ (v1.0)       │
       │           │ id (PK)         │          │ id (PK)      │
       │           │ char_id (FK)    │          │ msg_id (FK)  │
       │           │ type            │          │ content      │
       │           │ title           │          │ score        │
       │           │ content         │          │ is_selected  │
       │           │ importance      │          └──────────────┘
       │           │ confidence      │
       │           │ is_pinned       │          ┌──────────────┐
       │           │ is_deleted      │          │ bench_runs   │
       │           │ ...             │          │ (v1.0)       │
       │           └─────────────────┘          │ id (PK)      │
       │                                        │ char_id (FK) │
       │           ┌─────────────────┐          │ profile_id   │
       └──────────1│  world_state    │          │ status       │
                   │                 │          └──────┬───────┘
                   │ char_id (PK/FK) │                 │1
                   │ state {}        │          ┌──────┴───────┐
                   │ updated_at      │          │ bench_scores │
                   └─────────────────┘          │ (v1.0)       │
                                                │ id (PK)      │
                   ┌─────────────────┐          │ run_id (FK)  │
                   │ _migrations     │          │ turn_number  │
                   │                 │          │ persona_score│
                   │ id (PK)         │          │ ...          │
                   │ name            │          └──────────────┘
                   │ applied_at      │
                   └─────────────────┘
```

---

## 7. Critères de qualité

- **Latence requêtes :** toutes les requêtes CRUD < 10ms
- **Recherche vectorielle :** top-30 en < 50ms (pour < 50k souvenirs)
- **Intégrité :** 0 donnée orpheline (FK CASCADE correctement configurées)
- **Migrations :** toute migration applicable sur une DB existante sans perte de données
- **Portabilité :** un seul fichier `app.db` à copier pour backup/transfert
- **Tests :** couverture > 90% sur les repositories
- **Concurrence :** WAL mode supporte les lectures concurrentes sans lock
