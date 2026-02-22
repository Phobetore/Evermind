# Roadmap Équipe Backend / API — Evermind

> **Stack :** Python 3.11+ · FastAPI · Uvicorn · SQLite
> **Port :** `127.0.0.1:8000`
> **Responsable :** Équipe Backend
>
> 📎 Voir aussi : **[Addendum v1.1](addendum-v1.1.md)** — diagramme de séquence (§A), schéma meta JSON (§B), conventions timing (§E)

---

## 1. Responsabilités

- API REST complète (CRUD personnages, conversations, messages)
- Orchestration de la génération (appels LLM, best-of-N, self-refine)
- Streaming SSE vers le frontend
- Coordination du pipeline mémoire
- Gestion des processus LLM (démarrage, santé, redémarrage)
- Logs structurés, statut système

---

## 2. Dépendances

| Dépend de | Livrable attendu | Phase |
|-----------|-------------------|-------|
| Infrastructure | Serveurs LLM opérationnels (API OpenAI-like) | MVP |
| Infrastructure | Fichier `config.yaml` | MVP |
| Database | Schéma SQLite + couche d'accès données | MVP |
| AI & Mémoire | Pipeline mémoire (retrieve, extract, consolidate) | v0.2 |
| AI & Mémoire | Templates de prompts | MVP |

---

## 3. Phase MVP (v0.1) — Semaines 1–8

### 3.1 Setup projet (S1–S2) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| Initialiser le projet Python | `pyproject.toml` ou `requirements.txt`, virtualenv | ✅ `pip install` fonctionne |
| Structure dossiers | `app/`, `app/routers/`, `app/services/`, `app/models/`, `app/core/` | ✅ Structure documentée |
| FastAPI hello-world | Endpoint `/health` + `/version` | ✅ Réponse JSON correcte |
| Configuration | Chargement `config.yaml` (Pydantic Settings) | ✅ Config parsée au démarrage |
| Logging | Logger JSON structuré (latence, modèle, profil, erreurs) | ✅ Logs lisibles dans stdout + fichier |
| CORS | Middleware CORS restrictif (`127.0.0.1` uniquement) | ✅ Requêtes frontend acceptées |
| CI basique | Lint (ruff/black) + tests unitaires | ✅ Pipeline verte |

### 3.2 CRUD Personnages (S2–S4) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| `GET /characters` | Liste tous les personnages | ✅ JSON array, 200 |
| `POST /characters` | Crée un personnage | ✅ Validation Pydantic, 201, retourne l'objet |
| `GET /characters/{id}` | Détail d'un personnage | ✅ 200 ou 404 |
| `PUT /characters/{id}` | Met à jour un personnage | ✅ 200, champs mis à jour |
| `DELETE /characters/{id}` | Supprime un personnage | ✅ 204, cascade conversations |
| Modèles Pydantic | `CharacterCreate`, `CharacterUpdate`, `CharacterResponse` | ✅ Validation stricte |
| Tests | Tests unitaires pour chaque endpoint | ✅ Couverture 100% des endpoints |

### 3.3 CRUD Conversations & Messages (S3–S5) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| `GET /conversations?character_id=...` | Liste conversations d'un personnage | ✅ Filtrage correct |
| `GET /conversations` | Liste toutes les conversations | ✅ JSON array, 200 |
| `POST /conversations` | Crée une conversation (+ first_message auto) | ✅ 201, first_message inséré |
| `GET /conversations/{id}` | Détail conversation | ✅ 200 ou 404 |
| `DELETE /conversations/{id}` | Supprime conversation + messages | ✅ 204, cascade |
| `GET /conversations/{id}/messages` | Liste messages d'une conversation | ✅ Ordre chronologique, pagination |
| `POST /conversations/{id}/messages` | Ajoute un message user | ✅ 201, rôle forcé "user" |
| Modèles Pydantic | `ConversationCreate`, `MessageCreate`, `MessageResponse` | ✅ Validation stricte |

