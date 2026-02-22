# Roadmap Équipe AI & Mémoire — Evermind

> **Périmètre :** Pipeline mémoire, prompts, scoring, best-of-N, self-refine, juge
> **Modèles principaux :** Qwen3-4B (mémoire/juge), modèle embeddings CPU
> **Responsable :** Équipe AI & Mémoire
>
> 📎 Voir aussi : **[Addendum v1.1](addendum-v1.1.md)** — templates prompts finalisés avec `{{placeholders}}` (§C, §D), diagramme pipeline (§A)

---

## 1. Responsabilités

- Conception et implémentation du **pipeline mémoire** (extraction, consolidation, indexation, retrieval)
- Rédaction et maintenance des **templates de prompts** (chat RP, extraction, juge, assistant)
- Logique de **scoring de priorité** des souvenirs
- Implémentation du **best-of-N** et **self-refine**
- Intégration et gestion du **modèle d'embeddings**
- **Dé-doublonnage** et gestion des contradictions
- Calibration des seuils (confidence, importance, similarité)

---

## 2. Dépendances

| Dépend de | Livrable attendu | Phase |
|-----------|-------------------|-------|
| Infrastructure | Serveurs LLM mémoire + juge opérationnels | v0.2 |
| Infrastructure | Modèle embeddings installé | v0.2 |
| Database | Tables `memories` + `world_state` + index vectoriel | v0.2 |
| Backend | Endpoints mémoire exposés | v0.2 |
| Backend | Hook pré/post génération intégré | v0.2 |

---

## 3. Phase MVP (v0.1) — Semaines 1–8

