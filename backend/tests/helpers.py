"""Adding an AI through the API, as the page does, for the tests that need one."""

# What a connection created with nothing set was given: what it read at once, no ceiling sent,
# and the four settings left to the model.
AS_A_CONNECTION_WAS = {
    "context_own": 16384, "reply_cap": {"mode": "unsent"}, "temperature": None, "top_p": None,
    "frequency_penalty": None, "presence_penalty": None,
}


def cap(tokens: int | None) -> dict:
    """The ceiling a connection's max tokens were: a number is fixed, none is not sent."""
    return {"reply_cap": {"mode": "fixed", "tokens": tokens} if tokens else {"mode": "unsent"}}


async def add_model(client, *, base_url: str, model: str = "mock",
                    provider: str = "openai-compatible", api_key: str | None = None,
                    family: str | None = None, read: dict | None = None,
                    as_added: bool = False, **fields) -> dict:
    """A service and its AI made by POST /api/models, then given what a connection made with
    nothing set had, so that a test sends the request it sent before AIs; ``fields`` win.
    ``as_added``: the AI as the page adds it, untouched."""
    service = {"provider": provider, "base_url": base_url, "api_key": api_key}
    if family:
        service["family"] = family
    item = {"model": model}
    if read is not None:
        item["read"] = read
    resp = await client.post("/api/models", json={"service": service, "models": [item]})
    assert resp.status_code == 201, resp.text
    made = resp.json()["models"][0]
    if as_added and not fields:
        return made
    changes = fields if as_added else {**AS_A_CONNECTION_WAS, **fields}
    resp = await client.put(f"/api/models/{made['id']}", json=changes)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def first_ai(client) -> dict:
    """The AI that answers when a conversation names none."""
    return (await client.get("/api/models")).json()[0]


async def set_ai(client, **fields) -> dict:
    """Changes the first AI as a connection's form changed it: ``provider`` and ``base_url`` are
    its service's, ``context_size`` and ``max_tokens`` what it reads and its ceiling."""
    ai = await first_ai(client)
    service = {key: fields.pop(key) for key in ("provider", "base_url") if key in fields}
    if service:
        resp = await client.put(f"/api/connections/{ai['service']['id']}", json=service)
        assert resp.status_code == 200, resp.text
    if "context_size" in fields:
        fields["context_own"] = fields.pop("context_size")
    if "max_tokens" in fields:
        fields.update(cap(fields.pop("max_tokens")))
    resp = await client.put(f"/api/models/{ai['id']}", json=fields)
    assert resp.status_code == 200, resp.text
    return resp.json()
