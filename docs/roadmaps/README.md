# Roadmaps Équipes — Projet Evermind

> **Version :** v1.1 (roadmaps + addendum)
> **Date :** Février 2026

---

## Vue d'ensemble

Ce dossier contient les roadmaps détaillées pour chaque équipe du projet Evermind.
Chaque document décrit les responsabilités, les livrables par phase (MVP → v0.2 → v1.0),
les dépendances inter-équipes, et les critères de validation.

L'**[Addendum v1.1](addendum-v1.1.md)** complète les roadmaps v1.0 avec un diagramme de séquence
du tour complet, la spécification exacte des champs `meta`, les templates prompts finalisés
(placeholders prêts à copier), et les conventions de timing & tokens.

---

## Équipes

| # | Équipe | Document | Périmètre |
|---|--------|----------|-----------|
| 1 | **Frontend** | [frontend-team.md](frontend-team.md) | UI Next.js : chat, éditeur personnages, settings, streaming |
| 2 | **Backend / API** | [backend-team.md](backend-team.md) | FastAPI : orchestration, CRUD, endpoints, streaming SSE |
| 3 | **AI & Mémoire** | [ai-memory-team.md](ai-memory-team.md) | Pipeline mémoire, prompting, best-of-N, self-refine, juge |
| 4 | **Infrastructure / DevOps** | [infrastructure-team.md](infrastructure-team.md) | LLM runtime, scripts start/stop, config, logs, déploiement |
| 5 | **Base de données / Stockage** | [database-team.md](database-team.md) | SQLite, migrations, index vectoriel, backups |
| — | **Addendum v1.1** | [addendum-v1.1.md](addendum-v1.1.md) | Diagramme séquence, schéma meta, prompts finalisés, timing |

---

## Phases du projet

```
MVP (v0.1)          v0.2                    v1.0
──────────────────────────────────────────────────────────►
UI chat + CRUD      3 serveurs LLM          best-of-N
1 serveur LLM       extraction mémoire      self-refine
SQLite basique      retrieval embeddings    memory inspector
mémoire minimale    consolidation           import/export
                                             benchmarks
```

---

## Carte des dépendances inter-équipes

```
                    ┌──────────────────┐
                    │   Infrastructure  │
                    │   (LLM runtime,   │
                    │    scripts, conf)  │
                    └────────┬─────────┘
                             │ fournit serveurs LLM
                             │ + config.yaml
                             ▼
┌─────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  Frontend   │◄──►│   Backend / API   │◄──►│  AI & Mémoire    │
│  (Next.js)  │    │   (FastAPI)       │    │  (pipeline,      │
│             │    │                   │    │   prompts, juge)  │
└─────────────┘    └────────┬─────────┘    └──────────────────┘
                             │
                             │ lit / écrit
                             ▼
                    ┌──────────────────┐
                    │  Base de données  │
                    │  (SQLite + vec)   │
                    └──────────────────┘
```

### Résumé des dépendances critiques

| Équipe qui dépend | Dépend de | Livrable attendu |
|--------------------|-----------|-------------------|
| Frontend | Backend | Contrats API (OpenAPI spec) |
| Backend | Infrastructure | Serveurs LLM opérationnels (API OpenAI-like) |
| Backend | Database | Schéma SQLite + couche d'accès |
| Backend | AI & Mémoire | Pipeline mémoire, templates prompts |
| AI & Mémoire | Infrastructure | Modèles LLM déployés (chat/mem/juge) |
| AI & Mémoire | Database | Tables memories + index vectoriel |

---

## Jalons clés

| Jalon | Date cible (relative) | Critère de validation |
|-------|----------------------|------------------------|
| **M0 — Skeleton** | S+2 | Repos initialisés, CI, hello-world de chaque composant |
| **M1 — MVP (v0.1)** | S+8 | Chat fonctionnel + CRUD personnages + 1 LLM + SQLite |
| **M2 — Mémoire (v0.2)** | S+14 | 3 serveurs LLM + extraction mémoire + retrieval vectoriel |
| **M3 — Release (v1.0)** | S+20 | best-of-N + self-refine + inspector + import/export + bench |

---

## Conventions

- Toutes les dates sont relatives au démarrage (S = semaine)
- Chaque tâche est marquée avec sa priorité : 🔴 Critique, 🟡 Important, 🟢 Nice-to-have
- Les livrables sont validés par des **critères d'acceptation** (CA) listés dans chaque roadmap
