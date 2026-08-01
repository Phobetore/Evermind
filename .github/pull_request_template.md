## What this changes

<!-- And why. The diff shows the what; the why is the part that gets lost. -->

Closes #

## Does it change what reaches the model

<!-- Prompt assembly, memory selection, retrieval, defaults, provider payloads.
     Answer no and delete the rest of this section if it does not. If it does,
     say what a turn looks like before and after: these are the changes that
     break stories quietly, weeks later. -->

## How you checked it

<!-- Which models you tried it against, if that is relevant. "It builds" is not
     a check for anything touching a prompt. -->

- [ ] `ruff check app tests` and `pytest -q` pass in `backend/`
- [ ] `npx tsc --noEmit` and `npm run build` pass in `frontend/`
- [ ] New backend behaviour has tests
- [ ] Interface strings added to all four locale files, not just English
