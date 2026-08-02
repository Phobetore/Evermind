# Contributing to Evermind

Thanks for being here. This document covers how to get a change accepted, and
what the project will and will not take.

Evermind is maintained by one person, so expect replies to take days rather than
hours. Nothing is being ignored on purpose.

## Before you write code

For anything larger than a bug fix, open an issue first and describe what you
want to do. It costs you five minutes and can save you a weekend, especially for
changes that touch the prompt engine or the memory pipeline, where the reasons
behind the current design are not always visible from the code.

Small and obvious fixes need no ceremony. Open the pull request.

## Getting set up

[docs/DEVELOPING.md](docs/DEVELOPING.md) has the layout, how to run both halves,
the API surface, and how a turn is actually assembled before it reaches the
model. Read the section on the prompt engine before changing anything that ends
up in a prompt.

You do not need a real model to work on Evermind. `python scripts/mock_llm.py`
serves placeholder roleplay text on `http://localhost:5599/v1`, which is enough
for everything except judging the quality of a reply.

## What has to pass

The same checks CI runs, and it is faster to run them yourself:

```bash
cd backend && ruff check app tests && pytest -q
cd frontend && npx tsc --noEmit && npm run check:i18n && npm run build
```

CI also builds both Docker images on every pull request, without publishing
them, so a broken `COPY` fails there rather than at release time.

New behaviour in the backend comes with tests. The prompt engine
(`backend/app/prompting/engine.py`) is a pure function with no I/O precisely so
that it can be tested exhaustively, so there is no excuse there. The frontend has
no unit tests; the typecheck and the build are what stands in for them.

If a change alters what gets sent to a model, say so explicitly in the pull
request. Those are the changes that break stories quietly, weeks later, in ways
no test catches.

## Commits and pull requests

Commit messages in English, present tense, explaining *why* when the diff does
not already say it. One logical change per pull request. A pull request that
fixes a bug and reformats four other files is a pull request nobody can review.

Pull requests are squashed on merge, so the title becomes the commit subject.
Make it a sentence that will still mean something in a year.

## Adding cards to the library

Cards in `library/` are Character Card V2 JSON. Anything you add should be
original writing, not a copy of a character owned by someone else, and it should
work with a mid-sized local model rather than only with a frontier one.

Write them in English: the library is shared by every language the interface
speaks, and the cards themselves are not translated.

## Translations

The interface speaks English, French, German and Spanish, from JSON dictionaries
in `frontend/src/i18n/locales/`. Every key must exist in all four files, which
`npm run check:i18n` verifies.

Translate meaning rather than words. If a string only makes sense as an English
idiom, write the sentence a native speaker would actually use, even when that
means departing from the original.

New languages are welcome. Adding one means a new locale file, an entry in the
language picker, and a genuine pass over all of it rather than a machine
translation dropped in wholesale.

## What this project will not accept

Some contributions are declined regardless of how well they are written, because
they contradict what Evermind is for:

- **Content filtering, moderation layers or refusal behaviour.** What a character
  will and will not say is decided by the person running Evermind and the model
  they chose. The application does not get a vote.
- **Telemetry, analytics, crash reporting or any other call home.** What people
  write here is nobody's business, including mine.
- **Hosted accounts, licence keys, or a paid tier.** Evermind runs on your
  machine and stays that way.
- **Bundling a specific model or provider as a requirement.** Every provider is
  interchangeable by design.

Everything else is fair game, including large changes. The roadmap in the README
is a list of intentions, not a fence.

## Licence

Evermind is AGPL-3.0-or-later. Contributions are accepted under that same
licence, and there is no contributor licence agreement to sign.
