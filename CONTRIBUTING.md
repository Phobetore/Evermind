# Contributing to Evermind

Evermind is maintained by one person, so expect replies to take days rather than
hours. Nothing is being ignored on purpose.

## Before you write code

For anything larger than a bug fix, open an issue first and say what you want to
do, especially for the prompt engine or the memory pipeline, where the reasons
behind the design are not always visible from the code. Small and obvious fixes
need no ceremony: open the pull request.

## Getting set up

[docs/DEVELOPING.md](docs/DEVELOPING.md) has the layout, how to run Evermind, a
mock model for working without a real one, and how a turn is assembled before it
reaches the model: read that part before changing anything that ends up in a
prompt.

## What has to pass

The checks listed under [Tests](docs/DEVELOPING.md#tests), end-to-end suite
included. CI runs them on every pull request, and also builds and starts the
Docker image without publishing it and refuses a dependency with a known
high-severity vulnerability. Separately, CodeQL reads the source weekly and Trivy
scans the published image.

New behaviour in the backend comes with tests. The prompt engine
(`backend/app/prompting/`, all but the embedding model in `embeddings.py`) has no
I/O precisely so that it can be tested exhaustively; some of its tests are
[recorded cases](docs/DEVELOPING.md#recorded-cases) that a change regenerates. In
the frontend, logic that needs no browser gets a unit test (`npm test`), and
anything that only shows up on a screen, such as a layout on a phone, gets an
end-to-end one.

If a change alters what gets sent to a model, say so in the pull request. Those
are the changes that break stories quietly, weeks later, in ways no test catches.

## Commits and pull requests

Commit messages in English, present tense, explaining *why* when the diff does
not already say it. One logical change per pull request: one that fixes a bug and
reformats four other files is a pull request nobody can review. Pull requests are
squashed on merge, so the title becomes the commit subject: make it a sentence
that will still mean something in a year.

## Adding cards to the library

Cards in `library/` are Character Card V2 JSON, in English: the library is shared
by every language the interface speaks, and cards are not translated. They should
be original writing, not a copy of a character owned by someone else, and work
with a mid-sized local model rather than only with a frontier one.

## Translations

The interface speaks English, French, German and Spanish;
[Translations](docs/DEVELOPING.md#translations) says where the dictionaries are,
how counts, numbers and French spacing are written, and what `npm test` checks.
Translate meaning rather than words: where a string only makes sense as an
English idiom, write the sentence a native speaker would actually use. A new
language is welcome as a new locale file, an entry in the language picker, and a
genuine pass over all of it, not a machine translation dropped in wholesale.

## What this project will not accept

Some contributions are declined however well they are written, because they
contradict what Evermind is for:

- **Content filtering, moderation layers or refusal behaviour.** What a character
  will and will not say is decided by the person running Evermind and the model
  they chose. The application does not get a vote.
- **Telemetry, analytics, crash reporting or anything else that reports on the
  people using it.** What people write here is nobody's business, including
  mine. The update check, on by default, only asks GitHub for the newest release
  number, with nothing anyone wrote, and a checkbox in Settings turns it off.
- **Hosted accounts, licence keys, or a paid tier.** Evermind runs on your
  machine and stays that way.
- **Bundling a specific model or provider as a requirement.** Every provider is
  interchangeable by design.

Everything else is fair game, including large changes. The roadmap in the README
is a list of intentions, not a fence.

## Licence

Evermind is AGPL-3.0-or-later. Contributions are accepted under that same
licence, and there is no contributor licence agreement to sign.
