"""Writes openrouter_471.json: a list of models in the shape OpenRouter's "List all models" gives,
as large as its own list was on 14 November 2026, made up model by model from a fixed seed.

None of it is copied from a real answer. What the tests and the browser's mock server count on is
fixed here: 471 models, 87 of them ":batch" copies, 19 that write text and an image (two of them
priced "0"/"0"), ":free" models at "0", one priced "-1", every shape of "reasoning" object, dates
within the last 30 days of 14 November 2026 and older ones, and five models named on purpose.

Run from backend/: python tests/fixtures/catalog/make_openrouter_471.py
"""

import json
import random
from pathlib import Path

SEED = 471
# The day the real list was looked at: "within 30 days" is counted from it.
REFERENCE = 1794614400  # 2026-11-14T00:00:00Z
DAY = 86400

BATCH = 87
TEXT_AND_IMAGE = 19
FREE = 24
TOTAL = 471

# Made-up makers, so that no line passes for a real model; Mistral is the one real name a test needs.
VENDORS = ["Brume", "Cendre", "Givre", "Houle", "Lierre", "Marne", "Nacre", "Ombre", "Pollen",
           "Quartz", "Rivage", "Sable", "Tilleul", "Vesper", "Zephyr", "Ardoise", "Bruyere",
           "Corail", "Dune", "Ecume"]
WORDS = ["Mini", "Lite", "Pro", "Chat", "Flash", "Instruct", "Turbo", "Nano", "Prime", "Core",
         "Swift", "Max", "Plus", "Air", "Deep", "Vision", "Coder", "Story", "Muse", "Echo"]
SIZES = ["3B", "7B", "8B", "12B", "14B", "22B", "32B", "70B", "120B", "405B"]
CONTEXTS = [8192, 16384, 32768, 65536, 131072, 200000, 262144, 1000000]
OUTPUTS = [None, 4096, 8192, 16384, 32768, 65536]
PRICES = ["0.0000001", "0.00000015", "0.0000002", "0.0000003", "0.0000005", "0.0000008",
          "0.000001", "0.0000015", "0.000002", "0.000003", "0.000005", "0.00001", "0.000015"]

# Each shape the list gives, with what Evermind reads from it (catalog.py).
REASONING = [
    None,                                                             # absent: told by its parameters
    {"mandatory": False, "default_enabled": True,
     "supported_efforts": ["high", "medium", "low", "none"], "default_effort": "medium"},
    {"mandatory": True, "supported_efforts": ["high", "medium", "low"]},
    {"mandatory": False, "default_enabled": False},
    {"mandatory": False},                                             # nothing says what it does
    {"mandatory": False, "supported_efforts": None},
]

NAMED = [
    ("mistralai/mistral-large-2411", "Mistral: Mistral Large"),
    ("eclair/eclair-mini", "Eclair: Eclair Mini"),
    ("obsidienne/obsidienne", "Obsidienne: Obsidienne"),
    ("aurore/aurore-large", "Aurore: Aurore Large"),
    ("sillage/sillage-7b", "Sillage: Sillage 7B"),
]


def model(rng: random.Random, model_id: str, name: str, outputs: list[str],
          prompt: str, completion: str) -> dict:
    reasoning = rng.choice(REASONING)
    parameters = ["max_tokens", "temperature", "top_p", "stop"]
    if reasoning is not None or rng.random() < 0.3:
        parameters += ["reasoning", "include_reasoning"]
    pricing = {"prompt": prompt, "completion": completion}
    if rng.random() < 0.4 and prompt not in ("0", "-1"):
        pricing["input_cache_read"] = f"{float(prompt) / 10:.10f}".rstrip("0")
    days = rng.randrange(1, 30) if rng.random() < 0.15 else rng.randrange(31, 900)
    entry = {
        "id": model_id,
        "name": name,
        "created": REFERENCE - days * DAY,
        "context_length": rng.choice(CONTEXTS),
        "architecture": {"input_modalities": ["text"], "output_modalities": outputs},
        "pricing": pricing,
        "top_provider": {"max_completion_tokens": rng.choice(OUTPUTS)},
        "supported_parameters": parameters,
    }
    if reasoning is not None:
        entry["reasoning"] = reasoning
    return entry


def paid(rng: random.Random) -> tuple[str, str]:
    low = rng.randrange(len(PRICES) - 2)
    return PRICES[low], PRICES[min(low + rng.randrange(1, 3), len(PRICES) - 1)]


def build() -> dict:
    rng = random.Random(SEED)
    taken: set[str] = set()
    models: list[dict] = []

    def unique(vendor: str) -> tuple[str, str]:
        while True:
            word, size = rng.choice(WORDS), rng.choice(SIZES)
            model_id = f"{vendor.lower()}/{vendor.lower()}-{word.lower()}-{size.lower()}"
            if model_id not in taken:
                taken.add(model_id)
                return model_id, f"{vendor}: {vendor} {word} {size}"

    for model_id, name in NAMED:
        taken.add(model_id)
        models.append(model(rng, model_id, name, ["text"], *paid(rng)))
    # The service picks the model behind it: its price depends on which.
    taken.add("routeur/auto")
    models.append(model(rng, "routeur/auto", "Routeur: Auto", ["text"], "-1", "-1"))
    for n in range(TEXT_AND_IMAGE):
        model_id, name = unique(rng.choice(VENDORS))
        price = ("0", "0") if n < 2 else paid(rng)
        models.append(model(rng, model_id + "-image", name + " Image", ["text", "image"], *price))
    for _ in range(FREE):
        model_id, name = unique(rng.choice(VENDORS))
        models.append(model(rng, model_id + ":free", name + " (free)", ["text"], "0", "0"))
    while len(models) < TOTAL - BATCH:
        model_id, name = unique(rng.choice(VENDORS))
        models.append(model(rng, model_id, name, ["text"], *paid(rng)))

    # The same model at a deferred price: it never answers inside a conversation.
    priced = [m for m in models if m["pricing"]["prompt"] not in ("0", "-1")]
    for original in rng.sample(priced, BATCH):
        copy = json.loads(json.dumps(original))
        copy["id"] += ":batch"
        copy["name"] += " (batch)"
        models.append(copy)

    rng.shuffle(models)
    assert len(models) == TOTAL and len({m["id"] for m in models}) == TOTAL
    return {"data": models, "links": {"next": None}}


if __name__ == "__main__":
    out = Path(__file__).with_name("openrouter_471.json")
    out.write_text(json.dumps(build(), indent=1) + "\n", encoding="utf-8")
