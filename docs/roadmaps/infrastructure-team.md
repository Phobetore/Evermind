# Roadmap Équipe Infrastructure / DevOps — Evermind

> **Périmètre :** LLM runtime, scripts de déploiement, configuration, logs, monitoring
> **Runtime LLM :** llama.cpp (backend Vulkan)
> **GPU cible :** AMD Radeon 16 Go VRAM
> **Responsable :** Équipe Infrastructure

---

## 1. Responsabilités

- Compilation et déploiement de **llama.cpp** avec support Vulkan
- Gestion des **modèles Heretic** (téléchargement, placement, vérification)
- Scripts **start/stop** (Windows + Linux)
- Fichier de **configuration** unique (`config.yaml`)
- **Logs** structurés par serveur
- **Monitoring** de santé des serveurs LLM
- Gestion **VRAM** et fallbacks
- Packaging et distribution

---

## 2. Dépendances

| Dépend de | Livrable attendu | Phase |
|-----------|-------------------|-------|
| — | Modèles Heretic GGUF disponibles (téléchargement externe) | MVP |
| Backend | Spécification des ports et rôles (chat/mem/juge) | MVP |
| AI & Mémoire | Choix du modèle embeddings | v0.2 |

---

## 3. Phase MVP (v0.1) — Semaines 1–8

### 3.1 Setup llama.cpp + Vulkan (S1–S3) 🔴

| Tâche | Détail | CA |
|-------|--------|-----|
| Compilation llama.cpp | Compiler avec `-DGGML_VULKAN=ON` pour Windows (MSVC/MinGW) | Binaire fonctionnel |
| Test Vulkan | Vérifier que le GPU AMD est détecté et utilisé | `vulkaninfo` + logs llama.cpp |
| Binaire serveur | `llama-server` compilé et testé | `/health` répond |
| Test API OpenAI-like | `POST /v1/chat/completions` avec un modèle de test | Réponse correcte |
| Streaming test | Vérifier le streaming SSE depuis llama-server | Tokens streamés |
| Documentation | Guide de compilation étape par étape | Document clair |
| Build Linux (optionnel) | Compiler pour Linux avec Vulkan | Binaire Linux fonctionnel |

### 3.2 Gestion des modèles (S2–S4) 🔴

| Tâche | Détail | CA |
|-------|--------|-----|
| Arborescence `models/` | `models/chat/`, `models/memory/`, `models/judge/`, `models/embeddings/` | Dossiers créés |
| Script de téléchargement | Script pour télécharger les modèles Heretic (HuggingFace) | Modèles téléchargés correctement |
| Vérification au démarrage | Vérifier la présence des fichiers GGUF | Message d'erreur clair si absent |
| Documentation modèles | Liste des modèles supportés + tailles + liens | Document à jour |

**Modèles Heretic ciblés :**

| Rôle | Modèle par défaut | Taille | GGUF attendu |
|------|-------------------|--------|---------------|
| Chat (défaut) | `p-e-w/gemma-3-12b-it-heretic` | 12B | ~7–8 Go (Q4_K_M) |
| Chat (qualité max) | `p-e-w/gpt-oss-20b-heretic` | 21B | ~12–13 Go (Q4_K_M) |
| Chat (rapide) | `p-e-w/Llama-3.1-8B-Instruct-heretic` | 8B | ~5 Go (Q4_K_M) |
| Chat (test) | `p-e-w/phi-4-heretic` | 15B | ~9 Go (Q4_K_M) |
| Mémoire/Juge | `p-e-w/Qwen3-4B-Instruct-2507-heretic` | 4B | ~2.5 Go (Q4_K_M) |
| Embeddings | E5-small / BGE-small (CPU) | ~100 Mo | Modèle sentence-transformers |

### 3.3 Configuration (`config.yaml`) (S2–S3) 🔴

| Tâche | Détail | CA |
|-------|--------|-----|
| Schéma config | Définir le schéma YAML complet (cf. spec §17.2) | Schéma documenté |
| Fichier par défaut | `config.yaml` avec profil "balanced" pré-rempli | Config par défaut fonctionnelle |
| Validation | Vérification au démarrage (fichiers existent, ports libres) | Erreurs claires |
| Variables d'environnement | Override possible via env vars | Documenté |