### 3.4 Chat Generation — Streaming SSE (S5–S7) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| `POST /chat/stream` | Endpoint streaming | ✅ SSE `text/event-stream` |
| Client LLM | Appel HTTP vers serveur LLM (API OpenAI-like) | ✅ Streaming tokens depuis llama.cpp |
| Assemblage prompt | Concaténation : system + character core + historique | ✅ Prompt complet envoyé au LLM |
| Historique fenêtré | Derniers 10–20 messages de la conversation | ✅ Fenêtre configurable |
| Sauvegarde message assistant | Après fin du stream, insérer en DB avec `meta` JSON complet (cf. [Addendum §B](addendum-v1.1.md#b-spécification-exacte-des-champs-meta)) | ✅ Message + meta persistés |
| Event `done` | Émettre l'event SSE `done` avec `message_id` + résumé meta (cf. [Addendum §A.1](addendum-v1.1.md#a1-tour-complet-sse-streaming-côté-ui)) | ✅ Event conforme |
| Timing pipeline | Implémenter `TimingContext` pour mesurer les latences (cf. [Addendum §E](addendum-v1.1.md#e-conventions-de-timing--tokens-implémentation)) | ✅ Latences enregistrées dans meta |
| Gestion erreurs | Timeout, LLM down, ctx overflow | ✅ Événement SSE `error` |
| Paramètres génération | `temperature`, `top_p`, `max_tokens`, `seed` depuis le body | ✅ Valeurs transmises au LLM + enregistrées dans meta |
| Tests | Test streaming avec mock LLM | ✅ Stream fonctionnel |

### 3.5 Gestion processus LLM (S3–S4) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| `model_manager` | Module qui lance/stoppe les serveurs llama.cpp | ✅ Processus gérés |
| Health check | Ping `/health` de chaque serveur LLM au démarrage | ✅ Statut up/down |
| `GET /models/status` | État de chaque serveur (port, alive) | ✅ JSON correct |
| `POST /models/restart` | Redémarrage d'un serveur LLM | ✅ Statut retourné (redémarrage externe) |
| Logs LLM | Redirection stdout/stderr vers `logs/` | 🟡 Via config logging.dir |

### 3.6 Profils de modèles (S4–S5) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| `GET /profiles` | Liste les profils configurés | ✅ JSON depuis config.yaml |
| `PUT /profiles/{id}` | Modifier un profil (best_of_n, self_refine, etc.) | ✅ Mise à jour en mémoire |
| Sélection profil | Le profil choisi dans `/chat/stream` détermine quel serveur LLM utiliser | ✅ Routage correct |

---

## 4. Phase v0.2 — Semaines 9–14

### 4.1 Intégration pipeline mémoire (S9–S11) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Hook post-génération | Après chaque réponse assistant, déclencher l'extraction mémoire | ✅ Pipeline appelé automatiquement |
| Hook pré-génération | Avant génération, retrieval mémoire → injection dans le prompt | ✅ Souvenirs injectés (assembler supporte world_state + memories) |
| Endpoint mémoire | `GET /characters/{id}/memories?type=...` | ✅ Liste filtrée |
| Forget | `POST /characters/{id}/memories/forget` (soft delete) | ✅ `is_deleted=1` |
| Rebuild | `POST /characters/{id}/memories/rebuild` (re-extraction) | ✅ Pipeline relancé (soft-delete + reschedule) |
| World State | `GET /characters/{id}/world_state` + `PUT` | ✅ CRUD world_state |

### 4.2 Orchestration multi-serveurs (S10–S12) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| Routage par rôle | Chat → port 8081, Mémoire → 8082, Juge → 8083 | ✅ Appels au bon serveur |
| Client LLM générique | Client HTTP réutilisable pour tout serveur LLM | ✅ Code DRY |
| Failover | Si un serveur LLM est down, erreur claire (pas de crash) | ✅ Gestion d'erreur gracieuse |
| Timeouts configurables | Timeout par rôle (chat plus long que mémoire) | ✅ Config respectée |

### 4.3 Character assistant (S12–S13) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| `POST /tools/character_assistant` | Reçoit inputs (nom, thème, style, limites) | ✅ 200, JSON complet |
| Prompt assistant | Utilise le LLM chat pour générer les champs | ✅ Résultat cohérent |
| Parsing résultat | Extraction JSON depuis la réponse LLM | ✅ Parsing robuste |
| Fallback | Si parsing échoue, retourner les champs partiellement remplis | ✅ Pas de crash |

### 4.4 Import / Export (S13–S14) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| `POST /characters/import` | Upload JSON → création personnage | ✅ Validation schéma strict |
| `GET /characters/{id}/export` | Export personnage complet en JSON | ✅ Format conforme v1 |
| Validation | Schéma JSON validé (Pydantic) | ✅ Erreur 422 si invalide |
| Memory seed | Import des `memory_seed` en mémoires initiales | ✅ Mémoires créées à l'import |

---

## 5. Phase v1.0 — Semaines 15–20

### 5.1 Best-of-N + Self-refine (S15–S17) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Génération N candidats | Appeler le LLM chat N fois en parallèle | ✅ `orchestrator.generate_best_of_n()` implémenté |
| Appel juge | Envoyer les N candidats au LLM juge (cf. [Addendum §D.2](addendum-v1.1.md#d2-judge-prompt-rank-candidates--optional-rewrite-suggestion)) | ✅ `judge.evaluate_candidates()` + template D.2 |
| Sélection meilleur | Choisir le candidat avec le meilleur score | ✅ `run_pipeline()` sélection par `best_id` |
| Self-refine | Si activé, envoyer `rewrite_suggestion` au LLM chat (cf. [Addendum §D.3](addendum-v1.1.md#d3-self-refine-prompt-final-pass)) | ✅ `orchestrator.self_refine()` + template D.3 |
| Streaming final | Streamer seulement la réponse finale (ou la meilleure) | 🔴 UX transparente |
| Meta complète | Écrire le meta JSON complet (pipeline, usage, latency_ms, retrieval, memory_extract) selon [Addendum §B.2](addendum-v1.1.md#b2-schéma-json-strict--assistant-messagesmeta-pour-roleassistant) | 🔴 Meta conforme au schéma v1.1 |
| Latence | Log de la latence totale (N générations + juge + refine) via `TimingContext` (cf. [Addendum §E](addendum-v1.1.md#e-conventions-de-timing--tokens-implémentation)) | 🔴 Métriques disponibles |

### 5.2 Benchmarks (S17–S18) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Endpoint benchmark | `POST /benchmarks` | ✅ CRUD complet (list, create, get, report, scores, delete) |
| Scénarios | Drift persona, rappel faits, continuité, style, immersion | 5 scénarios minimum |
| Scoring automatique | Utilisation du juge (Qwen3-4B) pour scorer | Scores JSON |
| Rapport | `GET /benchmarks/{id}/report` | ✅ JSON exportable (run + scores) |

### 5.3 Hardening (S18–S20) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Validation entrées | Toutes les entrées validées (Pydantic strict) | Pas d'injection |
| Rate limiting | Limite de requêtes (optionnel, protection locale) | 429 si dépassé |
| Gestion VRAM OOM | Détection erreur LLM → fallback ctx réduit | Retry automatique |
| Tests d'intégration | Tests end-to-end (API + LLM mock) | Suite complète |
| Documentation API | OpenAPI spec auto-générée (Swagger UI) | ✅ `/docs` accessible avec tags et descriptions structurés |
| Anti-prompt-injection | Messages user jamais dans le bloc system | Vérification en code |
| Request-ID | Header `X-Request-ID` sur chaque requête | ✅ Middleware implémenté |

---

## 6. Spécifications techniques

### 6.1 Structure de fichiers

```
backend/
├── app/
│   ├── __init__.py
│   ├── main.py                     # FastAPI app, startup, middleware
│   ├── config.py                   # Pydantic Settings (config.yaml)
│   ├── routers/
│   │   ├── __init__.py
│   │   ├── health.py               # /health, /version
│   │   ├── characters.py           # CRUD personnages
│   │   ├── conversations.py        # CRUD conversations
│   │   ├── messages.py             # Messages
│   │   ├── chat.py                 # /chat/stream (SSE)
│   │   ├── memory.py               # Endpoints mémoire
│   │   ├── profiles.py             # Profils modèles
│   │   ├── models.py               # /models/status, /models/restart
│   │   ├── tools.py                # /tools/character_assistant
│   │   └── benchmarks.py           # v1.0
│   ├── services/
│   │   ├── __init__.py
│   │   ├── character_service.py    # Logique métier personnages
│   │   ├── conversation_service.py # Logique métier conversations
│   │   ├── chat_service.py         # Orchestration génération
│   │   ├── memory_service.py       # Interface pipeline mémoire
│   │   ├── model_manager.py        # Gestion processus LLM
│   │   └── benchmark_service.py    # v1.0
│   ├── models/
│   │   ├── __init__.py
│   │   ├── character.py            # Pydantic models
│   │   ├── conversation.py
│   │   ├── message.py
│   │   ├── memory.py
│   │   ├── profile.py
│   │   └── chat.py
│   ├── core/
│   │   ├── __init__.py
│   │   ├── database.py             # Connexion SQLite, migrations
│   │   ├── llm_client.py           # Client HTTP vers serveurs LLM
│   │   └── logging.py              # Logger JSON
│   └── prompting/                  # → Co-owned with AI & Memory team
│       ├── __init__.py
│       ├── templates.py            # Templates de prompts
│       └── assembler.py            # Construction du prompt final
├── tests/
│   ├── conftest.py
│   ├── test_characters.py
│   ├── test_conversations.py
│   ├── test_chat.py
│   └── test_memory.py
├── requirements.txt
└── pyproject.toml
```

### 6.2 Modèles Pydantic clés

```python
# app/models/character.py
from pydantic import BaseModel, Field
from typing import Optional

class CharacterCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    tags: list[str] = []
    summary: str = ""
    persona: str = ""
    writing_style: str = ""
    scenario: str = ""
    first_message: str = ""
    example_dialogues: list[dict] = []
    boundaries: str = ""
    system_rules: str = ""
    memory_seed: list[dict] = []

class CharacterResponse(BaseModel):
    id: str
    name: str
    tags: list[str]
    summary: str
    persona: str
    writing_style: str
    scenario: str
    first_message: str
    example_dialogues: list[dict]
    boundaries: str
    system_rules: str
    memory_seed: list[dict]
    created_at: str
    updated_at: str

# app/models/chat.py
class ChatStreamRequest(BaseModel):
    conversation_id: str
    character_id: str
    user_message: str
    profile_id: str = "balanced"
    generation_params: dict = {}
```

### 6.3 Streaming SSE (FastAPI)

```python
from fastapi.responses import StreamingResponse

@router.post("/chat/stream")
async def chat_stream(request: ChatStreamRequest):
    async def event_generator():
        async for token in chat_service.generate_stream(request):
            yield f"data: {json.dumps({'token': token})}\n\n"
        yield f"data: {json.dumps({'done': True, 'message_id': msg_id, 'meta': meta_summary})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream"
    )
```

> **Note v1.1 :** l'event `done` inclut désormais `message_id` et un résumé `meta`
> (cf. [Addendum §A.1](addendum-v1.1.md#a1-tour-complet-sse-streaming-côté-ui) et [§B.2](addendum-v1.1.md#b2-schéma-json-strict--assistant-messagesmeta-pour-roleassistant)).

### 6.4 Client LLM

```python
# app/core/llm_client.py
import httpx

class LLMClient:
    def __init__(self, base_url: str, timeout: float = 120.0):
        self.base_url = base_url
        self.timeout = timeout

    async def chat_completion_stream(self, messages, **params):
        async with httpx.AsyncClient() as client:
            async with client.stream(
                "POST",
                f"{self.base_url}/v1/chat/completions",
                json={"messages": messages, "stream": True, **params},
                timeout=self.timeout,
            ) as response:
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        yield json.loads(line[6:])
```

---

## 7. Conventions API

| Convention | Détail |
|------------|--------|
| Base URL | `http://127.0.0.1:8000` |
| Format | JSON partout |
| Codes retour | 200 OK, 201 Created, 204 No Content, 404 Not Found, 422 Validation Error, 500 Internal |
| Streaming | SSE (`text/event-stream`) |
| Auth | Aucune (bind 127.0.0.1), token optionnel si bind 0.0.0.0 |
| Pagination | `?page=1&per_page=50` (défaut) |
| Tri | `?sort=created_at&order=desc` (défaut) |

---

## 8. Critères de qualité

- **Tests :** couverture > 80% sur les endpoints
- **Latence API :** < 50ms pour les CRUD, < 200ms pour le premier token SSE
- **Logs :** chaque requête loggée avec latence, status, erreur éventuelle
- **Documentation :** OpenAPI spec auto-générée, accessible à `/docs`
- **Zero crash :** gestion d'erreur sur tous les appels LLM
