# Roadmap Équipe Frontend — Evermind

> **Stack :** Next.js (ou SvelteKit) · TypeScript · SSE streaming
> **Port :** `localhost:3000`
> **Responsable :** Équipe Frontend
>
> 📎 Voir aussi : **[Addendum v1.1](addendum-v1.1.md)** — diagramme SSE séquence (§A), format event `done` avec `message_id` + `meta` (§B)

---

## 1. Responsabilités

- Interface utilisateur complète (chat, éditeur personnages, settings)
- Streaming temps réel des tokens (SSE)
- Gestion des branches de conversation, régénération, variantes
- Sidebar personnages + conversations
- Intégration avec l'API Backend (FastAPI)
- Responsive, accessible, performant

---

## 2. Dépendances

| Dépend de | Livrable attendu | Phase |
|-----------|-------------------|-------|
| Backend / API | Contrat OpenAPI (spec endpoints) | MVP |
| Backend / API | Endpoint SSE `/chat/stream` opérationnel | MVP |
| Backend / API | CRUD personnages + conversations | MVP |
| AI & Mémoire | Endpoint memory inspector | v1.0 |

---

## 3. Phase MVP (v0.1) — Semaines 1–8

### 3.1 Setup projet (S1–S2) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| Initialiser le projet Next.js + TypeScript | `npx create-next-app@latest` avec App Router | ✅ Build et dev server fonctionnels |
| Structure dossiers | `app/`, `components/`, `lib/`, `hooks/`, `types/` | ✅ Structure créée et documentée |
| Linting + formatting | ESLint + Prettier configurés | ✅ `npm run lint` passe sans erreur |
| CI basique | Build + lint en CI | ✅ Pipeline verte |
| Types partagés | Définir les interfaces TypeScript (Character, Conversation, Message, etc.) | ✅ Fichier `types/` complet |

### 3.2 Écran Liste Personnages (S2–S3) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| Page `/characters` | Liste des personnages avec nom, tags, résumé | ✅ Affiche la liste depuis l'API |
| Card personnage | Composant card avec avatar placeholder, nom, tags | ✅ Rendu correct |
| Actions CRUD | Boutons Créer / Éditer / Supprimer | ✅ Appels API fonctionnels |
| Recherche/filtre | Barre de recherche par nom + filtre par tags | ✅ Filtrage côté client |
| État vide | Message d'accueil quand aucun personnage | ✅ Affiché correctement |

### 3.3 Éditeur Personnage (S3–S4) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| Page `/characters/[id]/edit` | Formulaire complet | ✅ Tous les champs du schéma Character |
| Champs | `name`, `summary`, `persona`, `writing_style`, `scenario`, `first_message`, `boundaries`, `system_rules` | ✅ Validation côté client |
| Tags | Input tags avec auto-complétion | ✅ Ajout/suppression de tags (comma-separated) |
| Example dialogues | Éditeur de paires user/assistant (ajout/suppression dynamique) | ✅ Liste dynamique fonctionnelle |
| Sauvegarde | PUT/POST vers l'API avec feedback | ✅ Erreur affichée en cas d'échec |
| Création | Page `/characters/new` avec formulaire vierge | ✅ Redirige vers `/characters` après création |

### 3.4 Écran Chat (S4–S7) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| Page `/chat/[conversationId]` | Interface de chat | ✅ Affichage des messages |
| Liste conversations | Sidebar avec conversations groupées par personnage | ✅ Navigation entre conversations |
| Nouvelle conversation | Bouton + sélection personnage → first_message auto | ✅ Conversation créée, first_message affiché |
| Envoi message | Input + bouton envoyer | ✅ Message user envoyé via API |
| **Streaming SSE** | Connexion `EventSource` vers `/chat/stream` | ✅ Tokens affichés progressivement |
| Event `done` | Parser l'event `done` avec `message_id` + résumé `meta` (cf. [Addendum §A.1](addendum-v1.1.md#a1-tour-complet-sse-streaming-côté-ui)) | ✅ Message ID reçu, meta accessible |
| Indicateur de génération | Spinner / animation pendant la génération | ✅ Visible pendant le streaming |
| Scroll auto | Auto-scroll vers le bas pendant le streaming | ✅ Scroll fluide |
| Formatage messages | Markdown basique (gras, italique, paragraphes) | ✅ Rendu Markdown correct |
| Régénération | Bouton "Regenerate" sur le dernier message assistant | ✅ Nouveau message assistant généré |
| Responsive | Fonctionne sur desktop (min 1024px) | ✅ Layout correct |