```yaml
# config.yaml — structure complète
bind_host: "127.0.0.1"
frontend_port: 3000
backend_port: 8000

llm_servers:
  chat:
    port: 8081
    model_path: "models/chat/gemma-3-12b-it-heretic.gguf"
    ctx: 8192
    n_gpu_layers: -1        # -1 = tout sur GPU
    backend: "vulkan"
    quant: "q4_k_m"
    threads: 4
  memory:
    port: 8082
    model_path: "models/memory/qwen3-4b-heretic.gguf"
    ctx: 4096
    n_gpu_layers: -1
    backend: "vulkan"
    quant: "q4_k_m"
    threads: 4
  judge:
    port: 8083
    model_path: "models/judge/qwen3-4b-heretic.gguf"
    ctx: 4096
    n_gpu_layers: -1
    backend: "vulkan"
    quant: "q4_k_m"
    threads: 4

embeddings:
  model_name: "intfloat/e5-small-v2"
  device: "cpu"
  dimension: 384

profiles:
  balanced:
    chat_server: "chat"
    memory_server: "memory"
    judge_server: "judge"
    best_of_n: 3
    self_refine: true
  max_quality:
    chat_server: "chat"
    memory_server: "memory"
    judge_server: "judge"
    best_of_n: 5
    self_refine: true
  fast:
    chat_server: "chat"
    memory_server: "memory"
    judge_server: "judge"
    best_of_n: 1
    self_refine: false
  test:
    chat_server: "chat"
    memory_server: "memory"
    judge_server: "judge"
    best_of_n: 1
    self_refine: false

logging:
  level: "INFO"
  dir: "logs/"
```

### 3.4 Script `start` — MVP (S3–S5) 🔴

| Tâche | Détail | CA |
|-------|--------|-----|
| `scripts/start.ps1` (Windows) | Lance 1 serveur LLM chat + backend + frontend | Tout démarre en une commande |
| `scripts/start.sh` (Linux) | Équivalent Linux | Tout démarre |
| Séquence de démarrage | 1) LLM server(s) → 2) Backend → 3) Frontend | Ordre respecté |
| Health check au démarrage | Attendre que chaque serveur soit `healthy` avant de continuer | Pas de démarrage partiel silencieux |
| Affichage URL | Afficher `http://127.0.0.1:3000` une fois tout prêt | Message clair dans le terminal |
| `scripts/stop.ps1` / `stop.sh` | Arrête proprement tous les processus | Tous les processus tués |
| PID file | Stocker les PIDs pour le stop propre | Fichier `data/.pids` |

#### Script start.ps1 (esquisse)

```powershell
# scripts/start.ps1
$ErrorActionPreference = "Stop"

Write-Host "=== Evermind — Démarrage ===" -ForegroundColor Cyan

# 1) Vérifications
if (-Not (Test-Path "config.yaml")) { Write-Error "config.yaml introuvable"; exit 1 }
if (-Not (Test-Path "models/chat/")) { Write-Error "Modèle chat introuvable"; exit 1 }

# 2) Lancer le serveur LLM chat
Write-Host "[1/3] Démarrage serveur LLM chat..." -ForegroundColor Yellow
$llm = Start-Process -FilePath "./bin/llama-server" `
    -ArgumentList "--model models/chat/gemma-3-12b-it-heretic.gguf --port 8081 --ctx-size 8192 --n-gpu-layers -1" `
    -PassThru -NoNewWindow -RedirectStandardOutput "logs/llm-chat.log" -RedirectStandardError "logs/llm-chat-err.log"

# Attendre health
Start-Sleep -Seconds 5
# ... health check loop ...

# 3) Lancer le backend
Write-Host "[2/3] Démarrage backend..." -ForegroundColor Yellow
$backend = Start-Process -FilePath "python" `
    -ArgumentList "-m uvicorn app.main:app --host 127.0.0.1 --port 8000" `
    -WorkingDirectory "backend" -PassThru -NoNewWindow

# 4) Lancer le frontend
Write-Host "[3/3] Démarrage frontend..." -ForegroundColor Yellow
$frontend = Start-Process -FilePath "npm" `
    -ArgumentList "run start" `
    -WorkingDirectory "frontend" -PassThru -NoNewWindow

# 5) Sauvegarder PIDs
"$($llm.Id)`n$($backend.Id)`n$($frontend.Id)" | Out-File "data/.pids"

Write-Host ""
Write-Host "=== Evermind prêt ! ===" -ForegroundColor Green
Write-Host "Ouvrez : http://127.0.0.1:3000" -ForegroundColor Cyan
```