### 3.1 Fondations prompts (S1–S4) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| Prompt système RP strict | Template v1.1 avec `{{placeholders}}` (cf. [Addendum §C.1](addendum-v1.1.md#c1-chat--system-prompt-rp-strict-stable)) | ✅ Prompt fonctionnel, personnage respecté |
| Controller prompt | Template orchestration optionnel (cf. [Addendum §C.2](addendum-v1.1.md#c2-chat--developercontroller-prompt-orchestration)) | ✅ Injecté si runtime le supporte |
| Character Core block | Template avec tous les champs personnage (cf. [Addendum §C.3](addendum-v1.1.md#c3-character-core-block-injecté-tel-quel)) | ✅ Bloc complet injecté |
| World State block | Template état du monde (cf. [Addendum §C.4](addendum-v1.1.md#c4-world-state-block-injecté-tel-quel)) | ✅ Bloc injecté |
| Format injection mémoire | Format `[type\|sim=X\|imp=Y\|conf=Z] contenu` (cf. [Addendum §C.5](addendum-v1.1.md#c5-memory-block-format-final-concis)) | ✅ Intégré dans le prompt final |
| Assembleur de prompts | Module qui construit le prompt complet dans l'ordre v1.1 (cf. [Addendum §C.7](addendum-v1.1.md#c7-final-chat-prompt-assemblage-recommandé)) : system → controller → core → world → memory → history → user | ✅ Sortie correcte testée |
| Fenêtre historique | Logique pour sélectionner les N derniers messages (cf. [Addendum §C.6](addendum-v1.1.md#c6-conversation-history-block-fenêtre-courte)) | ✅ Configurable (limit=20) |
| Tests unitaires prompts | Vérifier le format de sortie | ✅ Tests verts (8 tests) |

### 3.2 Mémoire minimale (S4–S7) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| World summary statique | Résumé du monde injecté dans le prompt | Champ `world_state` utilisé |
| Notes manuelles | Possibilité d'ajouter des notes (memory_seed) | Notes injectées dans le prompt |
| Character core injection | Persona + style + boundaries toujours injectés | Présents dans chaque prompt |
| Calcul taille prompt | Estimation du nombre de tokens pour respecter le ctx | Ne dépasse pas ctx_max |

### 3.3 Recherche & conception pipeline (S5–S8) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Choix modèle embeddings | Évaluer E5-small, BGE-small, all-MiniLM (CPU) | Benchmark local (qualité + vitesse) |
| Conception `MemoryItem` | Finaliser le schéma JSON (cf. spec §7.2) | Schéma documenté |
| Conception pipeline | Documenter le flux retrieve → extract → consolidate → index | Diagramme + spec |
| Prototype extraction JSON | Test du prompt d'extraction sur Qwen3-4B | JSON valide retourné dans >90% des cas |
| Prototype scoring | Implémentation de la formule de priorité (cf. spec §13.1) | Score calculé correctement |

---

## 4. Phase v0.2 — Semaines 9–14

### 4.1 Pipeline d'extraction mémoire (S9–S11) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Prompt extraction JSON | Template strict v1.1 pour Qwen3-4B (cf. [Addendum §D.1](addendum-v1.1.md#d1-memory-extraction-prompt-json-strict)) | ✅ JSON valide : `semantic`, `episodic`, `world_updates`, `contradictions` |
| Parsing JSON robuste | Parser la sortie LLM avec fallback (regex si JSON cassé) | ✅ Taux de parsing > 95% (markdown fence stripping + fallback) |
| Filtrage confidence | Ne pas stocker si `confidence < 0.6` (MEMORY_CONFIDENCE_THRESHOLD = 0.6) | ✅ Seuil respecté |
| Gestion contradictions | Enregistrer sans écraser l'ancien | 🔴 Contradictions stockées séparément |
| Insertion en DB | Créer les `MemoryItem` en base + vecteurs | Mémoires persistées |
| Hook post-génération | Intégration dans le flux chat (après chaque réponse assistant) — cf. [Addendum §A.1](addendum-v1.1.md#a1-tour-complet-sse-streaming-côté-ui) étapes 14–19 | ✅ Pipeline déclenché automatiquement (intégré dans chat_service) |
| Tests | Tests avec des conversations simulées | Extraction correcte |

### 4.2 Embeddings & indexation (S9–S10) 🔴

| Tâche | Détail | CA |
|-------|--------|-----|
| Intégration modèle embeddings | Chargement du modèle CPU (sentence-transformers ou API llama.cpp) | Embeddings générés |
| Vectorisation `MemoryItem` | Calculer l'embedding de chaque souvenir (title + content) | Vecteur stocké |
| Index vectoriel | Insertion dans l'index (sqlite-vss, faiss, ou hnswlib) | Recherche fonctionnelle |
| Recherche top-K | Fonction `search(query, k=30)` → résultats triés par similarité | Résultats pertinents |
| Tests | Test recherche avec données connues | Rappel correct |

### 4.3 Pipeline de retrieval (S10–S12) 🔴

| Tâche | Détail | CA |
|-------|--------|-----|
| Construction requête | À partir de : message user + résumé contexte + entités détectées | Requête pertinente |
| Détection entités | Extraction basique des noms/lieux/objets du message user | Entités extraites |
| Recherche vectorielle | Top-K avec filtre personnage + type + fraîcheur | Résultats filtrés |
| Scoring de priorité | Appliquer la formule (sim × w_sim + imp × w_imp + rec × w_rec + ref × w_ref - del × w_del) | Score calculé |
| Tri + sélection top-N | Garder les 8–12 meilleurs souvenirs | Nombre configurable |
| Injection dans le prompt | Formater et insérer dans le prompt final | Format correct (cf. spec §8.2) |
| Hook pré-génération | Intégration dans le flux chat (avant chaque génération) | Pipeline déclenché automatiquement |

### 4.4 Consolidation & dédoublonnage (S11–S13) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Dédoublonnage | Si similarité > 0.90 avec existant → fusion (consolidator.py) | ✅ Pas de doublons |
| Fusion | Combiner les contenus, augmenter confidence si corroboré | ✅ Contenu fusionné cohérent |
| Mise à jour `last_referenced_at` | À chaque fois qu'un souvenir est rappelé | ✅ Timestamp mis à jour |
| Décroissance (decay) | `recency_factor = exp(-age_days / tau)` | 🔴 Facteur calculé correctement |
| Pin | Priorité haute, inclusion quasi-systématique | 🔴 Souvenirs pinned toujours inclus |
| Forget (soft delete) | `is_deleted=1` + suppression vecteur de l'index | 🔴 Souvenir masqué |

### 4.5 Calibration (S13–S14) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Poids scoring | Ajuster w_sim, w_imp, w_rec, w_ref, w_del (défauts : w_sim=0.35, w_imp=0.25, w_rec=0.20, w_ref=0.15, w_del=10.0) | ✅ Valeurs optimales documentées |
| Seuil dédoublonnage | Tester 0.85, 0.90, 0.95 | Seuil choisi et justifié |
| Tau décroissance | Tester différentes valeurs de tau | Valeur optimale documentée |
| Top-K / Top-N | Tester différentes tailles (K=20–40, N=6–15) | Valeurs optimales |
| Fenêtre historique | Tester 10, 15, 20 messages | Valeur optimale |

---

## 5. Phase v1.0 — Semaines 15–20

### 5.1 Best-of-N (S15–S16) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Génération N candidats | Appeler le LLM chat N fois (séquentiel ou parallèle) | ✅ `orchestrator.generate_best_of_n()` avec seed variation |
| Diversité | Varier légèrement les paramètres (temp, seed) pour chaque candidat | ✅ Seed incrémenté par candidat |
| Prompt juge | Template strict v1.1 (cf. [Addendum §D.2](addendum-v1.1.md#d2-judge-prompt-rank-candidates--optional-rewrite-suggestion)) : notation sur 5 critères avec subscores | ✅ Template JUDGE ajouté dans templates.py |
| Parsing scores | Extraire les scores + ranking + best_id | ✅ `judge.parse_judge_response()` avec fallback |
| Sélection finale | Retourner le candidat avec le meilleur score total | ✅ `run_pipeline()` sélection par `best_id` |
| Latence tracking | Log du temps total (N × génération + juge) | 🔴 Métriques disponibles |

### 5.2 Self-refine (S16–S17) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Consigne de réécriture | Le juge fournit `rewrite_suggestion` | ✅ Extrait par `parse_judge_response()` |
| Prompt refine | Template v1.1 (cf. [Addendum §D.3](addendum-v1.1.md#d3-self-refine-prompt-final-pass)) : envoyer le meilleur candidat + suggestion au LLM chat | ✅ Template SELF_REFINE + `build_refine_prompt()` |
| Comparaison avant/après | Log du score avant et après refine | 🔴 Amélioration mesurée |
| Toggle | Activable/désactivable par profil | ✅ Config respectée via `run_pipeline(do_self_refine=…)` |
| Fallback | Si refine échoue, garder le candidat original | ✅ Fallback implémenté |

### 5.3 Prompt juge avancé (S17–S18) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Critères de notation | Persona (fidélité), Mémoire (utilisation), Continuité, Style, Immersion | 5 scores distincts |
| Pondération critères | Configurable par profil | Config respectée |
| Historique scores | Stocker les scores de chaque génération | Données pour analyse |
| Détection méta | Le juge pénalise les phrases "en tant qu'IA", "je suis un modèle", etc. | Score immersion bas si méta détecté |

### 5.4 Batterie de benchmarks (S18–S20) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Test drift persona | Conversation 30–50 tours, vérifier maintien du personnage | Score persona stable |
| Test rappel faits | Injecter un fait au tour 1, vérifier rappel au tour 40 | Fait rappelé correctement |
| Test continuité | Lieux, objets, promesses cohérents sur la durée | Score continuité > seuil |
| Test style | Longueur, registre, tics respectés | Score style > seuil |
| Test immersion | Aucune mention méta dans les réponses | 0 occurrence méta |
| Scoring automatique | Le juge (Qwen3-4B) score chaque test automatiquement | Rapport JSON généré |
| Rapport | Export JSON + affichage dans UI | Rapport lisible |

### 5.5 Character assistant IA (S17–S18) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Prompt assistant | Template qui génère tous les champs d'un personnage | Résultat complet |
| Inputs → Outputs | Nom, thème, relation, style, limites → summary, persona, writing_style, scenario, first_message, example_dialogues, memory_seed | Tous les champs remplis |
| Parsing JSON | Extraction JSON depuis la réponse LLM | Parsing robuste |
| Qualité | Example dialogues crédibles, memory_seed cohérent | Revue manuelle OK |
| 5–10 examples | Génération de 5–10 paires de dialogues | Nombre respecté |
| 5–15 memory_seed | Génération de souvenirs initiaux | Nombre respecté |

---

## 6. Spécifications techniques

### 6.1 Structure de fichiers

```
backend/app/
├── prompting/
│   ├── __init__.py
│   ├── templates.py        # Tous les templates de prompts
│   │   ├── SYSTEM_RP       # Prompt système RP strict
│   │   ├── MEMORY_FORMAT   # Format injection mémoire
│   │   ├── EXTRACT_MEMORY  # Prompt extraction mémoire JSON
│   │   ├── JUDGE           # Prompt juge JSON
│   │   ├── SELF_REFINE     # Prompt réécriture
│   │   └── CHAR_ASSISTANT  # Prompt assistance création
│   └── assembler.py        # Construction du prompt final
│       ├── build_chat_prompt()
│       ├── build_extract_prompt()
│       ├── build_judge_prompt()
│       └── build_refine_prompt()
├── memory_pipeline/
│   ├── __init__.py
│   ├── retriever.py        # Recherche + scoring + sélection
│   │   ├── build_query()
│   │   ├── search_memories()
│   │   ├── score_memories()
│   │   └── select_top_n()
│   ├── extractor.py        # Extraction mémoire depuis conversation
│   │   ├── extract_memories()
│   │   └── parse_extraction_json()
│   ├── consolidator.py     # Dédoublonnage + fusion + update
│   │   ├── deduplicate()
│   │   ├── merge_memories()
│   │   └── update_references()
│   ├── indexer.py           # Gestion embeddings + index vectoriel
│   │   ├── embed_text()
│   │   ├── index_memory()
│   │   └── remove_from_index()
│   └── scoring.py          # Formule de priorité
│       ├── compute_priority()
│       ├── recency_factor()
│       └── referenced_factor()
├── chat_orchestrator/
│   ├── __init__.py
│   ├── orchestrator.py     # Logique principale
│   │   ├── generate_single()
│   │   ├── generate_best_of_n()
│   │   └── self_refine()
│   └── judge.py            # Appel LLM juge + parsing
│       ├── evaluate_candidates()
│       └── parse_judge_response()
└── tools/
    ├── __init__.py
    └── character_assistant.py
        ├── generate_character()
        └── parse_assistant_response()
```

### 6.2 Formule de scoring

```python
def compute_priority(memory, query_embedding, config):
    similarity = cosine_similarity(memory.embedding, query_embedding)
    age_days = (now() - memory.created_at).days
    recency = math.exp(-age_days / config.tau)
    ref_days = (now() - memory.last_referenced_at).days if memory.last_referenced_at else age_days
    referenced = math.exp(-ref_days / config.tau_ref)

    importance_adj = memory.importance * memory.confidence

    priority = (
        config.w_sim * similarity
        + config.w_imp * importance_adj
        + config.w_rec * recency
        + config.w_ref * referenced
        - config.w_del * (1 if memory.is_deleted else 0)
    )

    if memory.is_pinned:
        priority += config.pin_bonus

    return priority
```

### 6.3 Paramètres par défaut (à calibrer)

```yaml
scoring:
  w_sim: 0.35
  w_imp: 0.25
  w_rec: 0.20
  w_ref: 0.15
  w_del: 10.0
  tau: 30          # jours
  tau_ref: 14      # jours
  pin_bonus: 5.0

retrieval:
  top_k: 30        # recherche vectorielle
  top_n: 10        # souvenirs injectés
  history_window: 15

extraction:
  min_confidence: 0.6
  dedup_threshold: 0.90

generation:
  temperature: 0.7
  top_p: 0.9
  max_tokens: 1024
  best_of_n: 3
  self_refine: true
```

### 6.4 Prompt extraction mémoire (v1.1 finalisé)

> **⚠️ Le template v1.1 finalisé (en anglais, avec `{{placeholders}}`) se trouve dans [Addendum §D.1](addendum-v1.1.md#d1-memory-extraction-prompt-json-strict).**
> Le template ci-dessous est la version v1.0 (français) conservée comme référence historique.

```text
Tu es un moteur d'extraction de mémoire à long terme.
À partir de la conversation ci-dessous, extrait UNIQUEMENT les informations
qui méritent d'être mémorisées pour les futures interactions.

Règles :
- Sois concis et factuel. Pas de paraphrase inutile.
- N'extrais que ce qui est nouveau ou significatif.
- Attribue une importance (0-1) selon l'impact narratif à long terme.
- Attribue une confiance (0-1) selon la fiabilité de l'information.
- Si tu détectes une contradiction avec des souvenirs existants, signale-la.

SOUVENIRS EXISTANTS (pour détecter contradictions) :
{existing_memories}

CONVERSATION RÉCENTE :
{recent_messages}

Retourne UNIQUEMENT du JSON valide, sans texte avant ni après :
{
  "semantic": [
    { "title": "...", "content": "...", "entities": [...], "tags": [...], "importance": 0.0, "confidence": 0.0 }
  ],
  "episodic": [
    { "title": "...", "content": "...", "entities": [...], "tags": [...], "importance": 0.0, "confidence": 0.0 }
  ],
  "world_updates": [
    { "field": "...", "value": "...", "confidence": 0.0 }
  ],
  "contradictions": [
    { "existing_memory_id": "...", "content": "...", "severity": 0.0 }
  ]
}
```

### 6.5 Prompt juge (v1.1 finalisé)

> **⚠️ Le template v1.1 finalisé (en anglais, avec `{{placeholders}}` et subscores) se trouve dans [Addendum §D.2](addendum-v1.1.md#d2-judge-prompt-rank-candidates--optional-rewrite-suggestion).**
> Le template ci-dessous est la version v1.0 (français) conservée comme référence historique.

```text
Tu es un juge de qualité pour un dialogue roleplay immersif.

PERSONNAGE :
{character_summary}

SOUVENIRS PERTINENTS :
{relevant_memories}

CONTEXTE RÉCENT :
{recent_context}

MESSAGE UTILISATEUR :
{user_message}

CANDIDATS À ÉVALUER :
{candidates}

Note chaque candidat de 0 à 10 sur les critères suivants :
1) Persona : fidélité au personnage (traits, valeurs, défauts)
2) Mémoire : utilisation correcte des souvenirs fournis
3) Continuité : cohérence avec le contexte et l'historique
4) Style : respect du style d'écriture défini
5) Immersion : absence totale de méta (pas de "en tant qu'IA", pas de mention de règles)

Retourne UNIQUEMENT du JSON valide :
{
  "ranking": [
    {
      "id": "A",
      "scores": { "persona": 0.0, "memory": 0.0, "continuity": 0.0, "style": 0.0, "immersion": 0.0 },
      "total": 0.0,
      "reasons": ["..."]
    }
  ],
  "best_id": "A",
  "rewrite_suggestion": "..."
}
```

---

## 7. Critères de qualité

- **Extraction mémoire :** taux de parsing JSON > 95%
- **Rappel mémoire :** un fait injecté au tour 1 doit être récupérable au tour 40+
- **Dédoublonnage :** 0 doublon exact en DB après 100 tours de conversation
- **Scoring :** les souvenirs les plus pertinents arrivent en top-3
- **Best-of-N :** amélioration mesurable du score juge vs single-shot
- **Self-refine :** amélioration mesurable du score après réécriture
- **Latence pipeline :** extraction + consolidation + indexation < 5s