### 3.5 Navigation & Layout (S2–S3) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| Layout principal | Sidebar + zone principale | ✅ Navigation fluide |
| Sidebar | Personnages + conversations | ✅ Collapse/expand |
| Thème sombre | Dark mode par défaut | ✅ Cohérent sur tous les écrans |
| Loading states | Skeletons + spinners | ✅ UX fluide |

---

## 4. Phase v0.2 — Semaines 9–14

### 4.1 Variantes & Branches (S9–S11) 🔴

| Tâche | Détail | CA |
|-------|--------|-----|
| Variantes (alternates) | Sur un message assistant, voir N variantes (swipe) | Navigation entre variantes |
| Branches de conversation | Fork à partir d'un message | Arborescence de messages navigable |
| UI branches | Indicateur visuel de branchement | Clair pour l'utilisateur |
| Suppression branche | Supprimer une branche entière | Confirmation + suppression |

### 4.2 Settings (S11–S12) ✅

| Tâche | Détail | CA |
|-------|--------|-----|
| Page `/settings` | Configuration profil modèle | ✅ Sélection du profil (balanced, max_quality, fast, test) |
| Paramètres génération | Sliders : temperature, top_p, max_tokens | ✅ Valeurs envoyées au backend via localStorage |
| best-of-N | Slider N (1–7) | ✅ Valeur mise à jour |
| self-refine | Toggle on/off | ✅ Valeur mise à jour |
| Contexte max | Affichage contexte actuel | ✅ Informatif |

### 4.3 Bouton "Assistance IA" (S12–S13) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Bouton dans l'éditeur personnage | "Générer avec l'IA" | Ouvre un modal/panel |
| Formulaire inputs | Nom, thème, relation, style, limites | Champs remplis par l'utilisateur |
| Appel API | `POST /tools/character_assistant` | Réponse JSON parsée |
| Remplissage auto | Les champs de l'éditeur se remplissent avec les suggestions | Pré-remplissage correct |
| Édition manuelle | L'utilisateur peut modifier les suggestions avant de sauvegarder | Champs éditables |

### 4.4 Améliorations Chat (S13–S14) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Retry (renvoi) | Renvoyer le dernier message user | ✅ Nouvelle génération (Regenerate button) |
| Édition message user | Modifier un message user passé | 🔴 Message mis à jour + régénération |
| Copier message | Bouton copier dans le presse-papier | ✅ Feedback visuel |
| Horodatage | Affichage date/heure des messages | ✅ Tooltip ou inline |

---

## 5. Phase v1.0 — Semaines 15–20

### 5.1 Memory Inspector (S15–S17) 🟡

| Tâche | Détail | CA |
|-------|--------|-----|
| Page `/characters/[id]/memories` | Vue des souvenirs du personnage | Liste paginée |
| Filtres | Par type (semantic/episodic/world), par tags | Filtrage fonctionnel |
| Détail souvenir | Modal avec content, importance, confidence, dates | Informations complètes |
| Actions | Pin / Forget (soft delete) | Appels API fonctionnels |
| World State | Affichage JSON du world_state | Visualisation lisible |
| Édition World State | Formulaire d'édition du world_state | PUT API fonctionnel |

### 5.2 Import / Export Personnages (S17–S18) 🔴

| Tâche | Détail | CA |
|-------|--------|-----|
| Export | Bouton "Exporter" → téléchargement JSON | Fichier JSON conforme au schéma v1 |
| Import | Bouton "Importer" → upload fichier JSON | Personnage créé avec toutes les données |
| Validation import | Vérification du schéma JSON côté client | Erreur claire si format invalide |
| Preview import | Aperçu du personnage avant confirmation | Modal de preview |

### 5.3 Benchmarks UI (S18–S19) 🟢

| Tâche | Détail | CA |
|-------|--------|-----|
| Page `/benchmarks` | Affichage des résultats de benchmarks | Liste de runs |
| Détail run | Scores par catégorie (persona, mémoire, continuité, style, immersion) | Graphiques ou tableau |
| Lancer un bench | Bouton pour déclencher un benchmark | Appel API + feedback |
| Export rapport | Export JSON du rapport | Téléchargement |

### 5.4 Polish & UX (S19–S20) 🟢