### 3.5 Logs (S4–S5) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Répertoire `logs/` | Créé automatiquement au démarrage | Dossier existant |
| Log LLM servers | Un fichier par serveur (`llm-chat.log`, etc.) | Rotation optionnelle |
| Log backend | stdout/stderr redirigé | Logs accessibles |
| Log frontend | stdout/stderr redirigé | Logs accessibles |
| Format | Timestamp + niveau + message | Lisible |

---

## 4. Phase v0.2 — Semaines 9–14

### 4.1 Multi-serveurs LLM (S9–S11) 🔴

| Tâche | Détail | CA |
|-------|--------|-----|
| 3 instances llama-server | Chat (8081), Mémoire (8082), Juge (8083) | 3 processus distincts |
| VRAM partagée | Tester la cohabitation sur 16 Go | Pas d'OOM |
| Configuration VRAM | Ajuster `n_gpu_layers` si nécessaire (offload partiel) | Stable sous 16 Go |
| Fallback | Si VRAM insuffisante, réduire ctx ou offload CPU | Dégradation gracieuse |
| Scripts start/stop | Mis à jour pour 3 serveurs | Tous lancés/stoppés |
| Health check | Ping des 3 serveurs au démarrage | Statut affiché |

#### Estimation VRAM (3 serveurs simultanés)

```
Chat (Gemma-3 12B Q4_K_M)    : ~7.5 Go + KV cache (8k ctx) ~1 Go  = ~8.5 Go
Mémoire (Qwen3 4B Q4_K_M)    : ~2.5 Go + KV cache (4k ctx) ~0.3 Go = ~2.8 Go
Juge (Qwen3 4B Q4_K_M)       : ~2.5 Go + KV cache (4k ctx) ~0.3 Go = ~2.8 Go
────────────────────────────────────────────────────────────────────────────────
Total estimé                  : ~14.1 Go (dans les 16 Go)
```

> **Note :** Si VRAM insuffisante, options :
> 1. Partager un seul serveur Qwen3-4B pour mémoire ET juge (économie ~2.5 Go)
> 2. Réduire ctx du modèle chat (4k au lieu de 8k)
> 3. Offload partiel CPU pour les modèles secondaires

### 4.2 Modèle embeddings (S9–S10) 🔴

| Tâche | Détail | CA |
|-------|--------|-----|
| Installation | sentence-transformers ou lib équivalente | Import fonctionne |
| Modèle CPU | E5-small-v2 ou BGE-small (CPU, ~100 Mo) | Modèle chargé |
| Test embeddings | Générer un embedding depuis du texte | Vecteur de la bonne dimension |
| Intégration config | Section `embeddings` dans config.yaml | Config parsée |
| Alternative GPU | Option pour utiliser llama.cpp `/v1/embeddings` si VRAM disponible | Configurable |

### 4.3 Gestion VRAM intelligente (S11–S13) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Monitoring VRAM | Script/outil pour checker la VRAM libre | Valeur VRAM affichée |
| Presets par modèle | Ctx max recommandé par taille de modèle | Presets documentés |
| Auto-réduction ctx | Si OOM détecté, retry avec ctx réduit | Retry automatique |
| Mode économie | Option pour partager mémoire/juge sur un seul serveur | Config supportée |
| Documentation VRAM | Guide des combinaisons possibles par VRAM | Document à jour |

#### Presets de contexte recommandés

| Modèle | Taille | Ctx recommandé | Ctx max (16 Go solo) |
|--------|--------|---------------|---------------------|
| Qwen3-4B | 4B | 4096 | 8192 |
| Llama-3.1-8B | 8B | 8192 | 16384 |
| Gemma-3-12B | 12B | 8192 | 8192 |
| Phi-4 | 15B | 4096 | 8192 |
| GPT-OSS-20B | 21B | 4096 | 4096 |