| Tâche | Détail | CA |
|-------|--------|-----|
| Animations | Transitions fluides entre pages/modals | Animations CSS/Framer |
| Accessibilité | Aria labels, keyboard nav, focus management | Audit basique |
| Erreurs | Pages d'erreur (404, 500) + gestion erreurs API | Messages utilisateur clairs |
| Page status | Page status système (serveurs LLM, DB) | Affiche l'état de santé |
| Onboarding | Premier lancement : guide de démarrage | Modal ou stepper |

---

## 6. Spécifications techniques

### 6.1 Structure de fichiers

```
frontend/
├── app/
│   ├── layout.tsx
│   ├── page.tsx                    # Redirect → /characters
│   ├── characters/
│   │   ├── page.tsx                # Liste personnages
│   │   ├── new/page.tsx            # Création
│   │   └── [id]/
│   │       ├── page.tsx            # Détail
│   │       ├── edit/page.tsx       # Édition
│   │       └── memories/page.tsx   # Inspector (v1.0)
│   ├── chat/
│   │   └── [conversationId]/page.tsx
│   ├── settings/page.tsx
│   └── benchmarks/page.tsx         # v1.0
├── components/
│   ├── ui/                         # Composants UI réutilisables
│   ├── chat/                       # ChatMessage, ChatInput, StreamingText
│   ├── characters/                 # CharacterCard, CharacterForm
│   ├── memory/                     # MemoryList, MemoryDetail
│   └── layout/                     # Sidebar, Header
├── hooks/
│   ├── useChat.ts                  # Logique chat + SSE
│   ├── useCharacters.ts            # CRUD personnages
│   ├── useConversations.ts         # CRUD conversations
│   └── useMemories.ts              # Lecture mémoire
├── lib/
│   ├── api.ts                      # Client HTTP (fetch wrapper)
│   ├── sse.ts                      # Client SSE
│   └── utils.ts
├── types/
│   ├── character.ts
│   ├── conversation.ts
│   ├── message.ts
│   ├── memory.ts
│   └── config.ts
├── package.json
├── tsconfig.json
├── next.config.js
└── tailwind.config.js
```

### 6.2 Interfaces TypeScript clés

```typescript
// types/character.ts
interface Character {
  id: string;
  name: string;
  tags: string[];
  summary: string;
  persona: string;
  writing_style: string;
  scenario: string;
  first_message: string;
  example_dialogues: { user: string; assistant: string }[];
  boundaries: string;
  system_rules: string;
  memory_seed: MemorySeed[];
  created_at: string;
  updated_at: string;
}

// types/message.ts
interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
  meta: MessageMeta;  // v1.1: typed meta (see Addendum §B)
}

// types/meta.ts (v1.1)
// See full schema in Addendum §B.2
interface AssistantMeta {
  schema_version: string;
  request_id: string;
  profile_id: string;
  pipeline: {
    best_of_n: number;
    self_refine: boolean;
    judge_enabled: boolean;
    memory_extract_enabled: boolean;
    memory_write_enabled: boolean;
  };
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  latency_ms: {
    dur_total: number;
    dur_generate: number;
    dur_judge: number;
    dur_self_refine: number;
    dur_memory_extract: number;
    dur_memory_write: number;
  };
  errors: string[];
}

type MessageMeta = AssistantMeta | Record<string, unknown>;

// types/memory.ts
interface MemoryItem {
  id: string;
  character_id: string;
  type: 'semantic' | 'episodic' | 'world';
  title: string;
  content: string;
  entities: string[];
  tags: string[];
  importance: number;
  confidence: number;
  created_at: string;
  last_referenced_at: string | null;
  source_turn_id: string | null;
  is_deleted: boolean;
}
```

### 6.3 Streaming SSE

```typescript
// hooks/useChat.ts — logique de streaming
function streamChat(params: ChatStreamParams): EventSource {
  const eventSource = new EventSource('/chat/stream', {
    // POST via fetch + ReadableStream
  });
  // Alternative : fetch + ReadableStream pour POST avec body
  const response = await fetch('http://127.0.0.1:8000/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const reader = response.body.getReader();
  // Lire les chunks SSE progressivement
}
```

### 6.4 Proxy API

Configurer le proxy dans `next.config.js` pour éviter les problèmes CORS :

```javascript
// next.config.js
module.exports = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://127.0.0.1:8000/:path*',
      },
    ];
  },
};
```

---

## 7. Critères de qualité

- **Performance :** First Contentful Paint < 1s (local)
- **Streaming :** premier token visible < 200ms après début du stream
- **Responsive :** min 1024px (desktop-first)
- **Tests :** composants critiques testés (chat, formulaires)
- **Build :** 0 erreurs TypeScript, 0 warnings ESLint