### 4.4 Profils multi-modèles (S12–S14) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Switch de modèle | Changer le modèle chat sans redémarrer tout | Redémarrage du serveur chat seul |
| Profils pré-configurés | A (balanced), B (max_quality), C (fast), D (test) | Configs prêtes |
| Validation profil | Vérifier que les modèles requis sont présents | Erreur claire si absent |
| UI status | Endpoint `/models/status` fiable | JSON avec pid/port/model/alive |

---

## 5. Phase v1.0 — Semaines 15–20

### 5.1 Packaging (S15–S17) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Bundle Windows | Archive zip avec binaires + scripts + config | Décompression + `./start` suffit |
| Python embarqué | Option : Python portable (ou demander l'installation) | Documenté |
| Node.js embarqué | Option : Next.js build statique exporté | Build statique si possible |
| Vérification dépendances | Script qui vérifie Python, Node.js, Vulkan drivers | Messages clairs |
| Guide installation | README pas à pas pour Windows | Testé sur machine vierge |

### 5.2 Robustesse (S17–S19) 🔴

| Tâche | Détail | CA |
|-------|--------|-----|
| Watchdog | Redémarrage automatique si un serveur LLM crash | Relance en < 10s |
| Graceful shutdown | SIGTERM → arrêt propre de tous les processus | Pas de processus orphelin |
| Port collision | Détection de ports déjà utilisés au démarrage | Message d'erreur + suggestion |
| Timeout démarrage | Si un serveur ne répond pas en 60s, erreur | Timeout configurable |
| Page status erreur | Si un serveur est down, UI affiche une page status avec liens logs | Page accessible |

### 5.3 Optimisations (S18–S20) 🟢

| Tâche | Détail | CA |
|-------|--------|-----|
| Batch inference | Si llama.cpp supporte le batching, activer | Latence réduite |
| Mmap / mlock | Options mémoire pour accélérer le chargement | Temps de démarrage réduit |
| Quantizations alternatives | Tester Q5_K_M, Q6_K, IQ pour rapport qualité/taille | Benchmarks documentés |
| Cache KV persistant | Conserver le KV cache entre requêtes (si supporté) | Latence réduite sur conversations |
| Profiling | Identifier les bottlenecks (CPU vs GPU vs I/O) | Rapport de profiling |

### 5.4 Documentation complète (S19–S20) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Guide installation Windows | Pas à pas complet | Testé sur machine vierge |
| Guide installation Linux | Pas à pas complet | Testé sur Ubuntu/Fedora |
| Guide modèles | Comment télécharger et placer les modèles | Clair et à jour |
| Guide configuration | Toutes les options de config.yaml | Documenté |
| Troubleshooting | FAQ des problèmes courants (VRAM, Vulkan, ports) | Problèmes couverts |
| Architecture | Diagramme et explication des composants | Clair pour un nouveau dev |

---

## 6. Arborescence finale

```
project/
├── bin/
│   ├── llama-server             # Binaire llama.cpp (Vulkan)
│   └── llama-server.exe         # Version Windows
├── models/
│   ├── chat/
│   │   └── gemma-3-12b-it-heretic.gguf
│   ├── memory/
│   │   └── qwen3-4b-heretic.gguf
│   ├── judge/
│   │   └── qwen3-4b-heretic.gguf
│   └── embeddings/
│       └── (sentence-transformers cache)
├── scripts/
│   ├── start.ps1               # Windows
│   ├── start.sh                # Linux
│   ├── stop.ps1                # Windows
│   ├── stop.sh                 # Linux
│   └── download-models.ps1     # Téléchargement des modèles
├── backend/
│   └── (...)
├── frontend/
│   └── (...)
├── data/
│   ├── app.db                  # SQLite
│   └── .pids                   # PIDs des processus
├── logs/
│   ├── llm-chat.log
│   ├── llm-memory.log
│   ├── llm-judge.log
│   ├── backend.log
│   └── frontend.log
├── config.yaml
└── README.md
```

---

## 7. Critères de qualité

- **Démarrage :** `./start` → tout fonctionnel en < 60s (hors premier chargement modèle)
- **Stabilité :** 0 crash en 24h de fonctionnement continu
- **VRAM :** pas d'OOM avec la configuration par défaut (balanced)
- **Logs :** tout problème diagnosticable via les logs
- **Portabilité :** fonctionne sur Windows 10/11 avec AMD Radeon (drivers récents)
- **Simplicité :** un utilisateur non-technique peut suivre le guide d'installation
